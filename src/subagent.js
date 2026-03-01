// Mercury Code - SubAgent System
// Enables the main agent to spawn isolated sub-agents for parallel tasks.
// Sub-agents have their own conversation context and can use core tools
// (but NOT SubAgent/SubAgentTeam to prevent infinite recursion).

import { MercuryClient } from "./client.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { ToolExecutor } from "./tools/executor.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { estimateTokens, estimateMessagesTokens, compressContext } from "./context.js";
import { MODEL_LIMITS } from "./config.js";

// Maximum tool turns per sub-agent (more conservative than main agent)
const MAX_SUB_TURNS = 30;
// Maximum concurrent sub-agents
const MAX_CONCURRENT = 5;
// Sub-agents cannot spawn further sub-agents or use expensive ContextSearch — filter these out
const SUB_AGENT_TOOLS = TOOL_DEFINITIONS.filter(
  (t) => !["SubAgent", "SubAgentTeam", "ContextSearch"].includes(t.function.name)
);
// Compress sub-agent context at 70% capacity (same Codex approach as main agent)
const SUB_AGENT_COMPRESS_THRESHOLD = 0.70;

// Track running sub-agents globally for concurrency control
let runningCount = 0;

/**
 * SubAgent: an isolated agent with its own conversation context.
 * It can call core tools (Read, Write, Edit, Bash, Glob, Grep) but NOT
 * SubAgent/SubAgentTeam to prevent infinite recursion.
 */
export class SubAgent {
  /**
   * @param {object} options
   * @param {string} options.task - Description of what this sub-agent should do
   * @param {string} [options.apiKey] - API key (defaults to env var)
   * @param {string} [options.baseURL] - API base URL (defaults to config)
   */
  constructor(options = {}) {
    this.task = options.task || "";
    this.client = new MercuryClient({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    // Pass credentials down so sub-agent tools work correctly
    this.toolExecutor = new ToolExecutor({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.messages = [];
    this._turnCount = 0;
  }

  /**
   * Run the sub-agent to completion.
   * Returns the final text response from the model.
   * @returns {Promise<string>} The sub-agent's final response
   */
  async run() {
    if (runningCount >= MAX_CONCURRENT) {
      return `Error: Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached. Wait for existing sub-agents to finish.`;
    }

    runningCount++;
    try {
      return await this._execute();
    } finally {
      runningCount--;
    }
  }

  async _execute() {
    // Build system prompt for the sub-agent (stored separately, like main agent)
    this._systemPrompt =
      buildSystemPrompt(process.cwd()) +
      `\n## Sub-Agent Context\n\nYou are a sub-agent spawned by the main agent to handle a specific task. ` +
      `Focus exclusively on completing the assigned task. Be thorough but concise in your final response. ` +
      `Return only the relevant findings or results — the main agent will use your output to continue its work.\n` +
      `Note: You have access to core tools (Read, Write, Edit, Bash, Glob, Grep) but cannot spawn further sub-agents.\n`;

    // Messages array WITHOUT system prompt (same pattern as main Conversation)
    this.messages = [
      { role: "user", content: this.task },
    ];

    // Run the agentic loop
    while (this._turnCount < MAX_SUB_TURNS) {
      this._turnCount++;

      // Codex-style context compression (same approach as main agent)
      try {
        await compressContext(
          this.messages,       // Modified in-place
          this._systemPrompt,  // For token estimation
          this.client,         // Mercury-2 for summarization
          null,                // No memory manager for sub-agents
          () => {},            // Silent (no UI)
        );
      } catch {
        // Non-critical: continue even if compression fails
      }

      let response;
      try {
        // Prepend system prompt for API call (same as Conversation.getMessages())
        const apiMessages = [
          { role: "system", content: this._systemPrompt },
          ...this.messages,
        ];
        response = await this.client.chatCompletion(apiMessages, {
          tools: SUB_AGENT_TOOLS,
          max_tokens: 16000,
          reasoning_effort: "low",
        });
      } catch (err) {
        return `Sub-agent API error: ${err.message}`;
      }

      const choice = response.choices?.[0];
      if (!choice) {
        return "Sub-agent received empty response from API.";
      }

      const message = choice.message;

      // If the model returns tool calls, execute them and continue
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Add the assistant message with tool calls
        this.messages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls,
        });

        // Execute each tool call
        for (const tc of message.tool_calls) {
          const fnName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          const result = await this.toolExecutor.execute(
            fnName.toLowerCase(),
            args
          );
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: String(result),
          });
        }

        // Continue the loop for next model turn
        continue;
      }

      // No tool calls — this is the final response
      return message.content || "(sub-agent returned empty response)";
    }

    // Reached max turns
    const lastAssistant = [...this.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content);
    return (
      lastAssistant?.content ||
      "(sub-agent reached maximum turns without a final response)"
    );
  }
}

/**
 * Run multiple sub-agents concurrently.
 * @param {Array<{task: string}>} tasks - Array of task descriptions
 * @param {object} [options] - Shared options (apiKey, baseURL)
 * @returns {Promise<string[]>} Array of results from each sub-agent
 */
export async function runSubAgentTeam(tasks, options = {}) {
  const agents = tasks.map(
    (t) =>
      new SubAgent({ task: typeof t === "string" ? t : t.task, ...options })
  );

  // Run all agents concurrently
  const results = await Promise.allSettled(agents.map((a) => a.run()));

  return results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return `Sub-agent ${i + 1} failed: ${r.reason?.message || String(r.reason)}`;
  });
}
