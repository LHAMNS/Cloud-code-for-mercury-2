// Mercury Code - SubAgent System
// Enables the main agent to spawn isolated sub-agents for parallel tasks.
// Sub-agents have their own conversation context and can use core tools
// (but NOT SubAgent/SubAgentTeam to prevent infinite recursion).

import { MercuryClient } from "./client.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
// NOTE: ToolExecutor is loaded via dynamic import() in _ensureToolExecutor()
// to break the circular dependency: executor.js <-> subagent.js
import { buildSystemPrompt } from "./system-prompt.js";
import { compressContext, trimStaleToolOutputs } from "./context.js";
import { MemoryManager, ConversationLog } from "./memory.js";
import { RollbackManager } from "./rollback.js";
import { Sandbox, SANDBOX_OFF } from "./sandbox.js";
import { resolveAgentTools } from "./agent-definitions.js";
import { getHooksManager } from "./hooks.js";
import { PermissionManager, TRUST_LEVELS } from "./permissions.js";
import { encodeUntrustedToolResult } from "./untrusted-content.js";
import { debugLog } from "./utils/debug-log.js";
import path from "node:path";
import fs from "node:fs";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Maximum tool turns per sub-agent (more conservative than main agent)
const MAX_SUB_TURNS = 30;
// Maximum concurrent sub-agents
const MAX_CONCURRENT = 5;

/**
 * Clamp trust mode: agentDef can restrict but never escalate beyond parent.
 * Uses TRUST_LEVELS from permissions.js (5-mode: open < acceptEdits < approval < dontAsk < readonly).
 * @param {string} parentMode - Parent's trust mode
 * @param {string|null} defMode - Agent definition's permissionMode override
 * @returns {string} The effective trust mode
 */
function _clampTrustMode(parentMode, defMode) {
  if (!defMode) return parentMode;
  const parentLevel = TRUST_LEVELS[parentMode] ?? 2; // default to approval level
  const defLevel = TRUST_LEVELS[defMode] ?? 2;
  // Use whichever is MORE restrictive (higher level)
  return defLevel >= parentLevel ? defMode : parentMode;
}

function _workspaceSupportsWorktreeIsolation(workspace) {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();
    return result === "true";
  } catch {
    return false;
  }
}

// Track running sub-agents globally for concurrency control
let runningCount = 0;

// Track background agents globally for retrieval/resume
const _backgroundAgents = new Map();

// Periodic cleanup interval for background agents
let _cleanupInterval = null;

function _ensureCleanupInterval() {
  if (_cleanupInterval) return;
  _cleanupInterval = setInterval(() => {
    _cleanupBackgroundAgents();
  }, 60000);  // every 60 seconds
  _cleanupInterval.unref();  // don't prevent process exit
}

// Clean up completed background agents to prevent memory leaks.
// Removes agents that completed more than 30 minutes ago.
function _cleanupBackgroundAgents() {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000;  // 30 minutes after completion

  for (const [id, agent] of _backgroundAgents) {
    if (agent._backgroundDone && (now - (agent._completedAt || 0)) > MAX_AGE) {
      _backgroundAgents.delete(id);
    }
  }
}

/**
 * Get a background agent by ID (for checking completion).
 * @param {string} agentId
 * @returns {SubAgent|null}
 */
export function getBackgroundAgent(agentId) {
  return _backgroundAgents.get(agentId) || null;
}

/**
 * List all active background agents.
 * @returns {Array<{agentId: string, task: string}>}
 */
export function listBackgroundAgents() {
  const list = [];
  for (const [id, agent] of _backgroundAgents) {
    list.push({ agentId: id, task: agent.task });
  }
  return list;
}

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
   * @param {object} [options.sandboxConfig] - Sandbox config from parent
   * @param {object} [options.agentDef] - Agent definition (from agent-definitions.js)
   * @param {string} [options.resume] - Agent ID to resume (loads prior messages)
   * @param {boolean} [options.runInBackground] - Run asynchronously
   * @param {string} [options.isolation] - 'worktree' for git worktree isolation
   * @param {object} [options.permissionRules] - Permission rules config from parent
   * @param {number} [options.maxTurns] - Max turns override from tool call
   */
  constructor(options = {}) {
    this.task = options.task || "";
    this.workspace = options.workspace || process.cwd();
    // Apply permissionMode override from agent definition if present,
    // but prevent escalation: agentDef can restrict (e.g. approval → readonly)
    // but never widen (e.g. approval → open) beyond the parent's trustMode.
    const parentTrust = options.trustMode || "approval";
    const defTrust = options.agentDef?.permissionMode || null;
    let effectiveTrust = _clampTrustMode(parentTrust, defTrust);
    // aiSafetyDecide relies on an async AI safety judge callback that requires
    // a UI/user context. Sub-agents have no user callback, so the permission
    // check falls through to "allow" by default — defeating the safety gate.
    // Clamp to 'approval' which becomes 'deny' for write ops in sub-agents
    // (since sub-agents cannot prompt the user for approval).
    if (effectiveTrust === "aiSafetyDecide") {
      effectiveTrust = "approval";
    }
    this.trustMode = effectiveTrust;
    this.agentId = options.resume || options.agentId || `agent-${Date.now().toString(36)}`;
    // Sanitize agentId to prevent path traversal
    this.agentId = this.agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this._isResume = !!options.resume;
    this._runInBackground = !!options.runInBackground;
    this._isolation = options.isolation || null;
    this._worktreePath = null; // set during worktree setup
    this._worktreeBranch = null;
    /** @type {object|null} Agent definition for custom type/tools/prompt */
    this.agentDef = options.agentDef || null;
    // Apply model override from agent definition
    this._modelOverride = options.agentDef?.model || null;
    this._clientOptions = { apiKey: options.apiKey, baseURL: options.baseURL };
    this.client = new MercuryClient(this._clientOptions);

    // Hooks manager (shared from parent or create new)
    const hookOptions = {};
    if (Object.prototype.hasOwnProperty.call(options, "allowProjectHooks")) {
      hookOptions.allowProjectHooks = options.allowProjectHooks;
    }
    this._hooks = getHooksManager(this.workspace, hookOptions);

    // Permission rules (inherited from parent agent)
    this._permissions = new PermissionManager({
      workspace: this.workspace,
      trustMode: this.trustMode,
    });
    if (options.permissionRules) {
      this._permissions.fromConfig(options.permissionRules);
    }

    // Max turns override (from tool call or agent definition)
    this._maxTurnsOverride = options.maxTurns || null;

    // Background output file for monitoring
    this._outputFile = null;

    // Effective workspace (may be overridden by worktree)
    this._effectiveWorkspace = this.workspace;

    // Initialize sandbox for this sub-agent (inherits from parent config)
    this.sandbox = null;
    if (options.sandboxConfig && options.sandboxConfig.mode !== SANDBOX_OFF) {
      this.sandbox = new Sandbox({
        ...options.sandboxConfig,
        workspace: this._effectiveWorkspace,
      });
      this.sandbox.init();
    }

    // ToolExecutor is created lazily via _ensureToolExecutor() to break
    // the circular dependency between executor.js and subagent.js.
    this.toolExecutor = null;
    this._toolExecutorOptions = {
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      workspace: this._effectiveWorkspace,
      trustMode: this.trustMode,
      sandbox: this.sandbox,
    };
    this.messages = [];
    this._turnCount = 0;
    this._onProgress = options.onProgress || null;

    // Per-agent persistence: conversation log, memory, rollback
    const agentDir = path.join(this.workspace, ".mercury", "agents", this.agentId);
    this.log = new ConversationLog(null, { dir: agentDir });
    this.memory = new MemoryManager(null, { dir: agentDir });
    this.rollback = new RollbackManager(this._effectiveWorkspace);
    this._agentDir = agentDir;
    this._transcriptPath = path.join(agentDir, "transcript.json");
  }

  /**
   * Emit a progress event.
   */
  _emit(event, detail) {
    if (this._onProgress) {
      try { this._onProgress(event, detail); } catch (err) { debugLog("SubAgent._emit", err); }
    }
  }

  /**
   * Lazily create the ToolExecutor instance via dynamic import.
   * This breaks the circular dependency: executor.js <-> subagent.js.
   * Must be called (and awaited) before any code that touches this.toolExecutor.
   */
  async _ensureToolExecutor() {
    if (this.toolExecutor) return;
    const { ToolExecutor } = await import("./tools/executor.js");
    this.toolExecutor = new ToolExecutor(this._toolExecutorOptions);
  }

  _expectedWorktreePath() {
    return path.join(this.workspace, ".mercury", "worktrees", this.agentId);
  }

  _isTrustedWorktreePath(worktreePath) {
    if (!worktreePath || typeof worktreePath !== "string") return false;
    const expected = path.resolve(this._expectedWorktreePath());
    const candidate = path.resolve(worktreePath);
    if (candidate !== expected || !fs.existsSync(candidate)) {
      return false;
    }
    try {
      return fs.realpathSync(candidate) === fs.realpathSync(expected);
    } catch {
      return false;
    }
  }

  /**
   * Run the sub-agent to completion.
   * @returns {Promise<string>} The sub-agent's final response (or agentId if background)
   */
  async run() {
    if (runningCount >= MAX_CONCURRENT) {
      return `Error: Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached.`;
    }

    runningCount++;
    try {
      // Lazily initialize ToolExecutor (breaks circular dep with executor.js)
      await this._ensureToolExecutor();

      // Setup worktree isolation if requested
      if (this._isolation === "worktree") {
        try {
          await this._setupWorktree();
        } catch (err) {
          return `Error setting up worktree: ${err.message}`;
        }
      }

      // Fire SubagentStart hook
      await this._hooks.fireSubagentStart(this.agentId, this.task);

      // Background mode: launch and return agentId immediately
      if (this._runInBackground) {
        const agentId = this.agentId;

        // Create output file for background monitoring
        this._outputFile = path.join(this._agentDir, "output.log");
        try {
          await mkdir(this._agentDir, { recursive: true });
          await writeFile(this._outputFile, `[${new Date().toISOString()}] Agent ${agentId} started\n`, "utf-8");
        } catch (err) { debugLog("SubAgent.run.bgSetup", err); }

        // Start periodic cleanup interval for background agents
        _ensureCleanupInterval();

        // Run in background — store promise for later retrieval
        // Note: background execution manages its own runningCount decrement
        // via the then/catch handlers below, so we prevent the outer finally
        // from decrementing by setting a flag.
        this._backgroundLaunched = true;
        let decremented = false;
        this._backgroundPromise = this._execute().then(
          async (result) => {
            if (!decremented) { runningCount--; decremented = true; }
            await this._saveTranscript(result);
            await this._cleanupWorktree();
            this._backgroundResult = result;
            // Fire SubagentStop hook
            await this._hooks.fireSubagentStop(agentId, result);
            // Append to output file
            try {
              const { appendFile } = await import("node:fs/promises");
              await appendFile(this._outputFile, `\n[${new Date().toISOString()}] Agent completed\n${result}\n`, "utf-8");
            } catch (err) { debugLog("SubAgent.run.bgAppend", err); }
            this._backgroundDone = true;
            this._completedAt = Date.now();
            _cleanupBackgroundAgents();
            return result;
          },
          async (err) => {
            if (!decremented) { runningCount--; decremented = true; }
            await this._cleanupWorktree();
            this._backgroundResult = `Background agent error: ${err.message}`;
            await this._hooks.fireSubagentStop(agentId, this._backgroundResult);
            this._backgroundDone = true;
            this._completedAt = Date.now();
            _cleanupBackgroundAgents();
            return this._backgroundResult;
          }
        ).catch((err) => {
          // Final safety net — prevents unhandled promise rejection from crashing the session
          this._backgroundResult = `Background agent unhandled error: ${err?.message || String(err)}`;
          this._backgroundDone = true;
          this._completedAt = Date.now();
          if (!decremented && runningCount > 0) { runningCount--; decremented = true; }
        });
        // Track globally for retrieval
        _backgroundAgents.set(agentId, this);
        return `Agent launched in background. agentId: ${agentId}\noutput_file: ${this._outputFile}\nResume later with: { "resume": "${agentId}", "task": "check results" }`;
      }

      const result = await this._execute();
      await this._saveTranscript(result);
      await this._cleanupWorktree();
      // Fire SubagentStop hook
      await this._hooks.fireSubagentStop(this.agentId, result);
      return result;
    } catch (err) {
      await this._hooks.fireSubagentStop(this.agentId, `Error: ${err.message}`);
      throw err;
    } finally {
      // Background agents manage their own runningCount via promise handlers
      if (!this._backgroundLaunched) {
        runningCount--;
      }
    }
  }

  /**
   * Set up a git worktree for isolated execution.
   */
  async _setupWorktree() {
    const branchName = `mercury-worktree-${this.agentId}`;
    const worktreeDir = path.join(this.workspace, ".mercury", "worktrees", this.agentId);

    try {
      // Create worktree directory
      await mkdir(path.dirname(worktreeDir), { recursive: true });

      // Create a new branch and worktree
      execFileSync("git", ["worktree", "add", "-b", branchName, worktreeDir], {
        cwd: this.workspace,
        encoding: "utf-8",
        timeout: 30000,
      });

      this._worktreePath = worktreeDir;
      this._worktreeBranch = branchName;
      this._effectiveWorkspace = worktreeDir;
      this._toolExecutorOptions.workspace = worktreeDir;

      // Update executor workspace
      this.toolExecutor.setWorkspace?.(worktreeDir);
      if (this.sandbox) {
        this.sandbox.setWorkspace?.(worktreeDir);
      }
      this._hooks.setWorkspace?.(worktreeDir);
      this.rollback = new RollbackManager(worktreeDir);

      this._emit("worktree", `Isolated in ${worktreeDir}`);
      // Fire WorktreeCreate hook
      await this._hooks.fireWorktreeCreate(worktreeDir, branchName, this.agentId);
    } catch (err) {
      throw new Error(`Git worktree creation failed: ${err.message}`);
    }
  }

  /**
   * Clean up worktree after execution. Keep if changes were made.
   */
  async _cleanupWorktree() {
    if (!this._worktreePath) return;

    try {
      // Check if there are any changes in the worktree
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: this._worktreePath,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();

      // Detect default branch dynamically (main, master, etc.)
      let defaultBranch = "main";
      try {
        defaultBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], {
          cwd: this.workspace, encoding: "utf-8", timeout: 5000, stdio: "pipe",
        }).trim().replace("origin/", "");
      } catch (err) {
        debugLog("SubAgent._cleanupWorktree.detectBranch", err);
        try {
          execFileSync("git", ["rev-parse", "--verify", "main"], {
            cwd: this.workspace, encoding: "utf-8", timeout: 5000, stdio: "pipe",
          });
        } catch (err2) {
          debugLog("SubAgent._cleanupWorktree.verifyMain", err2);
          defaultBranch = "master";
        }
      }

      // Check if there are new commits beyond the default branch
      const logOutput = execFileSync("git", ["log", "--oneline", "HEAD", `^${defaultBranch}`], {
        cwd: this._worktreePath,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();

      if (!status && !logOutput) {
        // No changes — clean up
        execFileSync("git", ["worktree", "remove", this._worktreePath, "--force"], {
          cwd: this.workspace,
          encoding: "utf-8",
          timeout: 15000,
        });
        // Delete the temporary branch
        try {
          execFileSync("git", ["branch", "-D", this._worktreeBranch], {
            cwd: this.workspace,
            encoding: "utf-8",
            timeout: 10000,
          });
        } catch (err) { debugLog("SubAgent._cleanupWorktree.deleteBranch", err); }
        this._emit("worktree_cleanup", "No changes — worktree cleaned up");
        // Fire WorktreeRemove hook
        await this._hooks.fireWorktreeRemove(this._worktreePath, this._worktreeBranch, false);
      } else {
        this._emit("worktree_kept", `Worktree preserved at ${this._worktreePath} (branch: ${this._worktreeBranch})`);
        // Fire WorktreeRemove hook (kept=true means changes were made)
        await this._hooks.fireWorktreeRemove(this._worktreePath, this._worktreeBranch, true);
      }
    } catch (err) {
      debugLog("SubAgent._cleanupWorktree", err);
    }
  }

  /**
   * Save agent transcript (messages + metadata) for resume support.
   */
  async _saveTranscript(finalResult) {
    try {
      await mkdir(this._agentDir, { recursive: true });
      const transcript = {
        agentId: this.agentId,
        task: this.task,
        agentType: this.agentDef?.name || "general-purpose",
        turnCount: this._turnCount,
        messages: this.messages,
        finalResult,
        worktree: this._worktreePath ? {
          path: this._worktreePath,
          branch: this._worktreeBranch,
        } : null,
        timestamp: Date.now(),
      };
      await writeFile(this._transcriptPath, JSON.stringify(transcript, null, 2), "utf-8");
    } catch (err) {
      debugLog("SubAgent._saveTranscript", err);
    }
  }

  /**
   * Load a prior transcript for resume.
   * @returns {Promise<boolean>} Whether a transcript was loaded successfully
   */
  async _loadTranscript() {
    try {
      const data = await readFile(this._transcriptPath, "utf-8");
      const transcript = JSON.parse(data);
      this.messages = transcript.messages || [];
      this._turnCount = transcript.turnCount || 0;
      if (transcript.worktree?.path && this._isTrustedWorktreePath(transcript.worktree.path)) {
        this._worktreePath = transcript.worktree.path;
        this._worktreeBranch = transcript.worktree.branch;
        this._effectiveWorkspace = transcript.worktree.path;
        this._toolExecutorOptions.workspace = transcript.worktree.path;
        this.toolExecutor.setWorkspace?.(transcript.worktree.path);
        if (this.sandbox) this.sandbox.setWorkspace?.(transcript.worktree.path);
        this._hooks.setWorkspace?.(transcript.worktree.path);
        this.rollback = new RollbackManager(transcript.worktree.path);
      } else if (transcript.worktree?.path) {
        this._worktreePath = null;
        this._worktreeBranch = null;
      }
      return true;
    } catch (err) {
      debugLog("SubAgent._loadTranscript", err);
      return false;
    }
  }

  async _execute() {
    // Build system prompt: use agent definition's custom prompt if available
    if (this.agentDef?.systemPrompt) {
      this._systemPrompt =
        buildSystemPrompt(this._effectiveWorkspace, this.trustMode) +
        `\n## Agent Role: ${this.agentDef.name}\n\n${this.agentDef.systemPrompt}\n` +
        `\nWorkspace: ${this._effectiveWorkspace}\n` +
        `Note: You cannot spawn further sub-agents.\n`;
    } else {
      this._systemPrompt =
        buildSystemPrompt(this._effectiveWorkspace, this.trustMode) +
        `\n## Sub-Agent Context\n\nYou are a sub-agent spawned by the main agent to handle a specific task. ` +
        `Focus exclusively on completing the assigned task. Be thorough but concise in your final response. ` +
        `Return only the relevant findings or results — the main agent will use your output to continue its work.\n` +
        `Workspace: ${this._effectiveWorkspace}\n` +
        `Note: You have access to core tools (Read, Write, Edit, Bash, Glob, Grep) but cannot spawn further sub-agents.\n`;
    }

    // Resolve tool set based on agent definition + trust mode
    this._tools = this.agentDef
      ? resolveAgentTools(this.agentDef, this.trustMode)
      : resolveAgentTools({ tools: null, disallowedTools: [] }, this.trustMode);

    // Resolve max turns from agent definition or tool call override
    this._maxTurns = this._maxTurnsOverride || this.agentDef?.maxTurns || MAX_SUB_TURNS;

    // Resume: load prior transcript if resuming
    if (this._isResume) {
      const loaded = await this._loadTranscript();
      if (loaded) {
        // Append new task as a follow-up message
        this.messages.push({ role: "user", content: this.task });
        await this.log.append({ role: "user", content: `[RESUMED] ${this.task}` });
        this._emit("thinking", `Resumed agent ${this.agentId} (${this._turnCount} prior turns)...`);
      } else {
        // No transcript found — start fresh
        this.messages = [{ role: "user", content: this.task }];
        await this.log.append({ role: "user", content: this.task });
        this._emit("thinking", "Starting (no prior transcript found)...");
      }
    } else {
      this.messages = [{ role: "user", content: this.task }];
      await this.log.append({ role: "user", content: this.task });
      this._emit("thinking", "Starting...");
    }

    this.rollback.createCheckpoint(this.task.slice(0, 80), this.messages);

    while (this._turnCount < this._maxTurns) {
      // Check abort signal at the start of each turn
      if (this.abortSignal?.aborted) {
        this._emit("done", "Aborted by abort signal");
        return "(sub-agent was aborted)";
      }

      this._turnCount++;

      // Stale tool output trimming (Claude Code pattern — before full compaction)
      try {
        const { trimmed, savedTokens } = trimStaleToolOutputs(this.messages, 3, 400);
        if (trimmed > 0) {
          this._emit("compressing", `Trimmed ${trimmed} stale tool outputs (~${savedTokens} tokens freed)`);
        }
      } catch (err) { debugLog("SubAgent._execute.trimStale", err); }

      // Codex-style context compression with per-agent memory
      try {
        const msgCountBefore = this.messages.length;
        // Fire PreCompact hook before compaction
        await this._hooks.ensureLoaded();
        if (this._hooks.hasHandlers("PreCompact")) {
          await this._hooks.firePreCompact(
            this.messages.length,
            0 // compactionCount not tracked per-agent
          );
        }
        await compressContext(
          this.messages,
          this._systemPrompt,
          this.client,
          this.memory,
          (msg) => this._emit("compressing", msg),
        );
        if (this.messages.length < msgCountBefore) {
          this._emit("compressing", "Context compressed");
        }
      } catch (err) {
        debugLog("SubAgent._execute.compress", err);
      }

      this._emit("thinking", `Turn ${this._turnCount}...`);

      // Check abort signal before making API call
      if (this.abortSignal?.aborted) {
        this._emit("done", "Aborted by abort signal");
        return "(sub-agent was aborted)";
      }

      let response;
      try {
        const apiMessages = [
          { role: "system", content: this._systemPrompt },
          ...this.messages,
        ];
        const apiOpts = {
          tools: this._tools,
          max_tokens: 16000,
          reasoning_effort: "low",
        };
        // Apply model override from agent definition
        if (this._modelOverride) {
          apiOpts.model = this._modelOverride;
        }
        response = await this.client.chatCompletion(apiMessages, apiOpts);
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
        // Log assistant message with tool calls
        await this.log.append({
          role: "assistant",
          content: message.content,
          tool_calls: message.tool_calls.map((tc) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        });

        // ── Parallel tool execution ──
        // Read-only tools can safely run concurrently. Write tools run sequentially
        // to preserve ordering semantics and avoid race conditions.
        const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "listdir", "diff", "lsp", "astsearch"]);

        // Phase 1: Pre-validate all tool calls (hooks, permissions)
        const validatedCalls = [];
        for (const tc of message.tool_calls) {
          const fnName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (err) {
            debugLog("SubAgent._execute.parseArgs", err);
            const errMsg = "Error: Invalid JSON in tool arguments.";
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
            continue;
          }

          // ── PreToolUse hook (can modify input, allow/deny) ──
          const hookResult = await this._hooks.firePreToolUse(fnName, args);
          if (hookResult.action === "deny") {
            const errMsg = `Error: Tool ${fnName} denied by hook: ${hookResult.message || "blocked"}`;
            this._emit("tool_result", `${fnName} denied by hook`);
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
            continue;
          }
          if (hookResult.action === "modify" && hookResult.updatedInput) {
            args = { ...args, ...hookResult.updatedInput };
          }

          // ── Permission rules check ──
          const permCheck = await this._permissions.checkAsync(fnName, args);
          if (permCheck.decision === "deny") {
            const errMsg = `Error: ${fnName} blocked by permission rule: ${permCheck.rule || "denied"}`;
            this._emit("tool_result", `${fnName} blocked`);
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
            continue;
          }
          if (permCheck.updatedInput) {
            args = { ...args, ...permCheck.updatedInput };
          }
          // In sub-agents, "ask" permission = deny (no user to approve)
          if (permCheck.decision === "ask" && hookResult.action !== "allow") {
            // Sub-agents cannot ask for user input - block the operation
            const errMsg = `Error: Tool "${fnName}" requires user approval but sub-agents cannot prompt for it. Denied.`;
            this._emit("tool_result", `${fnName} blocked`);
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
            continue;
          }

          // Block ALL Fetch in sub-agents (approval/acceptEdits/aiSafetyDecide modes) — prevent data exfiltration
          if ((this.trustMode === "approval" || this.trustMode === "acceptEdits" || this.trustMode === "aiSafetyDecide") && fnName.toLowerCase() === "fetch") {
            const errMsg = "Error: Fetch is completely disabled for sub-agents in approval mode (prevents data exfiltration via URL query params or request body).";
            this._emit("tool_result", `${fnName} blocked`);
            this.messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
            continue;
          }

          validatedCalls.push({ tc, fnName, args });
        }

        // Phase 2: Execute tools — parallelize read-only, serialize writes
        // Partition into read-only (parallelizable) and write (sequential) groups
        const readOnlyCalls = validatedCalls.filter(c => READ_ONLY_TOOLS.has(c.fnName.toLowerCase()));
        const writeCalls = validatedCalls.filter(c => !READ_ONLY_TOOLS.has(c.fnName.toLowerCase()));

        // Execute a single validated tool call and return its result
        const executeTool = async ({ tc, fnName, args }) => {
          const toolDetail = _formatToolDetail(fnName, args);
          this._emit("tool_call", `${fnName} ${toolDetail}`);

          const result = await this.toolExecutor.execute(fnName.toLowerCase(), args);
          this._emit("tool_result", `${fnName} done`);

          // ── PostToolUse hook ──
          await this._hooks.firePostToolUse(fnName, args, String(result));
          await this.log.append({ role: "tool", name: fnName, result: String(result) });

          return { tc, result: String(result) };
        };

        // Run read-only tools in parallel (safe — no side effects on workspace)
        if (readOnlyCalls.length > 0) {
          const readResults = await Promise.allSettled(readOnlyCalls.map(executeTool));
          readResults.forEach((settled, i) => {
            if (settled.status === "fulfilled") {
              const { tc, result } = settled.value;
              this.messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: encodeUntrustedToolResult(result),
              });
            } else {
              // Use the correct index to match the right tool_call_id
              this.messages.push({
                role: "tool",
                tool_call_id: readOnlyCalls[i].tc.id,
                content: `Error: Tool execution failed: ${settled.reason?.message || "unknown error"}`,
              });
            }
          });
        }

        // Run write/mutating tools sequentially (order matters)
        for (const call of writeCalls) {
          try {
            const { tc, result } = await executeTool(call);
            this.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: encodeUntrustedToolResult(result),
            });
          } catch (err) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.tc.id,
              content: `Error: Tool execution failed: ${err?.message || "unknown error"}`,
            });
          }
        }

        continue;
      }

      // Final response — log it
      await this.log.append({ role: "assistant", content: message.content });
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
  const { onAgentProgress, workspace, trustMode, sandboxConfig, agentDef, permissionRules, isolation, ...restOptions } = options;
  const defaultIsolation = isolation || (_workspaceSupportsWorktreeIsolation(workspace || process.cwd()) ? "worktree" : null);

  const agents = tasks.map(
    (t, i) =>
      new SubAgent({
        task: typeof t === "string" ? t : t.task,
        ...restOptions,
        workspace,
        trustMode,
        sandboxConfig,
        permissionRules,
        isolation: (typeof t === "object" && t.isolation) ? t.isolation : defaultIsolation,
        agentDef: (typeof t === "object" && t.agentDef) ? t.agentDef : agentDef,
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
