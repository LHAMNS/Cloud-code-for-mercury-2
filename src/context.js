// Mercury Code - Context Compaction
// Combines best practices from Codex CLI and Claude Code:
//   - Codex: bytes/4 estimation, handoff summary, recent user message preservation
//   - Claude Code: configurable autocompact, memory persistence, compaction counters,
//     manual /compact support, progressive degradation warnings
//
// How it works:
//   1. When context reaches threshold, ask Mercury-2 to generate a handoff summary
//   2. Replace old messages with: [recent user messages] + [summary]
//   3. The FULL uncompressed conversation is always in .mercury/conversation.jsonl
//      — the model can Read this file at any time to recover exact details
//   4. Key facts extracted during compaction are saved to .mercury/memory.md
//
// This means compression is simple and lossy, but nothing is truly lost
// because the complete log is always one Read() away.

import { MODEL_LIMITS } from "./config.js";

// ── Mercury-2 limits ──────────────────────────────────────────────────────
// 128K context. Like Codex CLI, use 95% of the raw context as effective window.
const EFFECTIVE_CONTEXT_PERCENT = 0.95;
const EFFECTIVE_INPUT = Math.floor(MODEL_LIMITS.max_context_tokens * EFFECTIVE_CONTEXT_PERCENT);

// Compact when context hits 90% of effective input (Codex CLI default)
// Can be overridden via MERCURY_AUTOCOMPACT_PCT env var (Claude Code style)
const COMPACT_THRESHOLD = (() => {
  const override = process.env.MERCURY_AUTOCOMPACT_PCT;
  if (override) {
    const pct = parseInt(override, 10);
    if (pct > 0 && pct <= 100) return pct / 100;
  }
  return 0.90;
})();
// Super mode compacts earlier at 50%
const SUPER_COMPACT_THRESHOLD = 0.50;

// How many recent turns to keep verbatim (turn = user msg + AI responses)
const KEEP_TURNS = 4;
const KEEP_TURNS_SUPER = 2;

// Budget for preserving user messages in compacted history (same as Codex: 20K)
const USER_MSG_BUDGET = 20000;

// Maximum compaction count before warning the user about accuracy degradation
const MAX_COMPACT_BEFORE_WARN = 5;

// ── Token estimation (Codex-style: bytes / 4) ────────────────────────────
// Codex CLI uses ceil(byte_length / 4) for all client-side token estimation.
// This is a deliberate choice: simple, fast, no tokenizer dependency.
// Authoritative counts come from the API response's usage field.

const APPROX_BYTES_PER_TOKEN = 4;

/**
 * Estimate token count for a text string.
 * Uses byte length / 4 (ceiling division), matching Codex CLI's approach.
 * For non-ASCII text (CJK, etc.), byte length naturally accounts for
 * multi-byte characters, which tend to use more tokens per character.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Use Buffer.byteLength for accurate byte count (handles UTF-8 multi-byte chars)
  const byteLen = typeof Buffer !== "undefined"
    ? Buffer.byteLength(text, "utf-8")
    : new TextEncoder().encode(text).length;
  return Math.ceil(byteLen / APPROX_BYTES_PER_TOKEN);
}

/**
 * Estimate total tokens for a message array.
 * JSON-serializes each message and divides by 4 (Codex approach).
 * Adds per-message overhead for role/formatting tokens.
 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    // Per-message overhead: role + formatting markers (~4 tokens)
    total += 4;
    if (msg.content) total += estimateTokens(msg.content);
    if (msg.tool_calls) {
      // Serialize tool calls to get accurate byte count
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
    if (msg.tool_call_id) total += 3;
  }
  return total;
}

// ── Compaction state tracker (Claude Code style) ──────────────────────────
// Tracks how many times compaction has occurred in this session.
// Used for progressive degradation warnings.

let _compactionCount = 0;
let _lastApiUsage = null; // Last API-reported token usage for calibration

/**
 * Update with API-reported usage for more accurate threshold checking.
 * Call this after each API response with the usage field.
 * @param {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} usage
 */
export function updateApiUsage(usage) {
  if (usage && typeof usage.prompt_tokens === "number") {
    _lastApiUsage = usage;
  }
}

/**
 * Get current context usage statistics for UI display.
 * @param {Array} messages - Current message array
 * @param {string} systemPrompt - System prompt text
 * @returns {{ estimated: number, effective: number, pct: number, compactionCount: number, apiReported: number|null }}
 */
export function getContextStats(messages, systemPrompt) {
  const sysTk = estimateTokens(systemPrompt) + 4;
  const estimated = sysTk + estimateMessagesTokens(messages);
  return {
    estimated,
    effective: EFFECTIVE_INPUT,
    pct: estimated / EFFECTIVE_INPUT,
    compactionCount: _compactionCount,
    apiReported: _lastApiUsage?.prompt_tokens || null,
  };
}

/**
 * Reset compaction counter (e.g. on /clear).
 */
export function resetCompactionState() {
  _compactionCount = 0;
  _lastApiUsage = null;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function compressContext(messages, systemPrompt, client, memory, onInfo) {
  return await _compact(messages, systemPrompt, client, memory, onInfo, COMPACT_THRESHOLD, KEEP_TURNS);
}

export async function superCompressContext(messages, systemPrompt, client, memory, onInfo) {
  return await _compact(messages, systemPrompt, client, memory, onInfo, SUPER_COMPACT_THRESHOLD, KEEP_TURNS_SUPER);
}

/**
 * Force-compact regardless of threshold (Claude Code /compact command).
 * Used when user explicitly requests compaction via /compact.
 */
export async function forceCompact(messages, systemPrompt, client, memory, onInfo) {
  return await _compact(messages, systemPrompt, client, memory, onInfo, 0, KEEP_TURNS);
}

// ── Core compaction (Codex-style + Claude Code enhancements) ─────────────

async function _compact(messages, systemPrompt, client, memory, onInfo, threshold, keepTurns) {
  const sysTk = estimateTokens(systemPrompt) + 4;

  // Prefer API-reported usage when available for more accurate threshold check
  let estimatedTotal = sysTk + estimateMessagesTokens(messages);
  if (_lastApiUsage?.prompt_tokens && threshold > 0) {
    // Blend: use API count if available and recent (within same turn)
    estimatedTotal = _lastApiUsage.prompt_tokens;
  }
  const usage = estimatedTotal / EFFECTIVE_INPUT;

  if (usage < threshold) return false;

  // Find cutoff: everything before the last N turns gets compressed
  const cutoff = _findTurnCutoff(messages, keepTurns);
  if (cutoff <= 1) return false;

  const oldMessages = messages.slice(0, cutoff);
  const oldTokens = estimateMessagesTokens(oldMessages);

  onInfo(
    `Context ${(usage * 100).toFixed(0)}% — compressing ${oldMessages.length} old messages (~${oldTokens} tokens)...`
  );

  // Build recap for model to summarize
  const recap = _buildRecap(oldMessages);

  let summary = null;
  let memoryEntry = null;

  // Read existing memory to provide to compaction model (avoid duplicating facts)
  let existingMemory = "";
  if (memory) {
    try { existingMemory = await memory.read(); } catch { /* non-critical */ }
  }

  // Ask Mercury-2 to generate handoff summary with retry logic
  if (client) {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const compactSystemPrompt = existingMemory
          ? `${COMPACT_PROMPT}\n\nExisting memory (do NOT repeat these facts):\n${_trunc(existingMemory, 1000)}`
          : COMPACT_PROMPT;

        const response = await client.chatCompletion(
          [
            { role: "system", content: compactSystemPrompt },
            { role: "user", content: recap },
          ],
          { max_tokens: 2500, temperature: 0.3, reasoning_effort: "low" }
        );

        const raw = response.choices?.[0]?.message?.content;
        if (raw) {
          const parts = _parseSections(raw);
          summary = parts.summary;
          memoryEntry = parts.memory;
        }
        break; // Success — exit retry loop
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
          onInfo(`Compression API failed (${err.message}), retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          onInfo(`Compression API failed after ${MAX_RETRIES + 1} attempts, using fallback summary`);
        }
      }
    }
  }

  if (!summary) {
    summary = _buildFallbackSummary(oldMessages);
  }

  // Save key facts to memory file
  if (memory && memoryEntry) {
    try { await memory.append(memoryEntry); } catch { /* non-critical */ }
  }

  // ── Build compacted history (Codex approach) ──
  // 1. Collect recent real user messages (up to 20K tokens)
  const recentUserMsgs = _collectRecentUserMessages(oldMessages, USER_MSG_BUDGET);

  // 2. Build replacement: [user messages] + [summary with Codex-style prefix]
  const replacement = [];
  for (const text of recentUserMsgs) {
    replacement.push({ role: "user", content: text });
  }
  replacement.push({
    role: "user",
    content: `${SUMMARY_PREFIX}\n\n${summary}`,
  });

  // 3. Replace old messages
  const preTokens = sysTk + estimateMessagesTokens(messages);
  messages.splice(0, cutoff, ...replacement);
  const postTokens = sysTk + estimateMessagesTokens(messages);

  const newUsage = postTokens / EFFECTIVE_INPUT;

  // Increment compaction counter
  _compactionCount++;

  // Log compact boundary marker (Claude Code style: tracks compaction history in memory)
  if (memory) {
    try {
      const boundaryNote = `[compact #${_compactionCount}] ${preTokens}→${postTokens} tokens, ${oldMessages.length} msgs removed, ${messages.length} kept`;
      await memory.append(boundaryNote);
    } catch { /* non-critical */ }
  }

  // Progressive degradation warning (Claude Code pattern)
  if (_compactionCount >= MAX_COMPACT_BEFORE_WARN) {
    onInfo(
      `Warning: ${_compactionCount} compactions in this session. ` +
      `Long conversations with many compactions may reduce accuracy. ` +
      `Consider starting a new session for complex tasks.`
    );
  }

  onInfo(
    `Compressed: ${oldMessages.length} messages → ${replacement.length}. ` +
    `${(usage * 100).toFixed(0)}% → ${(newUsage * 100).toFixed(0)}%. ` +
    `Full log: .mercury/conversation.jsonl`
  );

  // Clear cached API usage after compaction (token counts changed)
  _lastApiUsage = null;

  // If still over threshold after compaction, try again with fewer turns
  if (newUsage >= threshold && keepTurns > 1) {
    onInfo("Still over threshold after compaction, compressing further...");
    return await _compact(messages, systemPrompt, client, memory, onInfo, threshold, Math.max(1, keepTurns - 2));
  }

  return true;
}

// ── Summary prefix (from Codex CLI's summary_prefix.md) ───────────────────

const SUMMARY_PREFIX =
  "Another instance of this AI started working on this task and produced " +
  "the following handoff summary. The tools' file state reflects what was " +
  "actually done. Use this summary to continue seamlessly without " +
  "duplicating work. If you need exact details (specific code changes, " +
  "full error messages, command outputs), use Read to check " +
  ".mercury/conversation.jsonl which contains the complete uncompressed log:";

// ── Compaction prompt (from Codex CLI's prompt.md, enhanced) ──────────────

const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What files were read, created, or modified (exact absolute paths)
- What specific changes were made (concrete, not vague)
- What remains to be done (clear next steps)
- Any errors or blockers encountered
- Any critical data, examples, or references needed to continue

Produce TWO sections:

## SUMMARY
The handoff summary (max 400 words). Be concise, structured, and focused on helping the next LLM seamlessly continue.

## MEMORY
Key facts for long-term reference (max 150 words): file paths, architecture decisions, config values, user preferences. Only include NEW facts not already in existing memory.`;

// ── Recap builder ─────────────────────────────────────────────────────────

function _buildRecap(messages) {
  const parts = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        if (msg.content?.startsWith(SUMMARY_PREFIX)) {
          parts.push(`PRIOR SUMMARY: ${_trunc(msg.content, 800)}`);
        } else {
          parts.push(`USER: ${_trunc(msg.content, 400)}`);
        }
        break;
      case "assistant":
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let argSummary;
            try {
              const a = JSON.parse(tc.function.arguments);
              argSummary = _toolArgSummary(tc.function.name, a);
            } catch {
              argSummary = _trunc(tc.function.arguments, 100);
            }
            parts.push(`TOOL: ${tc.function.name}(${argSummary})`);
          }
        }
        if (msg.content) parts.push(`ASSISTANT: ${_trunc(msg.content, 400)}`);
        break;
      case "tool": {
        const c = msg.content || "";
        // Strip content fence markers before summarizing
        const cleaned = c
          .replace(/\[TOOL_OUTPUT_BEGIN[^\]]*\]\n?/g, "")
          .replace(/\n?\[TOOL_OUTPUT_END\]/g, "")
          .trim();
        if (cleaned.length > 300) {
          const lines = cleaned.split("\n");
          const hasErr = /error|fail|exception|denied/i.test(cleaned);
          if (hasErr) {
            const errLines = lines.filter(l => /error|fail|exception|denied/i.test(l)).slice(0, 3);
            parts.push(`RESULT (error): ${errLines.join("; ") || _trunc(cleaned, 200)}`);
          } else {
            parts.push(`RESULT (${lines.length} lines): ${_trunc(lines.slice(0, 2).join("\n"), 150)}…`);
          }
        } else {
          parts.push(`RESULT: ${cleaned}`);
        }
        break;
      }
    }
  }
  return parts.join("\n");
}

function _toolArgSummary(name, a) {
  switch (name) {
    case "Read": return a.file_path || "?";
    case "Write": return `${a.file_path || "?"}, ${a.content?.length || 0} chars`;
    case "Edit": return `${a.file_path || "?"}, replace ${(a.old_string||"").length}→${(a.new_string||"").length}`;
    case "Patch": return `${a.file_path || "?"}, ${a.edits?.length || 0} edits`;
    case "Bash": return _trunc(a.command, 120);
    case "Glob": return a.pattern || "?";
    case "Grep": return `/${a.pattern || "?"}/ in ${a.path || "."}`;
    case "ListDir": return a.path || ".";
    case "Diff": return a.git_ref ? `ref:${a.git_ref}` : `${a.file_a||""} vs ${a.file_b||""}`;
    case "Fetch": return a.url || "?";
    case "SubAgent": return _trunc(a.task, 100);
    case "ContextSearch": return `query: ${_trunc(a.query, 80)}${a.scope ? ` (${a.scope})` : ""}`;
    default: return _trunc(JSON.stringify(a), 100);
  }
}

// ── Response parser ───────────────────────────────────────────────────────

function _parseSections(raw) {
  let summary = raw;
  let memory = null;

  const memRx = /(?:^|\n)\s*#{1,3}\s*MEMORY\s*/i;
  const sumRx = /(?:^|\n)\s*#{1,3}\s*SUMMARY\s*/i;

  const memMatch = memRx.exec(raw);
  const sumMatch = sumRx.exec(raw);

  if (memMatch) {
    const memStart = memMatch.index + memMatch[0].length;
    if (sumMatch && sumMatch.index < memMatch.index) {
      summary = raw.slice(sumMatch.index + sumMatch[0].length, memMatch.index).trim();
    } else {
      summary = raw.slice(0, memMatch.index).trim();
    }
    memory = raw.slice(memStart).trim();
  } else if (sumMatch) {
    summary = raw.slice(sumMatch.index + sumMatch[0].length).trim();
  }

  return { summary, memory };
}

// ── Fallback summary (when model API unavailable) ─────────────────────────

function _buildFallbackSummary(messages) {
  const filesRead = new Set();
  const filesWritten = new Set();
  const commands = [];
  const userReqs = [];
  const errors = [];

  for (const msg of messages) {
    if (msg.role === "user" && msg.content && !msg.content.startsWith(SUMMARY_PREFIX)) {
      userReqs.push(_trunc(msg.content, 120));
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let a = {};
        try { a = JSON.parse(tc.function.arguments); } catch {}
        switch (tc.function.name) {
          case "Read": case "ListDir":
            if (a.file_path || a.path) filesRead.add(a.file_path || a.path); break;
          case "Write": case "Edit": case "Patch":
            if (a.file_path) filesWritten.add(a.file_path); break;
          case "Bash":
            if (a.command) commands.push(_trunc(a.command, 80)); break;
          case "Diff":
            if (a.file_a) filesRead.add(a.file_a);
            if (a.file_b) filesRead.add(a.file_b); break;
          case "Fetch":
            if (a.url) commands.push(`fetch ${_trunc(a.url, 60)}`); break;
          case "Glob": case "Grep":
            if (a.pattern) commands.push(`${tc.function.name}(${_trunc(a.pattern, 40)})`); break;
        }
      }
    }
    // Track errors from tool results
    if (msg.role === "tool" && msg.content) {
      const content = msg.content;
      if (/^Error:/i.test(content) || /error|fail|exception/i.test(content.slice(0, 100))) {
        errors.push(_trunc(content, 100));
      }
    }
  }

  const p = [];
  if (userReqs.length > 0) p.push(`Tasks: ${userReqs.slice(-3).join(" → ")}`);
  if (filesWritten.size > 0) p.push(`Modified: ${[...filesWritten].join(", ")}`);
  if (filesRead.size > 0) p.push(`Read: ${[...filesRead].join(", ")}`);
  if (commands.length > 0) p.push(`Commands: ${commands.slice(-5).join("; ")}`);
  if (errors.length > 0) p.push(`Errors: ${errors.slice(-3).join("; ")}`);
  return p.join("\n") || "No specific actions recorded.";
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _collectRecentUserMessages(messages, budget) {
  const selected = [];
  let remaining = budget;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || msg.content?.startsWith(SUMMARY_PREFIX)) continue;
    const tk = estimateTokens(msg.content);
    if (tk > remaining) break;
    selected.push(msg.content);
    remaining -= tk;
  }
  selected.reverse();
  return selected;
}

function _findTurnCutoff(messages, keepTurns) {
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      turns++;
      if (turns >= keepTurns) return i;
    }
  }
  return 0;
}

function _trunc(text, max) {
  if (!text) return "(empty)";
  if (typeof text !== "string") text = String(text);
  return text.length <= max ? text : text.slice(0, max) + "…";
}
