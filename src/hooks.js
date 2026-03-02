// Mercury Code - Hooks System
// Modeled after Claude Code's hooks architecture.
// Hooks allow users to run custom logic at key lifecycle points:
//   - PreToolUse:  before a tool executes (can modify input, allow/deny)
//   - PostToolUse: after a tool completes (can inspect result)
//   - SubagentStart / SubagentStop: sub-agent lifecycle
//   - TeammateIdle:  when a team agent finishes its current task
//   - TaskCompleted: when a team task finishes
//   - WorktreeCreate / WorktreeRemove: git worktree lifecycle
//   - PreCompact: before context compaction
//   - SessionStart / SessionEnd: session lifecycle
//   - Notification: system notifications
//
// Hook handler types:
//   - command:  execute a shell command (receives JSON on stdin, returns JSON on stdout)
//   - prompt:   inject a prompt into the model context
//   - function: call a JS function directly (internal use)
//
// Configuration: .mercury/hooks.json or ~/.mercury/hooks.json

import { readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

// ── Hook Event Types ─────────────────────────────────────────────────────────

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "Notification",
];

// ── Hook Result Actions ──────────────────────────────────────────────────────
// PreToolUse handlers can return these to control execution:
//   allow   — skip further permission checks, proceed
//   deny    — block the tool call with a message
//   ask     — require user approval (default approval-mode behavior)
//   modify  — proceed but with modified input (updatedInput field)

const VALID_ACTIONS = new Set(["allow", "deny", "ask", "modify", "continue"]);

// ── HooksManager ─────────────────────────────────────────────────────────────

export class HooksManager {
  /**
   * @param {object} [options]
   * @param {string} [options.workspace] - Project root directory
   * @param {Function} [options.onInfo] - Info callback: (msg) => void
   */
  constructor(options = {}) {
    this.workspace = options.workspace || process.cwd();
    this._onInfo = options.onInfo || null;

    /** @type {Map<string, HookHandler[]>} event → handlers */
    this._handlers = new Map();
    for (const event of HOOK_EVENTS) {
      this._handlers.set(event, []);
    }

    this._loaded = false;
  }

  /**
   * Load hooks from project and global config files.
   * Project hooks override global hooks with the same ID.
   */
  async load() {
    this._handlers = new Map();
    for (const event of HOOK_EVENTS) {
      this._handlers.set(event, []);
    }

    // 1. Load global hooks: ~/.mercury/hooks.json
    const globalPath = path.join(os.homedir(), ".mercury", "hooks.json");
    await this._loadFromFile(globalPath, "global");

    // 2. Load project hooks: .mercury/hooks.json (overrides global)
    const projectPath = path.join(this.workspace, ".mercury", "hooks.json");
    await this._loadFromFile(projectPath, "project");

    this._loaded = true;
  }

  /**
   * Load hooks from a JSON config file.
   * Format:
   *   {
   *     "hooks": {
   *       "PreToolUse": [
   *         { "id": "my-hook", "type": "command", "command": "my-script.sh",
   *           "matcher": "Bash", "timeout": 5000 }
   *       ],
   *       "PostToolUse": [ ... ]
   *     }
   *   }
   */
  async _loadFromFile(filePath, source) {
    try {
      const data = await readFile(filePath, "utf-8");
      const config = JSON.parse(data);
      if (!config.hooks || typeof config.hooks !== "object") return;

      for (const [event, handlers] of Object.entries(config.hooks)) {
        if (!this._handlers.has(event)) continue;
        if (!Array.isArray(handlers)) continue;

        for (const h of handlers) {
          const handler = {
            id: h.id || `${source}-${event}-${Date.now()}`,
            event,
            type: h.type || "command",
            command: h.command || null,
            prompt: h.prompt || null,
            fn: null,
            matcher: h.matcher || null,       // tool name or glob pattern to match
            timeout: h.timeout || 10000,       // 10s default
            source,
          };
          this._handlers.get(event).push(handler);
        }
      }
    } catch {
      // File doesn't exist or invalid JSON — OK
    }
  }

  /**
   * Register a hook handler programmatically (for internal use).
   * @param {string} event - Hook event name
   * @param {object} handler - Handler definition
   */
  register(event, handler) {
    if (!this._handlers.has(event)) return;
    this._handlers.get(event).push({
      id: handler.id || `internal-${Date.now()}`,
      event,
      type: handler.type || "function",
      command: handler.command || null,
      prompt: handler.prompt || null,
      fn: handler.fn || null,
      matcher: handler.matcher || null,
      timeout: handler.timeout || 10000,
      source: "internal",
    });
  }

  /**
   * Unregister a hook handler by ID.
   * @param {string} event
   * @param {string} id
   */
  unregister(event, id) {
    if (!this._handlers.has(event)) return;
    const handlers = this._handlers.get(event);
    const idx = handlers.findIndex((h) => h.id === id);
    if (idx !== -1) handlers.splice(idx, 1);
  }

  /**
   * Get all registered handlers for an event.
   * @param {string} event
   * @returns {Array}
   */
  getHandlers(event) {
    return this._handlers.get(event) || [];
  }

  /**
   * Check if any handlers are registered for an event.
   * @param {string} event
   * @returns {boolean}
   */
  hasHandlers(event) {
    const handlers = this._handlers.get(event);
    return handlers && handlers.length > 0;
  }

  // ── Fire hooks ──────────────────────────────────────────────────────────

  /**
   * Fire a hook event. Runs all matching handlers sequentially.
   * For PreToolUse, returns { action, updatedInput?, message? }.
   * For other events, returns { results: [...] }.
   *
   * @param {string} event - Hook event name
   * @param {object} context - Event context (varies by event type)
   * @returns {Promise<object>} Hook result
   */
  async fire(event, context = {}) {
    const handlers = this._handlers.get(event);
    if (!handlers || handlers.length === 0) {
      return { action: "continue", results: [] };
    }

    // Filter handlers by matcher (for tool-specific hooks)
    const matching = handlers.filter((h) => {
      if (!h.matcher) return true;
      if (context.toolName) {
        return this._matchTool(h.matcher, context.toolName);
      }
      return true;
    });

    if (matching.length === 0) {
      return { action: "continue", results: [] };
    }

    const results = [];

    for (const handler of matching) {
      try {
        const result = await this._executeHandler(handler, event, context);
        results.push({ handlerId: handler.id, ...result });

        // For PreToolUse, short-circuit on allow/deny/modify
        if (event === "PreToolUse" && result.action && result.action !== "continue") {
          return {
            action: result.action,
            updatedInput: result.updatedInput || null,
            message: result.message || null,
            results,
          };
        }
      } catch (err) {
        results.push({ handlerId: handler.id, error: err.message });
        if (this._onInfo) {
          this._onInfo(`Hook ${handler.id} error: ${err.message}`);
        }
      }
    }

    return { action: "continue", results };
  }

  /**
   * Execute a single hook handler.
   * @param {object} handler
   * @param {string} event
   * @param {object} context
   * @returns {Promise<object>}
   */
  async _executeHandler(handler, event, context) {
    switch (handler.type) {
      case "command":
        return this._executeCommand(handler, event, context);
      case "prompt":
        return { action: "continue", prompt: handler.prompt };
      case "function":
        if (typeof handler.fn === "function") {
          return await handler.fn(event, context);
        }
        return { action: "continue" };
      default:
        return { action: "continue" };
    }
  }

  /**
   * Execute a command-type hook handler.
   * Sends event context as JSON on stdin, expects JSON on stdout.
   */
  _executeCommand(handler, event, context) {
    return new Promise((resolve) => {
      const timeout = handler.timeout || 10000;

      // Build input payload
      const payload = JSON.stringify({
        event,
        toolName: context.toolName || null,
        toolInput: context.toolInput || null,
        agentId: context.agentId || null,
        taskId: context.taskId || null,
        result: context.result || null,
        workspace: this.workspace,
      });

      // Parse command into executable + args
      const parts = handler.command.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      const child = execFile(cmd, args, {
        cwd: this.workspace,
        timeout,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, MERCURY_HOOK_EVENT: event },
      }, (err, stdout, _stderr) => {
        if (err) {
          resolve({ action: "continue", error: err.message });
          return;
        }

        // Try to parse JSON response
        try {
          const result = JSON.parse(stdout.trim());
          const action = VALID_ACTIONS.has(result.action) ? result.action : "continue";
          resolve({
            action,
            updatedInput: result.updatedInput || null,
            message: result.message || null,
            data: result.data || null,
          });
        } catch {
          // Non-JSON output — treat as continue
          resolve({ action: "continue", output: stdout.trim() });
        }
      });

      // Send payload on stdin
      if (child.stdin) {
        child.stdin.write(payload);
        child.stdin.end();
      }
    });
  }

  // ── Matcher ──────────────────────────────────────────────────────────────

  /**
   * Check if a matcher pattern matches a tool name.
   * Supports:
   *   - Exact match: "Bash"
   *   - Glob-like: "Bash(*)" matches Bash with any args
   *   - Wildcard: "*" matches all tools
   * @param {string} matcher
   * @param {string} toolName
   * @returns {boolean}
   */
  _matchTool(matcher, toolName) {
    if (matcher === "*") return true;
    if (matcher === toolName) return true;

    // Tool(specifier) pattern — extract the tool name part
    const parenIdx = matcher.indexOf("(");
    if (parenIdx !== -1) {
      const matchToolName = matcher.slice(0, parenIdx);
      return matchToolName === toolName;
    }

    return false;
  }

  // ── Convenience fire methods ───────────────────────────────────────────

  /**
   * Fire PreToolUse hook.
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {Promise<{action: string, updatedInput?: object, message?: string}>}
   */
  async firePreToolUse(toolName, toolInput) {
    return this.fire("PreToolUse", { toolName, toolInput });
  }

  /**
   * Fire PostToolUse hook.
   * @param {string} toolName
   * @param {object} toolInput
   * @param {string} result
   */
  async firePostToolUse(toolName, toolInput, result) {
    return this.fire("PostToolUse", { toolName, toolInput, result });
  }

  /**
   * Fire SubagentStart hook.
   * @param {string} agentId
   * @param {string} task
   */
  async fireSubagentStart(agentId, task) {
    return this.fire("SubagentStart", { agentId, task });
  }

  /**
   * Fire SubagentStop hook.
   * @param {string} agentId
   * @param {string} result
   */
  async fireSubagentStop(agentId, result) {
    return this.fire("SubagentStop", { agentId, result });
  }

  /**
   * Fire TeammateIdle hook.
   * @param {string} agentId
   * @param {string} name
   */
  async fireTeammateIdle(agentId, name) {
    return this.fire("TeammateIdle", { agentId, agentName: name });
  }

  /**
   * Fire TaskCompleted hook.
   * @param {string} taskId
   * @param {string} result
   * @param {boolean} isError
   */
  async fireTaskCompleted(taskId, result, isError = false) {
    return this.fire("TaskCompleted", { taskId, result, isError });
  }

  /**
   * Fire WorktreeCreate hook.
   * @param {string} worktreePath
   * @param {string} branch
   * @param {string} agentId
   */
  async fireWorktreeCreate(worktreePath, branch, agentId) {
    return this.fire("WorktreeCreate", { worktreePath, branch, agentId });
  }

  /**
   * Fire WorktreeRemove hook.
   * @param {string} worktreePath
   * @param {string} branch
   * @param {boolean} hadChanges
   */
  async fireWorktreeRemove(worktreePath, branch, hadChanges) {
    return this.fire("WorktreeRemove", { worktreePath, branch, hadChanges });
  }

  /**
   * Fire PreCompact hook.
   * @param {number} tokenCount
   * @param {number} compactionCount
   */
  async firePreCompact(tokenCount, compactionCount) {
    return this.fire("PreCompact", { tokenCount, compactionCount });
  }

  /**
   * Fire SessionStart hook.
   * @param {string} workspace
   */
  async fireSessionStart(workspace) {
    return this.fire("SessionStart", { workspace });
  }

  /**
   * Fire SessionEnd hook.
   */
  async fireSessionEnd() {
    return this.fire("SessionEnd", {});
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _globalHooks = null;

/**
 * Get or create the global hooks manager.
 * @param {string} [workspace]
 * @returns {HooksManager}
 */
export function getHooksManager(workspace) {
  if (!_globalHooks || (workspace && _globalHooks.workspace !== workspace)) {
    _globalHooks = new HooksManager({ workspace });
  }
  return _globalHooks;
}

/**
 * Initialize hooks (load config files).
 * Call once at session start.
 * @param {string} workspace
 * @returns {Promise<HooksManager>}
 */
export async function initHooks(workspace) {
  const hooks = getHooksManager(workspace);
  await hooks.load();
  return hooks;
}
