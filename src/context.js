// Mercury Code - Context Compaction
// Direct port of OpenAI Codex CLI's compaction approach.
//
// How it works:
//   1. When context reaches threshold, ask Mercury-2 to generate a handoff summary
//   2. Replace old messages with: [recent user messages] + [summary]
//   3. The FULL uncompressed conversation is always in .mercury/conversation.jsonl
//      — the model can Read this file at any time to recover exact details
//
// This means compression is simple and lossy, but nothing is truly lost
// because the complete log is always one Read() away.

import { MODEL_LIMITS } from "./config.js";

// ── Mercury-2 limits ──────────────────────────────────────────────────────
// 128K context, 50K max output → reserve 30K for output headroom
const OUTPUT_RESERVE = 30000;
const EFFECTIVE_INPUT = MODEL_LIMITS.max_context_tokens - OUTPUT_RESERVE; // ~98K

// Compact when context hits 80% of effective input
const COMPACT_THRESHOLD = 0.80;
// Super mode compacts earlier at 50%
const SUPER_COMPACT_THRESHOLD = 0.50;

// How many recent turns to keep verbatim (turn = user msg + AI responses)
const KEEP_TURNS = 4;
const KEEP_TURNS_SUPER = 2;

// Budget for preserving user messages in compacted history (same as Codex: 20K)
const USER_MSG_BUDGET = 20000;

// ── Token estimation ──────────────────────────────────────────────────────

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 4;
    if (msg.content) total += estimateTokens(msg.content);
    if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
    if (msg.tool_call_id) total += 3;
  }
  return total;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function compressContext(messages, systemPrompt, client, memory, onInfo) {
  await _compact(messages, systemPrompt, client, memory, onInfo, COMPACT_THRESHOLD, KEEP_TURNS);
}

export async function superCompressContext(messages, systemPrompt, client, memory, onInfo) {
  await _compact(messages, systemPrompt, client, memory, onInfo, SUPER_COMPACT_THRESHOLD, KEEP_TURNS_SUPER);
}

// ── Core compaction (Codex-style) ─────────────────────────────────────────

async function _compact(messages, systemPrompt, client, memory, onInfo, threshold, keepTurns) {
  const sysTk = estimateTokens(systemPrompt) + 4;
  const usage = (sysTk + estimateMessagesTokens(messages)) / EFFECTIVE_INPUT;

  if (usage < threshold) return;

  // Find cutoff: everything before the last N turns gets compressed
  const cutoff = _findTurnCutoff(messages, keepTurns);
  if (cutoff <= 1) return;

  const oldMessages = messages.slice(0, cutoff);
  const oldTokens = estimateMessagesTokens(oldMessages);

  onInfo(
    `上下文 ${(usage * 100).toFixed(0)}% — 压缩 ${oldMessages.length} 条旧消息 (~${oldTokens} tokens)…`
  );

  // Build recap for model to summarize
  const recap = _buildRecap(oldMessages);

  let summary = null;
  let memoryEntry = null;

  // Ask Mercury-2 to generate handoff summary (same as Codex)
  if (client) {
    try {
      const response = await client.chatCompletion(
        [
          { role: "system", content: COMPACT_PROMPT },
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
    } catch (err) {
      onInfo(`压缩 API 失败 (${err.message})，使用机械摘要`);
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
  messages.splice(0, cutoff, ...replacement);

  const newUsage = (sysTk + estimateMessagesTokens(messages)) / EFFECTIVE_INPUT;
  onInfo(
    `压缩完成: ${oldMessages.length} 条消息 → ${replacement.length} 条。` +
    `${(usage * 100).toFixed(0)}% → ${(newUsage * 100).toFixed(0)}%。` +
    `完整日志: .mercury/conversation.jsonl`
  );
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
Key facts for long-term reference (max 150 words): file paths, architecture decisions, config values, user preferences.`;

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
        if (c.length > 300) {
          const lines = c.split("\n");
          const hasErr = /error|fail|exception|denied/i.test(c);
          if (hasErr) {
            const errLines = lines.filter(l => /error|fail|exception|denied/i.test(l)).slice(0, 3);
            parts.push(`RESULT (error): ${errLines.join("; ") || _trunc(c, 200)}`);
          } else {
            parts.push(`RESULT (${lines.length} lines): ${_trunc(lines.slice(0, 2).join("\n"), 150)}…`);
          }
        } else {
          parts.push(`RESULT: ${c}`);
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
  }

  const p = [];
  if (userReqs.length > 0) p.push(`Tasks: ${userReqs.slice(-3).join(" → ")}`);
  if (filesWritten.size > 0) p.push(`Modified: ${[...filesWritten].join(", ")}`);
  if (filesRead.size > 0) p.push(`Read: ${[...filesRead].join(", ")}`);
  if (commands.length > 0) p.push(`Commands: ${commands.slice(-5).join("; ")}`);
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
