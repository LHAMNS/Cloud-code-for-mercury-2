/**
 * Conversation manager for Mercury Code.
 * Manages chat history, memory integration, and context compression.
 */

import { estimateTokens, estimateMessagesTokens, compressContext, superCompressContext } from "./context.js";
import { MODEL_LIMITS } from "./config.js";

export class Conversation {
  constructor(systemPrompt) {
    this.systemPrompt = systemPrompt;
    this.messages = [];
    this._lastActualUsage = null;
    this._memoryContent = ""; // loaded from memory file
  }

  addUserMessage(content) {
    this.messages.push({ role: "user", content });
  }

  addAssistantMessage(content, toolCalls = null) {
    const message = { role: "assistant", content };
    if (toolCalls) message.tool_calls = toolCalls;
    this.messages.push(message);
  }

  addToolResult(toolCallId, content) {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  /**
   * Return messages for API call, with system prompt + memory injected.
   */
  getMessages() {
    let sysContent = this.systemPrompt;
    if (this._memoryContent) {
      sysContent += `\n\n## Accumulated Memory\n\nThe following is your long-term memory from earlier in this session:\n\n${this._memoryContent}`;
    }
    return [{ role: "system", content: sysContent }, ...this.messages];
  }

  /**
   * Update the system prompt (e.g., when trust mode or workspace changes).
   */
  updateSystemPrompt(newPrompt) {
    this.systemPrompt = newPrompt;
  }

  clear() {
    this.messages = [];
    this._lastActualUsage = null;
    // Keep memory — it persists across clears
  }

  updateUsage(usage) {
    if (usage) this._lastActualUsage = usage;
  }

  /**
   * Load memory from MemoryManager.
   */
  async loadMemory(memory) {
    if (memory) {
      this._memoryContent = await memory.read();
    }
  }

  getTokenEstimate() {
    if (this._lastActualUsage?.prompt_tokens) {
      return this._lastActualUsage.prompt_tokens;
    }
    const sysTokens = estimateTokens(this.systemPrompt) + estimateTokens(this._memoryContent) + 4;
    return sysTokens + estimateMessagesTokens(this.messages);
  }

  getUsagePercent() {
    const used = this.getTokenEstimate();
    const pct = ((used / MODEL_LIMITS.max_context_tokens) * 100).toFixed(1);
    return `${pct}% (${used}/${MODEL_LIMITS.max_context_tokens})`;
  }

  /**
   * Run smart context compression.
   * @param {object} client - MercuryClient for summarization
   * @param {object} memory - MemoryManager for persistent storage
   * @param {Function} onInfo - info callback
   */
  async compress(client, memory, onInfo, superMode = false) {
    const fullSystemPrompt = this.systemPrompt + (this._memoryContent || "");
    if (superMode) {
      await superCompressContext(this.messages, fullSystemPrompt, client, memory, onInfo);
    } else {
      await compressContext(this.messages, fullSystemPrompt, client, memory, onInfo);
    }
    // Reload memory after compression (it may have been updated)
    if (memory) {
      this._memoryContent = await memory.read();
    }
  }
}
