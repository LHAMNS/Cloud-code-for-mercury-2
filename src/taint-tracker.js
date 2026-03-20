// Mercury Code - Taint Tracker (Phase 3: Taint Propagation)
//
// Tracks the trust provenance of every piece of content that enters the
// conversation context. When high-risk tool calls are about to execute,
// the tracker checks whether the tool arguments contain or reference
// content from untrusted sources.
//
// Taint tags (ordered by trust, highest first):
//   trusted              — system prompt, direct user messages
//   workspace_untrusted  — MERCURY.md, .mercury/rules/, memory.md
//   tool_untrusted       — tool outputs (Read, Bash, Grep, Glob, etc.)
//   web_untrusted        — Fetch HTTP responses
//   mcp_untrusted        — MCP tool responses
//   derived_untrusted    — model-generated content referencing untrusted sources
//
// How it works:
//   1. When untrusted content enters, register fragments with their taint tag.
//   2. Before high-risk tool execution, scan the tool args for known fragments.
//   3. Return the set of taint tags found — the Action Safety Lead uses these
//      as `source_tags` to make more informed decisions.
//
// Limitations:
//   - This is heuristic substring matching, not true information-flow tracking.
//   - The model can rephrase untrusted content, which evades detection.
//   - We mitigate this by also checking for a recent tainted tool result
//     before clearly high-risk follow-up actions. This stays intentionally
//     narrow so unrelated later commands are not over-tainted.
//
// Performance:
//   - Fragment registration is O(1) per fragment.
//   - Taint checking is O(n*m) where n = fragments, m = args length.
//   - We keep only the most recent N fragments to bound memory.
//   - Only fragments above a minimum length are indexed (short strings match too broadly).

import { createHash } from "node:crypto";
import { debugLog } from "./utils/debug-log.js";

// ── Taint Tags ───────────────────────────────────────────────────────────────

export const TAINT_TRUSTED = "trusted";
export const TAINT_WORKSPACE_UNTRUSTED = "workspace_untrusted";
export const TAINT_TOOL_UNTRUSTED = "tool_untrusted";
export const TAINT_WEB_UNTRUSTED = "web_untrusted";
export const TAINT_MCP_UNTRUSTED = "mcp_untrusted";
export const TAINT_DERIVED_UNTRUSTED = "derived_untrusted";

// Any tag other than trusted is considered untrusted
const UNTRUSTED_TAGS = new Set([
  TAINT_WORKSPACE_UNTRUSTED,
  TAINT_TOOL_UNTRUSTED,
  TAINT_WEB_UNTRUSTED,
  TAINT_MCP_UNTRUSTED,
  TAINT_DERIVED_UNTRUSTED,
]);

// ── Configuration ────────────────────────────────────────────────────────────

const MAX_FRAGMENTS = 500;           // Max tracked fragments (LRU eviction)
const MIN_FRAGMENT_LENGTH = 20;      // Shorter strings are too generic to track
const MAX_FRAGMENT_LENGTH = 500;     // Truncate very long fragments
const FRAGMENT_SAMPLE_STRIDE = 200;  // For long content, sample every N chars
const MAX_FINGERPRINTS_PER_REG = 20; // Max fingerprints per registration
const MAX_TOOL_CALL_TAINTS = 1000;   // Max tracked tool call taints (LRU eviction)

// ── TaintTracker ─────────────────────────────────────────────────────────────

export class TaintTracker {
  constructor() {
    /**
     * Map of content fingerprint → { tag, source, snippet, registeredAt }
     * Fingerprints key the map, but substring matching uses the stored snippet.
     * @type {Map<string, {tag: string, source: string, snippet: string, registeredAt: number}>}
     */
    this._fragments = new Map();

    /**
     * Map of tool_call_id → taint tag.
     * Tracks which tool results carry which taint.
     * @type {Map<string, string>}
     */
    this._toolCallTaints = new Map();

    this._stats = { registered: 0, checks: 0, tainted: 0, clean: 0 };
  }

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register untrusted content entering the conversation.
   *
   * @param {string} content - The untrusted content
   * @param {string} tag - Taint tag (e.g., TAINT_TOOL_UNTRUSTED)
   * @param {object} [metadata] - Optional metadata
   * @param {string} [metadata.source] - Source description (e.g., "Read /project/README.md")
   * @param {string} [metadata.toolCallId] - Associated tool_call_id
   */
  register(content, tag, metadata = {}) {
    if (!content || typeof content !== "string" || content.length < MIN_FRAGMENT_LENGTH) {
      return;
    }
    if (!UNTRUSTED_TAGS.has(tag)) {
      return; // Don't track trusted content
    }

    const source = metadata.source || "unknown";

    // Generate fingerprints from the content
    const fingerprints = this._generateFingerprints(content);
    for (const fp of fingerprints) {
      this._addFragment(fp.key, fp.snippet, tag, source);
    }

    // Track tool_call_id → taint tag (with LRU eviction)
    if (metadata.toolCallId) {
      if (this._toolCallTaints.size >= MAX_TOOL_CALL_TAINTS && !this._toolCallTaints.has(metadata.toolCallId)) {
        const firstKey = this._toolCallTaints.keys().next().value;
        this._toolCallTaints.delete(firstKey);
      }
      this._toolCallTaints.set(metadata.toolCallId, tag);
    }

    this._stats.registered++;
  }

  /**
   * Register a workspace config as tainted.
   */
  registerWorkspaceConfig(content) {
    this.register(content, TAINT_WORKSPACE_UNTRUSTED, { source: "workspace_config" });
  }

  /**
   * Register a tool result as tainted.
   */
  registerToolResult(toolName, toolArgs, result, toolCallId) {
    const tag = this._tagForTool(toolName, toolArgs);
    const source = `${toolName} ${toolArgs?.file_path || toolArgs?.path || toolArgs?.url || toolArgs?.command?.slice(0, 50) || ""}`.trim();
    this.register(result, tag, { source, toolCallId });
  }

  // ── Taint Checking ────────────────────────────────────────────────────

  /**
   * Check whether tool arguments contain content from untrusted sources.
   *
   * @param {string} toolName - Tool being called
   * @param {object} toolArgs - Tool arguments
   * @param {Array} [conversationMessages] - Recent conversation for tool_call_id tracking
   * @returns {TaintCheckResult}
   *
   * @typedef {object} TaintCheckResult
   * @property {boolean} tainted - Whether any untrusted content was detected
   * @property {string[]} tags - Set of taint tags found
   * @property {string[]} sources - Descriptions of tainted sources
   * @property {string} summary - Human-readable summary
   */
  check(toolName, toolArgs, conversationMessages = []) {
    this._stats.checks++;

    const foundTags = new Set();
    const foundSources = new Set();

    // Method 1: Direct substring fingerprint matching
    const argsString = this._stringifyArgs(toolArgs);
    if (argsString.length >= MIN_FRAGMENT_LENGTH) {
      const normalizedArgs = argsString.replace(/\s+/g, " ").trim();
      for (const entry of this._fragments.values()) {
        if (!entry?.snippet) continue;
        // Skip snippets shorter than 4 chars — they match too broadly
        // and cause false positives (e.g., single words, punctuation)
        if (entry.snippet.length < 4) continue;
        // Only check if tool args contain a tainted snippet (forward direction).
        // The reverse check (snippet.includes(args)) caused false positives
        // when short tool args were substrings of large tainted content.
        if (normalizedArgs.includes(entry.snippet)) {
          if (UNTRUSTED_TAGS.has(entry.tag)) {
            foundTags.add(entry.tag);
            foundSources.add(entry.source);
          }
        }
      }
    }

    // Method 2: Only flag derived taint when a recent tainted tool result is
    // followed by an obviously sensitive action. This avoids falsely tainting
    // unrelated commands such as `ls -la`.
    const recentTaintedToolCalls = this._findRecentTaintedToolResults(conversationMessages);
    if (recentTaintedToolCalls.length > 0 && this._isDerivedReuseCandidate(toolName, toolArgs, argsString)) {
      foundTags.add(TAINT_DERIVED_UNTRUSTED);
      for (const tcId of recentTaintedToolCalls) {
        foundSources.add(`derived from tool_call ${tcId}`);
      }
    }

    const tainted = foundTags.size > 0;
    if (tainted) {
      this._stats.tainted++;
    } else {
      this._stats.clean++;
    }

    const tags = [...foundTags];
    const sources = [...foundSources];
    const summary = tainted
      ? `Tainted by: ${tags.join(", ")} (sources: ${sources.join("; ")})`
      : "No taint detected";

    return { tainted, tags, sources, summary };
  }

  /**
   * Get the taint tag for a specific tool_call_id.
   */
  getToolCallTaint(toolCallId) {
    return this._toolCallTaints.get(toolCallId) || null;
  }

  /**
   * Clear all tracked fragments (e.g., on conversation reset).
   */
  clear() {
    this._fragments.clear();
    this._toolCallTaints.clear();
  }

  getStats() {
    return {
      ...this._stats,
      fragments: this._fragments.size,
      toolCalls: this._toolCallTaints.size,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Determine the taint tag for a tool output based on tool name.
   */
  _tagForTool(toolName, toolArgs) {
    const name = (toolName || "").toLowerCase();
    if (name === "fetch") return TAINT_WEB_UNTRUSTED;
    if (name.startsWith("mcp_") || name.startsWith("mcp__")) return TAINT_MCP_UNTRUSTED;
    return TAINT_TOOL_UNTRUSTED;
  }

  /**
   * Generate fingerprints from content for matching.
   * Uses sliding-window hashing to create short content signatures.
   */
  _generateFingerprints(content) {
    const fingerprints = [];
    const text = content.slice(0, MAX_FRAGMENT_LENGTH * MAX_FINGERPRINTS_PER_REG);

    if (text.length < MIN_FRAGMENT_LENGTH) return fingerprints;

    // Strategy: take samples at regular intervals + beginning and end
    const windowSize = Math.min(MAX_FRAGMENT_LENGTH, text.length);
    const stride = Math.max(FRAGMENT_SAMPLE_STRIDE, Math.floor(text.length / MAX_FINGERPRINTS_PER_REG));

    for (let i = 0; i <= text.length - MIN_FRAGMENT_LENGTH && fingerprints.length < MAX_FINGERPRINTS_PER_REG; i += stride) {
      const window = text.slice(i, i + windowSize);
      if (window.length >= MIN_FRAGMENT_LENGTH) {
        // Normalize whitespace before hashing to improve matching across formatting changes
        const normalized = window.replace(/\s+/g, " ").trim();
        if (normalized.length >= MIN_FRAGMENT_LENGTH) {
          fingerprints.push({ key: this._hash(normalized), snippet: normalized });
        }
      }
    }

    return fingerprints;
  }

  _hash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 12);
  }

  _addFragment(fingerprint, snippet, tag, source) {
    // LRU eviction
    if (this._fragments.size >= MAX_FRAGMENTS && !this._fragments.has(fingerprint)) {
      const firstKey = this._fragments.keys().next().value;
      this._fragments.delete(firstKey);
    }
    this._fragments.set(fingerprint, { tag, source, snippet, registeredAt: Date.now() });
  }

  _stringifyArgs(toolArgs) {
    if (!toolArgs) return "";
    try {
      return typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs);
    } catch {
      return String(toolArgs);
    }
  }

  _findRecentTaintedToolResults(messages, limit = 20) {
    if (!Array.isArray(messages)) return [];
    const taintedToolCalls = [];
    for (let i = messages.length - 1, scanned = 0; i >= 0 && scanned < limit; i--, scanned++) {
      const msg = messages[i];
      if (msg?.role !== "tool" || !msg.tool_call_id) continue;
      const taintTag = this._toolCallTaints.get(msg.tool_call_id);
      if (taintTag && UNTRUSTED_TAGS.has(taintTag)) {
        taintedToolCalls.push(msg.tool_call_id);
      }
    }
    return taintedToolCalls;
  }

  _isDerivedReuseCandidate(toolName, toolArgs, argsString) {
    const name = String(toolName || "").toLowerCase();

    if (name === "fetch") {
      const method = String(toolArgs?.method || "GET").toUpperCase();
      const headers = toolArgs?.headers && typeof toolArgs.headers === "object"
        ? Object.keys(toolArgs.headers).map((key) => key.toLowerCase())
        : [];
      return method !== "GET"
        || !!toolArgs?.body
        || headers.some((key) => /(authorization|cookie|x-api-key|api-key|token)/.test(key));
    }

    if (name === "bash") {
      return /\b(curl|wget|nc|ncat|netcat|socat|scp|rsync|ftp|ssh|https?:\/\/|authorization|bearer|token|password|secret|api[_-]?key|x-api-key|cookie|printenv|env\b|tee\b|base64\b|openssl\b)\b/i.test(argsString);
    }

    if (name === "write" || name === "edit" || name === "patch") {
      return /(authorization|bearer|token|password|secret|api[_-]?key|x-api-key|cookie)/i.test(argsString);
    }

    return false;
  }
}
