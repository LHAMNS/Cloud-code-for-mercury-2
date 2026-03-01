/**
 * Conversation manager for Mercury Code.
 * Manages chat history sent to the Mercury-2 API (OpenAI chat completions format).
 */

export class Conversation {
  /**
   * @param {string} systemPrompt - The system prompt for the conversation.
   */
  constructor(systemPrompt) {
    this.systemPrompt = systemPrompt;
    this.messages = [];
  }

  /**
   * Add a user message to the conversation history.
   * @param {string} content - The user message content.
   */
  addUserMessage(content) {
    this.messages.push({ role: "user", content });
  }

  /**
   * Add an assistant message to the conversation history.
   * @param {string|null} content - The assistant message content (may be null if only tool calls).
   * @param {Array|null} toolCalls - Optional array of tool calls.
   */
  addAssistantMessage(content, toolCalls = null) {
    const message = { role: "assistant", content };
    if (toolCalls) {
      message.tool_calls = toolCalls;
    }
    this.messages.push(message);
  }

  /**
   * Add a tool result message to the conversation history.
   * @param {string} toolCallId - The ID of the tool call this result is for.
   * @param {string} content - The tool result content.
   */
  addToolResult(toolCallId, content) {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  /**
   * Return the full messages array for an API call, including the system prompt.
   * @returns {Array} The complete messages array.
   */
  getMessages() {
    return [{ role: "system", content: this.systemPrompt }, ...this.messages];
  }

  /**
   * Reset the conversation history.
   */
  clear() {
    this.messages = [];
  }

  /**
   * Rough token estimate based on character count / 4.
   * @returns {number} Estimated token count.
   */
  getTokenEstimate() {
    let totalChars = this.systemPrompt.length;
    for (const message of this.messages) {
      if (message.content) {
        totalChars += message.content.length;
      }
      if (message.tool_calls) {
        totalChars += JSON.stringify(message.tool_calls).length;
      }
    }
    return Math.ceil(totalChars / 4);
  }

  /**
   * Trim oldest messages if estimated tokens exceed the limit.
   * Always keeps at least the last 4 messages.
   * @param {number} maxTokens - Maximum token estimate before trimming.
   */
  trimIfNeeded(maxTokens = 120000) {
    if (this.getTokenEstimate() <= maxTokens) {
      return;
    }

    const minKeep = 4;

    while (this.messages.length > minKeep && this.getTokenEstimate() > maxTokens) {
      this.messages.shift();
    }

    console.log(
      `[Mercury] Conversation trimmed to ${this.messages.length} messages (~${this.getTokenEstimate()} tokens estimated).`
    );
  }
}
