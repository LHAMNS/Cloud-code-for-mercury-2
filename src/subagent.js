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
// Sub-agents cannot spawn further sub-agents or use expensive ContextSearch
const SUB_AGENT_TOOLS = TOOL_DEFINITIONS.filter(
  (t) => !["SubAgent", "SubAgentTeam", "ContextSearch"].includes(t.function.name)
);

// Read-only tools (safe in all modes)
const READ_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "ListDir", "Diff", "Fetch"]);

/**
 * Get the filtered tool set for a given trust mode.
 * In readonly mode, sub-agents only get read tools.
 */
function getToolsForTrustMode(trustMode) {
  if (trustMode === "readonly") {
    return SUB_AGENT_TOOLS.filter((t) => READ_TOOL_NAMES.has(t.function.name));
  }
  return SUB_AGENT_TOOLS;
}

// Track running sub-agents globally for concurrency control
let runningCount = 0;

/**
 * SubAgent: an isolated agent with its own conversation context.
 * Supports progress callbacks for live panel display.
 */
export class SubAgent {
  /**
   * @param {object} options
   * @param {string} options.task - Description of what this sub-agent should do
   * @param {string} [options.apiKey] - API key
   * @param {string} [options.baseURL] - API base URL
   * @param {string} [options.workspace] - Workspace root directory
   * @param {string} [options.trustMode] - Trust mode: 'readonly', 'approval', 'open'
   * @param {Function} [options.onProgress] - Callback: (event, detail) => void
   */
  constructor(options = {}) {
    this.task = options.task || "";
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || "approval";
    this.client = new MercuryClient({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    // Pass workspace and trustMode to ToolExecutor for enforcement
    this.toolExecutor = new ToolExecutor({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      workspace: this.workspace,
      trustMode: this.trustMode,
    });
    this.messages = [];
    this._turnCount = 0;
    this._onProgress = options.onProgress || null;
  }

  /**
   * Emit a progress event.
   */
  _emit(event, detail) {
    if (this._onProgress) {
      try { this._onProgress(event, detail); } catch { /* non-critical */ }
    }
  }

  /**
   * Run the sub-agent to completion.
   * @returns {Promise<string>} The sub-agent's final response
   */
  async run() {
    if (runningCount >= MAX_CONCURRENT) {
      return `Error: Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached.`;
    }

    runningCount++;
    try {
      return await this._execute();
    } finally {
      runningCount--;
    }
  }

  async _execute() {
    this._systemPrompt =
      buildSystemPrompt(this.workspace, this.trustMode) +
      `\n## Sub-Agent Context\n\nYou are a sub-agent spawned by the main agent to handle a specific task. ` +
      `Focus exclusively on completing the assigned task. Be thorough but concise in your final response. ` +
      `Return only the relevant findings or results — the main agent will use your output to continue its work.\n` +
      `Workspace: ${this.workspace}\n` +
      `Note: You have access to core tools (Read, Write, Edit, Bash, Glob, Grep) but cannot spawn further sub-agents.\n`;

    this.messages = [
      { role: "user", content: this.task },
    ];

    this._emit("thinking", "Starting...");

    while (this._turnCount < MAX_SUB_TURNS) {
      this._turnCount++;

      // Codex-style context compression
      try {
        const compressed = await compressContext(
          this.messages,
          this._systemPrompt,
          this.client,
          null,
          () => {},
        );
        if (compressed) this._emit("compressing", "Context compressed");
      } catch {
        // Non-critical
      }

      this._emit("thinking", `Turn ${this._turnCount}...`);

      let response;
      try {
        const apiMessages = [
          { role: "system", content: this._systemPrompt },
          ...this.messages,
        ];
        response = await this.client.chatCompletion(apiMessages, {
          tools: getToolsForTrustMode(this.trustMode),
          max_tokens: 16000,
          reasoning_effort: "low",
        });
      } catch (err) {
        this._emit("error", err.message);
        return `Sub-agent API error: ${err.message}`;
      }

      const choice = response.choices?.[0];
      if (!choice) {
        this._emit("error", "Empty response");
        return "Sub-agent received empty response from API.";
      }

      const message = choice.message;

      if (message.tool_calls && message.tool_calls.length > 0) {
        this.messages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls,
        });

        for (const tc of message.tool_calls) {
          const fnName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          // Emit tool call event with formatted detail
          const toolDetail = _formatToolDetail(fnName, args);
          this._emit("tool_call", `${fnName} ${toolDetail}`);

          const result = await this.toolExecutor.execute(
            fnName.toLowerCase(),
            args
          );

          this._emit("tool_result", `${fnName} done`);

          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: String(result),
          });
        }

        continue;
      }

      // Final response
      this._emit("done", message.content || "");
      return message.content || "(sub-agent returned empty response)";
    }

    // Reached max turns
    const lastAssistant = [...this.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content);
    this._emit("done", lastAssistant?.content || "max turns reached");
    return (
      lastAssistant?.content ||
      "(sub-agent reached maximum turns without a final response)"
    );
  }
}

/**
 * Format a tool call detail for display in the panel.
 */
function _formatToolDetail(name, args) {
  switch (name) {
    case "Read": return args.file_path ? `→ ${_trunc(args.file_path, 40)}` : "";
    case "Write": return args.file_path ? `→ ${_trunc(args.file_path, 40)}` : "";
    case "Edit": return args.file_path ? `→ ${_trunc(args.file_path, 40)}` : "";
    case "Bash": return args.command ? `$ ${_trunc(args.command, 40)}` : "";
    case "Glob": return args.pattern ? _trunc(args.pattern, 40) : "";
    case "Grep": return args.pattern ? `/${_trunc(args.pattern, 30)}/` : "";
    case "ListDir": return _trunc(args.path || ".", 40);
    default: return "";
  }
}

function _trunc(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

/**
 * Run multiple sub-agents concurrently with optional progress reporting.
 * @param {Array<{task: string}>} tasks - Array of task descriptions
 * @param {object} [options] - Shared options (apiKey, baseURL, onAgentProgress)
 * @returns {Promise<string[]>} Array of results from each sub-agent
 */
export async function runSubAgentTeam(tasks, options = {}) {
  const { onAgentProgress, workspace, trustMode, ...restOptions } = options;

  const agents = tasks.map(
    (t, i) =>
      new SubAgent({
        task: typeof t === "string" ? t : t.task,
        ...restOptions,
        workspace,
        trustMode,
        onProgress: onAgentProgress
          ? (event, detail) => onAgentProgress(i, event, detail)
          : null,
      })
  );

  const results = await Promise.allSettled(agents.map((a) => a.run()));

  return results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return `Sub-agent ${i + 1} failed: ${r.reason?.message || String(r.reason)}`;
  });
}
