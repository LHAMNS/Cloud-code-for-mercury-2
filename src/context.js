// Mercury Code - Smart Context Compression
// Uses model-driven summarization + persistent memory for maximum information retention

import { MODEL_LIMITS } from "./config.js";

// When to trigger compression (fraction of max context)
const COMPRESS_THRESHOLD = 0.60;
// Super compress triggers much earlier
const SUPER_COMPRESS_THRESHOLD = 0.25;
// How many recent messages are always kept verbatim
const PROTECTED_RECENT = 6;
// Super compress keeps fewer messages
const SUPER_PROTECTED_RECENT = 2;

/**
 * Estimate tokens from a string. ~3.5 chars per token for mixed content.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate total tokens for a messages array.
 */
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

/**
 * Smart context compression.
 *
 * Strategy:
 *   1. Gather all OLD messages (outside the protected window)
 *   2. Ask the model to produce a concise work log:
 *      - What tools were called, what files were read/written/edited
 *      - What changes were made and what was the outcome
 *      - Key decisions, errors encountered, facts discovered
 *   3. Save the work log into memory file for long-term retention
 *   4. Replace all old messages with ONE short summary message
 *   5. Recent messages stay verbatim so the model has full context for current task
 *
 * @param {Array} messages      - conversation.messages (mutable)
 * @param {string} systemPrompt - the system prompt text
 * @param {object} client       - MercuryClient (for summarization call)
 * @param {object} memory       - MemoryManager instance
 * @param {Function} onInfo     - callback for info messages
 */
export async function compressContext(
  messages,
  systemPrompt,
  client,
  memory,
  onInfo
) {
  const maxTokens = MODEL_LIMITS.max_context_tokens;
  const systemTokens = estimateTokens(systemPrompt) + 4;
  const currentTokens = systemTokens + estimateMessagesTokens(messages);
  const usage = currentTokens / maxTokens;

  if (usage < COMPRESS_THRESHOLD) return;

  // Determine how many old messages to compress.
  // We protect PROTECTED_RECENT messages, but must avoid splitting
  // tool_call / tool_result pairs at the boundary.
  let protectedCount = Math.min(PROTECTED_RECENT, messages.length);
  let cutoff = messages.length - protectedCount;

  // Adjust cutoff so we don't split a tool_call/tool_result pair.
  // If the first protected message is a tool result, walk backward to include
  // its preceding assistant tool_call message.
  while (cutoff > 0 && messages[cutoff]?.role === "tool") {
    cutoff--;
    protectedCount++;
  }

  if (cutoff <= 1) return; // nothing meaningful to compress

  const oldMessages = messages.slice(0, cutoff);
  const tokensBefore = estimateMessagesTokens(oldMessages);

  onInfo(
    `Context at ${(usage * 100).toFixed(0)}% capacity — compressing ${oldMessages.length} old messages (~${tokensBefore} tokens)...`
  );

  // Build a structured recap of old messages for the model to summarize
  const recap = buildRecapForSummarization(oldMessages);

  let summary = null;
  let memoryEntry = null;

  // Try model-driven summarization
  if (client) {
    try {
      const response = await client.chatCompletion(
        [
          {
            role: "system",
            content: SUMMARIZE_SYSTEM_PROMPT,
          },
          { role: "user", content: recap },
        ],
        { max_tokens: 2000, temperature: 0.5, reasoning_effort: "low" }
      );

      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        // Split: model returns SUMMARY section and MEMORY section
        const parts = parseSummaryResponse(raw);
        summary = parts.summary;
        memoryEntry = parts.memory;
      }
    } catch (err) {
      onInfo(`Summarization API call failed (${err.message}), using fallback`);
    }
  }

  // Fallback: build a mechanical summary if model fails
  if (!summary) {
    summary = buildFallbackSummary(oldMessages);
  }

  // Save key facts to memory file
  if (memory && memoryEntry) {
    try {
      await memory.append(memoryEntry);
    } catch {
      // non-critical, continue
    }
  }

  // Replace old messages with a single summary message
  const summaryMsg = {
    role: "user",
    content: `[Previous conversation compressed — ${oldMessages.length} messages summarized]\n\n${summary}`,
  };
  messages.splice(0, cutoff, summaryMsg);

  const tokensAfter = estimateMessagesTokens(messages);
  const saved = tokensBefore - estimateMessagesTokens([summaryMsg]);
  onInfo(
    `Compressed: ${oldMessages.length} messages → 1 summary. Saved ~${saved} tokens. Now at ${((systemTokens + tokensAfter) / maxTokens * 100).toFixed(0)}% capacity.`
  );
}

/**
 * Super Compress — aggressive model-driven context compression.
 *
 * The model itself decides what is essential vs. expendable. Only the most
 * recent user-assistant exchange is kept verbatim. Everything else is
 * compressed into a tight summary. Full conversation remains in
 * .mercury/conversation.jsonl as a safety net.
 *
 * Triggers earlier (25% capacity) and compresses harder than normal mode.
 */
export async function superCompressContext(
  messages,
  systemPrompt,
  client,
  memory,
  onInfo
) {
  const maxTokens = MODEL_LIMITS.max_context_tokens;
  const systemTokens = estimateTokens(systemPrompt) + 4;
  const currentTokens = systemTokens + estimateMessagesTokens(messages);
  const usage = currentTokens / maxTokens;

  if (usage < SUPER_COMPRESS_THRESHOLD) return;

  // Keep only the most recent exchange (last 2 messages + any trailing tool pairs)
  let protectedCount = Math.min(SUPER_PROTECTED_RECENT, messages.length);
  let cutoff = messages.length - protectedCount;

  // Don't split tool pairs
  while (cutoff > 0 && messages[cutoff]?.role === "tool") {
    cutoff--;
    protectedCount++;
  }

  if (cutoff <= 1) return;

  const oldMessages = messages.slice(0, cutoff);
  const tokensBefore = estimateMessagesTokens(oldMessages);

  onInfo(
    `🔥 Super compress at ${(usage * 100).toFixed(0)}% — compressing ${oldMessages.length} messages (~${tokensBefore} tokens)...`
  );

  const recap = buildRecapForSummarization(oldMessages);
  let summary = null;
  let memoryEntry = null;

  if (client) {
    try {
      const response = await client.chatCompletion(
        [
          { role: "system", content: SUPER_COMPRESS_PROMPT },
          { role: "user", content: recap },
        ],
        { max_tokens: 1500, temperature: 0.5, reasoning_effort: "medium" }
      );

      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        const parts = parseSummaryResponse(raw);
        summary = parts.summary;
        memoryEntry = parts.memory;
      }
    } catch (err) {
      onInfo(`Super compress API call failed (${err.message}), using fallback`);
    }
  }

  if (!summary) {
    summary = buildFallbackSummary(oldMessages);
  }

  if (memory && memoryEntry) {
    try {
      await memory.append(memoryEntry);
    } catch {
      // non-critical
    }
  }

  const summaryMsg = {
    role: "user",
    content: `[Super compressed — ${oldMessages.length} messages → summary]\n\n${summary}\n\n(Full conversation log available in .mercury/conversation.jsonl)`,
  };
  messages.splice(0, cutoff, summaryMsg);

  const tokensAfter = estimateMessagesTokens(messages);
  const saved = tokensBefore - estimateMessagesTokens([summaryMsg]);
  onInfo(
    `🔥 Super compressed: ${oldMessages.length} → 1 summary. Saved ~${saved} tokens. Now at ${((systemTokens + tokensAfter) / maxTokens * 100).toFixed(0)}% capacity.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Summarization prompts
// ═══════════════════════════════════════════════════════════════════════════

const SUMMARIZE_SYSTEM_PROMPT = `You are a conversation compressor. Given a work log of an AI coding assistant session, produce two sections:

## SUMMARY
A brief summary (max 200 words) for the AI to continue working. Include:
- What task the user requested
- What files were read, created, or modified (with paths)
- What specific changes were made (e.g. "changed max_tokens from 100000 to 50000 in config.js")
- Current state: what's done, what's pending
- Any errors or issues encountered

## MEMORY
Key facts to remember long-term (max 150 words). Include:
- File paths and their purposes
- Architecture decisions made
- Configuration values
- Patterns or conventions discovered
- User preferences observed

Format each section with the exact headers shown above. Be concise — every word counts.`;

const SUPER_COMPRESS_PROMPT = `You are an aggressive context compressor. Your job is to compress an AI coding session into the absolute minimum needed to continue working.

## SUMMARY
Maximum 100 words. Only include:
- What the current task is (1 sentence)
- What files exist and their state (paths only, e.g. "Created: /src/app.js, /src/config.js")
- What is done vs. still pending (1-2 sentences)
- Any blocking errors (if any)

Omit: tool call details, intermediate steps, file contents, verbose explanations.
If a task is fully completed, just say "Done: [task]" — no need to list every step.

## MEMORY
Maximum 100 words. Only critical facts:
- File paths and what they do
- Key config values or architecture decisions
- User preferences

Format with exact headers above. Every word must earn its place.`;

// ═══════════════════════════════════════════════════════════════════════════
// Recap builder: convert messages into readable work log for the model
// ═══════════════════════════════════════════════════════════════════════════

function buildRecapForSummarization(messages) {
  const parts = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`USER: ${truncate(msg.content, 300)}`);
        break;
      case "assistant":
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const args = truncate(tc.function.arguments, 150);
            parts.push(`TOOL CALL: ${tc.function.name}(${args})`);
          }
        }
        if (msg.content) {
          parts.push(`ASSISTANT: ${truncate(msg.content, 300)}`);
        }
        break;
      case "tool": {
        // For tool results, be very aggressive with truncation
        // The model just needs to know what the outcome was
        const content = msg.content || "";
        if (content.length > 200) {
          // For Read results: show first 2 lines + "... N lines total"
          const lines = content.split("\n");
          const preview = lines.slice(0, 3).join("\n");
          parts.push(
            `TOOL RESULT (${lines.length} lines): ${truncate(preview, 150)}...`
          );
        } else {
          parts.push(`TOOL RESULT: ${content}`);
        }
        break;
      }
    }
  }
  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Parse model's summary response into sections
// ═══════════════════════════════════════════════════════════════════════════

function parseSummaryResponse(raw) {
  let summary = raw;
  let memory = null;

  // Support both "## MEMORY" and "**MEMORY**" header formats
  const memoryPattern = /(?:^|\n)\s*(?:#{1,3}\s*MEMORY|\*{1,2}MEMORY\*{1,2})\s*/i;
  const summaryPattern = /(?:^|\n)\s*(?:#{1,3}\s*SUMMARY|\*{1,2}SUMMARY\*{1,2})\s*/i;

  const memoryMatch = memoryPattern.exec(raw);
  const summaryMatch = summaryPattern.exec(raw);

  if (memoryMatch) {
    const memoryContentStart = memoryMatch.index + memoryMatch[0].length;

    if (summaryMatch && summaryMatch.index < memoryMatch.index) {
      const summaryContentStart = summaryMatch.index + summaryMatch[0].length;
      summary = raw.slice(summaryContentStart, memoryMatch.index).trim();
    } else {
      summary = raw.slice(0, memoryMatch.index).trim();
    }
    memory = raw.slice(memoryContentStart).trim();
  } else if (summaryMatch) {
    summary = raw.slice(summaryMatch.index + summaryMatch[0].length).trim();
  }

  return { summary, memory };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fallback: mechanical summary when model API is unavailable
// ═══════════════════════════════════════════════════════════════════════════

function buildFallbackSummary(messages) {
  const actions = [];
  const filesRead = new Set();
  const filesWritten = new Set();
  const commandsRun = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          // skip
        }
        switch (tc.function.name) {
          case "Read":
            if (args.file_path) filesRead.add(args.file_path);
            break;
          case "Write":
            if (args.file_path) filesWritten.add(args.file_path);
            break;
          case "Edit":
            if (args.file_path) filesWritten.add(args.file_path);
            break;
          case "Bash":
            if (args.command) commandsRun.push(truncate(args.command, 80));
            break;
        }
      }
    }
    if (msg.role === "user" && msg.content) {
      actions.push(`User: ${truncate(msg.content, 100)}`);
    }
    if (msg.role === "assistant" && msg.content) {
      actions.push(`Assistant: ${truncate(msg.content, 100)}`);
    }
  }

  const parts = [];
  if (filesRead.size > 0) parts.push(`Files read: ${[...filesRead].join(", ")}`);
  if (filesWritten.size > 0) parts.push(`Files written/edited: ${[...filesWritten].join(", ")}`);
  if (commandsRun.length > 0) parts.push(`Commands run: ${commandsRun.join("; ")}`);
  if (actions.length > 0) {
    // Keep last 5 actions
    const recent = actions.slice(-5);
    parts.push(`Recent actions:\n${recent.join("\n")}`);
  }

  return parts.join("\n\n") || "Previous conversation context (no specific actions recorded).";
}

function truncate(text, maxLen) {
  if (!text) return "(empty)";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
