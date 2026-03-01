// Mercury Code - Smart Context Compression v2
// Inspired by OpenAI Codex CLI's compaction approach + custom optimizations.
//
// Three-phase progressive pipeline:
//   Phase 1 (40%): Tool result pruning — trim large old tool outputs (free, instant)
//   Phase 2 (65%): Model-driven compaction — Mercury-2 generates a handoff summary
//   Phase 3 (85%): Emergency compaction — aggressive, saves to memory first
//
// All intelligent compression decisions are made by Mercury-2 itself.

import { MODEL_LIMITS } from "./config.js";

// ── Mercury-2 optimized limits ────────────────────────────────────────────
// Mercury-2: 128K context, 50K max output. Reserve 30K for output headroom.
const OUTPUT_RESERVE = 30000;
const EFFECTIVE_INPUT = MODEL_LIMITS.max_context_tokens - OUTPUT_RESERVE; // ~98K

// Phase thresholds (fraction of effective input capacity)
const P1_THRESHOLD = 0.40; // ~39K → start pruning tool results
const P2_THRESHOLD = 0.65; // ~64K → model-driven compaction
const P3_THRESHOLD = 0.85; // ~83K → emergency compaction

// Super mode: more aggressive thresholds
const P1_SUPER = 0.25;
const P2_SUPER = 0.40;
const P3_SUPER = 0.55;

// How many recent "turns" stay verbatim (a turn = user msg + all AI responses)
const KEEP_TURNS = 3;
const KEEP_TURNS_SUPER = 1;

// Tool results larger than this are pruning candidates (chars)
const TOOL_TRIM_SIZE = 500;

// Budget for preserving recent user messages in compacted history (tokens)
// Same as Codex CLI: 20,000 tokens
const USER_MSG_TOKEN_BUDGET = 20000;

// ── Token estimation ──────────────────────────────────────────────────────

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 4; // per-message overhead
    if (msg.content) total += estimateTokens(msg.content);
    if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
    if (msg.tool_call_id) total += 3;
  }
  return total;
}

// ── Public API (interface unchanged for callers) ──────────────────────────

export async function compressContext(messages, systemPrompt, client, memory, onInfo) {
  await _pipeline(messages, systemPrompt, client, memory, onInfo, false);
}

export async function superCompressContext(messages, systemPrompt, client, memory, onInfo) {
  await _pipeline(messages, systemPrompt, client, memory, onInfo, true);
}

// ── Pipeline orchestrator ─────────────────────────────────────────────────

async function _pipeline(messages, systemPrompt, client, memory, onInfo, superMode) {
  const sysTk = estimateTokens(systemPrompt) + 4;
  const usage = () => (sysTk + estimateMessagesTokens(messages)) / EFFECTIVE_INPUT;
  const pct = (u) => (u * 100).toFixed(0);

  const [t1, t2, t3] = superMode
    ? [P1_SUPER, P2_SUPER, P3_SUPER]
    : [P1_THRESHOLD, P2_THRESHOLD, P3_THRESHOLD];
  const keepTurns = superMode ? KEEP_TURNS_SUPER : KEEP_TURNS;

  let u = usage();
  if (u < t1) return;

  // ── Phase 1: Prune old tool results (free, instant) ──
  const charsSaved = _pruneToolResults(messages, keepTurns);
  if (charsSaved > 0) {
    const u2 = usage();
    onInfo(`[Phase 1] 裁剪旧工具结果 · ${pct(u)}% → ${pct(u2)}% · 节省 ~${Math.round(charsSaved / 3.5)} tokens`);
    u = u2;
    if (u < t2) return;
  }

  // ── Phase 2: Model-driven compaction ──
  if (u >= t2) {
    const before = estimateMessagesTokens(messages);
    await _modelCompact(messages, client, memory, onInfo, keepTurns, false);
    const after = estimateMessagesTokens(messages);
    u = usage();
    if (before - after > 0) {
      onInfo(`[Phase 2] 模型智能压缩 · → ${pct(u)}% · 节省 ~${before - after} tokens`);
    }
    if (u < t3) return;
  }

  // ── Phase 3: Emergency compaction ──
  if (u >= t3) {
    const before = estimateMessagesTokens(messages);
    await _modelCompact(messages, client, memory, onInfo, 1, true);
    u = usage();
    onInfo(`[Phase 3] 紧急压缩 · → ${pct(u)}% · 节省 ~${before - estimateMessagesTokens(messages)} tokens`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Tool result pruning
// Uses Codex-style middle truncation: keep beginning + end, remove middle.
// ═══════════════════════════════════════════════════════════════════════════

function _pruneToolResults(messages, keepTurns) {
  const cutoff = _findTurnCutoff(messages, keepTurns);
  if (cutoff <= 0) return 0;

  let saved = 0;

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];

    // Trim large tool results (middle truncation)
    if (msg.role === "tool" && msg.content && msg.content.length > TOOL_TRIM_SIZE) {
      const orig = msg.content;
      msg.content = _middleTruncate(orig, TOOL_TRIM_SIZE);
      saved += orig.length - msg.content.length;
    }

    // Trim large tool_call arguments (Write content, Edit strings, long commands)
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const argStr = tc.function?.arguments;
        if (!argStr || argStr.length <= 800) continue;

        try {
          const a = JSON.parse(argStr);
          let changed = false;

          for (const key of ["content", "old_string", "new_string"]) {
            if (a[key] && a[key].length > 200) {
              saved += a[key].length - 100;
              a[key] = a[key].slice(0, 80) + `…[${a[key].length} chars]`;
              changed = true;
            }
          }
          if (a.command && a.command.length > 300) {
            saved += a.command.length - 200;
            a.command = a.command.slice(0, 180) + "…";
            changed = true;
          }

          if (changed) tc.function.arguments = JSON.stringify(a);
        } catch {
          // Not valid JSON, skip
        }
      }
    }
  }

  return saved;
}

/**
 * Middle truncation: keep the beginning and end of text, remove the middle.
 * Inspired by Codex CLI's truncate.rs approach.
 */
function _middleTruncate(text, budget) {
  if (text.length <= budget) return text;

  const halfBudget = Math.floor(budget / 2);
  const prefix = text.slice(0, halfBudget);
  const suffix = text.slice(text.length - halfBudget);
  const removed = estimateTokens(text) - estimateTokens(prefix + suffix);

  return `${prefix}\n…${removed} tokens truncated…\n${suffix}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 & 3: Model-driven compaction
// The model generates a handoff summary. We then build a new compact history
// consisting of: [recent user messages] + [summary with prefix framing].
// ═══════════════════════════════════════════════════════════════════════════

async function _modelCompact(messages, client, memory, onInfo, keepTurns, emergency) {
  const cutoff = _findTurnCutoff(messages, keepTurns);
  if (cutoff <= 1) return;

  const oldMessages = messages.slice(0, cutoff);

  // Build recap of old messages for the model to summarize
  const recap = _buildRecap(oldMessages);

  // Get existing memory to avoid redundancy
  let memoryHint = "";
  if (memory) {
    try {
      const existing = await memory.read();
      if (existing && existing.length > 0) {
        memoryHint = `\n\nThe AI's long-term memory already contains:\n${_truncate(existing, 500)}\nDo NOT repeat this information.`;
      }
    } catch { /* ignore */ }
  }

  const prompt = emergency ? EMERGENCY_COMPACT_PROMPT : COMPACT_PROMPT;
  let summary = null;
  let memoryEntry = null;

  // Ask Mercury-2 to generate the handoff summary
  if (client) {
    try {
      const response = await client.chatCompletion(
        [
          { role: "system", content: prompt + memoryHint },
          { role: "user", content: recap },
        ],
        {
          max_tokens: emergency ? 1500 : 2500,
          temperature: 0.3,
          reasoning_effort: "low",
        }
      );

      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        const parts = _parseSections(raw);
        summary = parts.summary;
        memoryEntry = parts.memory;
      }
    } catch (err) {
      onInfo(`压缩 API 调用失败 (${err.message})，使用机械摘要`);
    }
  }

  // Fallback: mechanical summary if model unavailable
  if (!summary) {
    summary = _buildFallbackSummary(oldMessages);
  }

  // Save long-term facts to memory
  if (memory && memoryEntry) {
    try { await memory.append(memoryEntry); } catch { /* non-critical */ }
  }

  // ── Build compacted history (Codex-style) ──
  // 1. Collect recent real user messages (up to USER_MSG_TOKEN_BUDGET)
  const recentUserMsgs = _collectRecentUserMessages(oldMessages, USER_MSG_TOKEN_BUDGET);

  // 2. Build the summary message with framing prefix
  const summaryText = `${SUMMARY_PREFIX}\n${summary}`;

  // 3. Construct the new compacted segment:
  //    [recent user messages as individual messages] + [summary as final message]
  const compactedSegment = [];

  for (const text of recentUserMsgs) {
    compactedSegment.push({ role: "user", content: text });
  }

  compactedSegment.push({
    role: "user",
    content: summaryText,
  });

  // Replace old messages with the compacted segment
  messages.splice(0, cutoff, ...compactedSegment);
}

/**
 * Collect recent real user messages from history (most recent first, reversed).
 * Budget-limited by token count, similar to Codex's COMPACT_USER_MESSAGE_MAX_TOKENS.
 */
function _collectRecentUserMessages(messages, tokenBudget) {
  const selected = [];
  let remaining = tokenBudget;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    // Skip previous compression summaries
    if (msg.content?.startsWith(SUMMARY_PREFIX)) continue;

    const tokens = estimateTokens(msg.content);
    if (tokens > remaining) break;

    selected.push(msg.content);
    remaining -= tokens;
  }

  selected.reverse();
  return selected;
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompts — inspired by Codex CLI + enhanced with structured output
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Framing prefix prepended to every summary. Tells the model another LLM wrote it.
 * Directly inspired by Codex CLI's summary_prefix.md.
 */
const SUMMARY_PREFIX =
  "Another instance of this AI started working on this task and produced the following handoff summary. " +
  "The tools' file state reflects what was actually done. Use this summary to continue seamlessly without duplicating work:";

const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION for a coding assistant session.
Create a structured handoff summary so another AI can seamlessly continue the work.

Produce exactly TWO sections:

## SUMMARY
Include (max 300 words):
- **Task**: What the user requested (be specific)
- **Progress**: What has been done so far
- **Files**: Every file path that was read, created, or modified — with brief notes on what changed
- **Pending**: What still needs to be done (clear next steps)
- **Issues**: Any errors encountered, blockers, or important discoveries
- **Context**: User preferences, constraints, or conventions observed

Rules:
- Every file path MUST be absolute and exact
- Describe changes concretely (e.g. "added 120s timeout to HTTP requests" not "modified client.js")
- If something is done, say "Done:" briefly — don't list every step
- Preserve exact values: config numbers, variable names, API endpoints

## MEMORY
Key facts for long-term reference (max 150 words):
- Project file structure and purposes
- Architecture decisions and patterns
- Important config values and constants
- User preferences and conventions`;

const EMERGENCY_COMPACT_PROMPT = `You are performing EMERGENCY context compression. Space is critically low.
Produce the absolute minimum needed to continue working.

## SUMMARY
Maximum 100 words:
- What task is active (1 sentence)
- File paths + current state (created/modified/done)
- What's pending (1-2 sentences)
- Any blocking errors

Omit all intermediate steps, tool details, and explanations.

## MEMORY
Maximum 80 words. Only critical facts that would be permanently lost:
- File paths and purposes
- Key decisions and config values`;

// ═══════════════════════════════════════════════════════════════════════════
// Recap builder: convert messages into a work log for the model
// ═══════════════════════════════════════════════════════════════════════════

function _buildRecap(messages) {
  const parts = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        if (msg.content?.startsWith(SUMMARY_PREFIX)) {
          // Previous compression summary — include more fully to prevent info loss
          parts.push(`PRIOR SUMMARY: ${_truncate(msg.content, 800)}`);
        } else {
          parts.push(`USER: ${_truncate(msg.content, 400)}`);
        }
        break;

      case "assistant":
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const name = tc.function.name;
            let argSummary;
            try {
              const a = JSON.parse(tc.function.arguments);
              argSummary = _summarizeToolArgs(name, a);
            } catch {
              argSummary = _truncate(tc.function.arguments, 100);
            }
            parts.push(`TOOL: ${name}(${argSummary})`);
          }
        }
        if (msg.content) {
          parts.push(`ASSISTANT: ${_truncate(msg.content, 400)}`);
        }
        break;

      case "tool": {
        const content = msg.content || "";
        if (content.length > 300) {
          // Check if it contains errors (high priority to preserve)
          const hasError = /error|fail|exception|denied|not found/i.test(content);
          if (hasError) {
            const errorLines = content.split("\n")
              .filter(l => /error|fail|exception|denied|not found/i.test(l))
              .slice(0, 3);
            parts.push(`RESULT (error): ${errorLines.join("; ") || _truncate(content, 200)}`);
          } else {
            const lines = content.split("\n");
            parts.push(`RESULT (${lines.length} lines): ${_truncate(lines.slice(0, 2).join("\n"), 150)}…`);
          }
        } else {
          parts.push(`RESULT: ${content}`);
        }
        break;
      }
    }
  }

  return parts.join("\n");
}

/**
 * Summarize tool arguments in a human-readable way for the recap.
 */
function _summarizeToolArgs(name, args) {
  switch (name) {
    case "Read":
      return args.file_path || "?";
    case "Write":
      return `${args.file_path || "?"}, ${args.content?.length || 0} chars`;
    case "Edit":
      return `${args.file_path || "?"}, replace ${(args.old_string || "").length}→${(args.new_string || "").length} chars`;
    case "Patch":
      return `${args.file_path || "?"}, ${args.edits?.length || 0} edits`;
    case "Bash":
      return _truncate(args.command, 120);
    case "Glob":
      return args.pattern || "?";
    case "Grep":
      return `/${args.pattern || "?"}/ in ${args.path || "."}`;
    case "ListDir":
      return args.path || ".";
    case "Diff":
      if (args.git_ref) return `ref: ${args.git_ref}`;
      return `${args.file_a || ""} vs ${args.file_b || ""}`;
    case "Fetch":
      return args.url || "?";
    case "SubAgent":
      return _truncate(args.task, 100);
    default:
      return _truncate(JSON.stringify(args), 100);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Response parser
// ═══════════════════════════════════════════════════════════════════════════

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
      const sumStart = sumMatch.index + sumMatch[0].length;
      summary = raw.slice(sumStart, memMatch.index).trim();
    } else {
      summary = raw.slice(0, memMatch.index).trim();
    }
    memory = raw.slice(memStart).trim();
  } else if (sumMatch) {
    summary = raw.slice(sumMatch.index + sumMatch[0].length).trim();
  }

  return { summary, memory };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fallback: mechanical summary when model API is unavailable
// ═══════════════════════════════════════════════════════════════════════════

function _buildFallbackSummary(messages) {
  const filesRead = new Set();
  const filesWritten = new Set();
  const commands = [];
  const userRequests = [];

  for (const msg of messages) {
    if (msg.role === "user" && msg.content && !msg.content.startsWith(SUMMARY_PREFIX)) {
      userRequests.push(_truncate(msg.content, 120));
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let a = {};
        try { a = JSON.parse(tc.function.arguments); } catch { /* skip */ }

        switch (tc.function.name) {
          case "Read": case "ListDir":
            if (a.file_path || a.path) filesRead.add(a.file_path || a.path);
            break;
          case "Write": case "Edit": case "Patch":
            if (a.file_path) filesWritten.add(a.file_path);
            break;
          case "Bash":
            if (a.command) commands.push(_truncate(a.command, 80));
            break;
          case "Diff":
            if (a.file_a) filesRead.add(a.file_a);
            if (a.file_b) filesRead.add(a.file_b);
            break;
          case "Fetch":
            if (a.url) commands.push(`fetch ${_truncate(a.url, 60)}`);
            break;
          case "Glob": case "Grep":
            if (a.pattern) commands.push(`${tc.function.name}(${_truncate(a.pattern, 40)})`);
            break;
        }
      }
    }
  }

  const parts = [];
  if (userRequests.length > 0) parts.push(`Tasks: ${userRequests.slice(-3).join(" → ")}`);
  if (filesWritten.size > 0) parts.push(`Modified: ${[...filesWritten].join(", ")}`);
  if (filesRead.size > 0) parts.push(`Read: ${[...filesRead].join(", ")}`);
  if (commands.length > 0) parts.push(`Commands: ${commands.slice(-5).join("; ")}`);

  return parts.join("\n") || "No specific actions recorded.";
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the message index that marks the boundary between old (compressible)
 * and recent (protected) messages. Returns the index of the first protected message.
 */
function _findTurnCutoff(messages, keepTurns) {
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      turns++;
      if (turns >= keepTurns) {
        // Ensure we don't split tool pairs
        let cutoff = i;
        while (cutoff > 0 && messages[cutoff - 1]?.role === "tool") cutoff--;
        return cutoff > 0 ? cutoff : 0;
      }
    }
  }
  return 0; // Not enough turns to compress
}

function _truncate(text, maxLen) {
  if (!text) return "(empty)";
  if (typeof text !== "string") text = String(text);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}
