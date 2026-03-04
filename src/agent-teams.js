// Mercury Code - Agent Teams (Multi-Process Collaborative Agents)
// Based on Claude Code's experimental Agent Teams architecture.
//
// Architecture:
//   Team Lead: the main Mercury session — creates team, spawns teammates, coordinates
//   Teammates: separate SubAgent instances, each with own context window
//   Task List: shared list of work items that teammates claim and complete
//   Mailbox:   message-passing system for inter-agent communication
//
// Key concepts:
//   - Tasks have states: pending → in_progress → completed
//   - Tasks can declare dependencies on other tasks
//   - Teammates self-claim the next available task after finishing one
//   - Lead can message individual teammates or broadcast to all
//   - File-based persistence for crash recovery

import { SubAgent } from "./subagent.js";
import { getHooksManager } from "./hooks.js";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";

// ── Task States ──────────────────────────────────────────────────────────────

const TASK_PENDING = "pending";
const TASK_IN_PROGRESS = "in_progress";
const TASK_COMPLETED = "completed";

// ── AgentTeam ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TeamTask
 * @property {string} id       - Unique task ID
 * @property {string} title    - Short description
 * @property {string} detail   - Full task prompt for the agent
 * @property {string} status   - pending | in_progress | completed
 * @property {string|null} assignee   - Teammate ID currently working on it
 * @property {string[]} depends      - Task IDs that must complete first
 * @property {string|null} result    - Result when completed
 * @property {number} createdAt
 * @property {number|null} completedAt
 */

/**
 * @typedef {object} TeamMessage
 * @property {string} from     - Sender agent ID (or "lead")
 * @property {string} to       - Recipient agent ID (or "all" for broadcast)
 * @property {string} content  - Message text
 * @property {number} ts       - Timestamp
 */

/**
 * @typedef {object} Teammate
 * @property {string} id       - Agent ID
 * @property {string} name     - Display name
 * @property {SubAgent} agent  - SubAgent instance
 * @property {string} status   - idle | working | done
 * @property {string|null} currentTaskId
 */

export class AgentTeam {
  /**
   * @param {object} options
   * @param {string} options.teamName - Unique team name
   * @param {string} [options.workspace] - Project root
   * @param {object} [options.agentOptions] - Shared options for SubAgent construction
   * @param {Function} [options.onEvent] - Event callback: (event, detail) => void
   */
  constructor(options = {}) {
    this.teamName = options.teamName || `team-${Date.now().toString(36)}`;
    this.workspace = options.workspace || process.cwd();
    this._agentOptions = options.agentOptions || {};
    this._onEvent = options.onEvent || null;

    // Hooks manager for lifecycle events
    this._hooks = getHooksManager(this.workspace);

    // Team data directory
    this._teamDir = path.join(this.workspace, ".mercury", "teams", this.teamName);

    /** @type {Map<string, TeamTask>} */
    this.tasks = new Map();

    /** @type {Map<string, Teammate>} */
    this.teammates = new Map();

    /** @type {TeamMessage[]} */
    this.mailbox = [];

    this._taskIdCounter = 0;
    this._running = false;
  }

  // ── Event emitter ────────────────────────────────────────────────────────

  _emit(event, detail) {
    if (this._onEvent) {
      try { this._onEvent(event, detail); } catch { /* */ }
    }
  }

  // ── Task Management ──────────────────────────────────────────────────────

  /**
   * Add a task to the shared task list.
   * @param {object} taskDef
   * @param {string} taskDef.title
   * @param {string} taskDef.detail
   * @param {string[]} [taskDef.depends] - IDs of tasks this depends on
   * @returns {TeamTask}
   */
  addTask(taskDef) {
    if (this.tasks.size >= 1000) {
      throw new Error('Maximum task limit (1000) reached');
    }
    this._taskIdCounter++;
    const task = {
      id: `task-${this._taskIdCounter}`,
      title: taskDef.title,
      detail: taskDef.detail,
      status: TASK_PENDING,
      assignee: null,
      depends: taskDef.depends || [],
      result: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    // Check for circular dependencies
    if (taskDef.depends && taskDef.depends.length > 0) {
      const visited = new Set();
      const checkCycle = (id) => {
        if (id === task.id) return true; // Cycle detected
        if (visited.has(id)) return false;
        visited.add(id);
        const depTask = this.tasks.get(id);
        if (!depTask || !depTask.depends) return false;
        return depTask.depends.some(d => checkCycle(d));
      };
      for (const depId of taskDef.depends) {
        if (depId === task.id || checkCycle(depId)) {
          throw new Error(`Circular dependency detected: task "${task.id}" and "${depId}"`);
        }
      }
    }
    this.tasks.set(task.id, task);
    this._emit("task_added", { taskId: task.id, title: task.title });
    this._persist();
    return task;
  }

  /**
   * Get the next available (unblocked, unassigned) task.
   * @returns {TeamTask|null}
   */
  getNextTask() {
    for (const task of this.tasks.values()) {
      if (task.status !== TASK_PENDING) continue;

      // Check if all dependencies are completed (and not errored)
      const depsComplete = task.depends.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === TASK_COMPLETED && !dep.error;
      });
      if (!depsComplete) continue;

      return task;
    }
    return null;
  }

  /**
   * Claim a task for a teammate.
   * @param {string} taskId
   * @param {string} teammateId
   * @returns {boolean}
   */
  claimTask(taskId, teammateId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TASK_PENDING) return false;

    task.status = TASK_IN_PROGRESS;
    task.assignee = teammateId;
    this._emit("task_claimed", { taskId, teammateId });
    this._persist();
    return true;
  }

  /**
   * Mark a task as completed.
   * @param {string} taskId
   * @param {string} result
   */
  async completeTask(taskId, result, isError = false) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = TASK_COMPLETED;
    task.result = result;
    task.error = isError;
    task.completedAt = Date.now();
    this._emit("task_completed", { taskId, title: task.title, error: isError });
    this._persist();

    // Fire TaskCompleted hook
    await this._hooks.fireTaskCompleted(taskId, result, isError);
  }

  /**
   * Get task summary for display.
   */
  getTaskSummary() {
    const pending = [];
    const inProgress = [];
    const completed = [];
    for (const task of this.tasks.values()) {
      if (task.status === TASK_PENDING) pending.push(task);
      else if (task.status === TASK_IN_PROGRESS) inProgress.push(task);
      else completed.push(task);
    }
    return { pending, inProgress, completed, total: this.tasks.size };
  }

  // ── Teammate Management ──────────────────────────────────────────────────

  /**
   * Spawn a new teammate.
   * @param {object} opts
   * @param {string} opts.name - Display name
   * @param {object} [opts.agentDef] - Agent definition override
   * @returns {Teammate}
   */
  spawnTeammate(opts = {}) {
    const id = `mate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const name = opts.name || `Teammate ${this.teammates.size + 1}`;

    const agent = new SubAgent({
      task: "", // Set when task is assigned
      ...this._agentOptions,
      workspace: this.workspace,
      agentId: id,
      agentDef: opts.agentDef || null,
      permissionRules: this._agentOptions.permissionRules || null,
      onProgress: (event, detail) => {
        this._emit("teammate_progress", { id, name, event, detail });
      },
    });

    const teammate = {
      id,
      name,
      agent,
      status: "idle",
      currentTaskId: null,
    };

    this.teammates.set(id, teammate);
    this._emit("teammate_spawned", { id, name });
    return teammate;
  }

  /**
   * Shut down a teammate.
   * @param {string} teammateId
   */
  shutdownTeammate(teammateId) {
    const mate = this.teammates.get(teammateId);
    if (!mate) return;
    mate.status = "done";
    this._emit("teammate_shutdown", { id: teammateId, name: mate.name });
    this.teammates.delete(teammateId);
  }

  // ── Mailbox (Inter-Agent Communication) ────────────────────────────────

  /**
   * Send a message to a specific teammate.
   * @param {string} from - Sender ID or "lead"
   * @param {string} to   - Recipient ID
   * @param {string} content
   */
  sendMessage(from, to, content) {
    if (this.mailbox.length >= 5000) {
      return; // Silently drop messages when mailbox is full
    }
    const msg = { from, to, content, ts: Date.now() };
    this.mailbox.push(msg);
    this._emit("message_sent", msg);
    this._persist();
  }

  /**
   * Broadcast a message to all teammates.
   * @param {string} from
   * @param {string} content
   */
  broadcast(from, content) {
    if (this.mailbox.length >= 5000) {
      return; // Silently drop messages when mailbox is full
    }
    // Send a single "all" message so getMessages() can find it
    const msg = { from, to: "all", content, ts: Date.now() };
    this.mailbox.push(msg);
    this._emit("message_sent", msg);
    this._persist();
  }

  /**
   * Get unread messages for a specific agent.
   * @param {string} agentId
   * @param {number} [since] - Only messages after this timestamp
   * @returns {TeamMessage[]}
   */
  getMessages(agentId, since = 0) {
    return this.mailbox.filter(
      (m) => (m.to === agentId || m.to === "all") && m.ts > since
    );
  }

  // ── Team Execution ─────────────────────────────────────────────────────

  /**
   * Run the team: assign tasks to idle teammates and execute until all tasks done.
   * @returns {Promise<Map<string, string>>} taskId → result
   */
  async run() {
    this._running = true;
    this._emit("team_start", { teamName: this.teamName, tasks: this.tasks.size, teammates: this.teammates.size });

    const MAX_RUN_TIMEOUT = 600000; // 10 minutes max
    const runStart = Date.now();

    const results = new Map();

    while (this._running) {
      if (Date.now() - runStart > MAX_RUN_TIMEOUT) {
        this.stop();
        break;
      }
      // Check if all tasks are done
      const summary = this.getTaskSummary();
      if (summary.pending.length === 0 && summary.inProgress.length === 0) {
        break;
      }

      // Assign tasks to idle teammates
      const assignments = [];
      for (const [id, mate] of this.teammates) {
        if (mate.status !== "idle") continue;

        const task = this.getNextTask();
        if (!task) break;

        this.claimTask(task.id, id);
        mate.status = "working";
        mate.currentTaskId = task.id;

        // Build context for the teammate
        const teamContext = this._buildTeammateContext(id, task);
        mate.agent.task = teamContext;

        assignments.push(
          mate.agent.run().then(
            async (result) => {
              await this.completeTask(task.id, result);
              results.set(task.id, result);
              mate.status = "idle";
              mate.currentTaskId = null;
              this._emit("teammate_idle", { id, name: mate.name });
              // Fire TeammateIdle hook
              await this._hooks.fireTeammateIdle(id, mate.name);
            },
            async (err) => {
              const errMsg = `Error: ${err.message}`;
              await this.completeTask(task.id, errMsg, true);
              results.set(task.id, errMsg);
              mate.status = "idle";
              mate.currentTaskId = null;
              this._emit("teammate_idle", { id, name: mate.name });
              // Fire TeammateIdle hook
              await this._hooks.fireTeammateIdle(id, mate.name);
            }
          )
        );
      }

      if (assignments.length > 0) {
        // Wait for at least one assignment to complete
        await Promise.race(assignments);
      } else {
        // No idle teammates and tasks are still pending — wait a bit
        // This happens when all teammates are working
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    this._emit("team_done", { results: results.size });
    return results;
  }

  /**
   * Stop the team execution loop.
   */
  stop() {
    this._running = false;
    this._emit("team_stop", {});
  }

  /**
   * Build the context string for a teammate's task, including relevant messages.
   */
  _buildTeammateContext(teammateId, task) {
    const lines = [];
    lines.push(`## Task: ${task.title}`);
    lines.push("");
    lines.push(task.detail);
    lines.push("");

    // Include dependency results
    if (task.depends.length > 0) {
      lines.push("## Results from prerequisite tasks:");
      for (const depId of task.depends) {
        const dep = this.tasks.get(depId);
        if (dep?.result) {
          lines.push(`\n### ${dep.title}:`);
          lines.push(`[DEP_RESULT_BEGIN]\n${dep.result}\n[DEP_RESULT_END]`);
        }
      }
      lines.push("");
    }

    // Include recent messages to this teammate
    const messages = this.getMessages(teammateId, Date.now() - 300000); // Last 5 min
    if (messages.length > 0) {
      lines.push("## Messages from team:");
      for (const msg of messages) {
        const sender = msg.from === "lead" ? "Team Lead" : this.teammates.get(msg.from)?.name || msg.from;
        lines.push(`[${sender}]: [MESSAGE_BEGIN]\n${msg.content}\n[MESSAGE_END]`);
      }
      lines.push("");
    }

    lines.push(`\nYou are ${this.teammates.get(teammateId)?.name || teammateId}, part of team "${this.teamName}".`);
    lines.push("Focus on completing your assigned task. Be thorough and return your findings.");

    return lines.join("\n");
  }

  // ── Persistence ────────────────────────────────────────────────────────

  async _persist() {
    try {
      await mkdir(this._teamDir, { recursive: true });
      const state = {
        teamName: this.teamName,
        tasks: [...this.tasks.entries()],
        mailbox: this.mailbox,
        taskIdCounter: this._taskIdCounter,
        timestamp: Date.now(),
      };
      await writeFile(
        path.join(this._teamDir, "state.json"),
        JSON.stringify(state, null, 2),
        "utf-8"
      );
    } catch {
      // non-critical
    }
  }

  /**
   * Load team state from disk.
   */
  async load() {
    try {
      const data = await readFile(path.join(this._teamDir, "state.json"), "utf-8");
      const state = JSON.parse(data);
      // Validate state structure
      if (!Array.isArray(state.tasks) || !Array.isArray(state.mailbox)) {
        return; // Invalid state, start fresh
      }
      this.tasks = new Map(state.tasks.filter(([id, t]) => typeof id === 'string' && t && typeof t.status === 'string'));
      this.mailbox = state.mailbox.filter(m => m && typeof m.content === 'string');
      this._taskIdCounter = state.taskIdCounter || 0;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up team data.
   */
  async cleanup() {
    try {
      await rm(this._teamDir, { recursive: true, force: true });
    } catch {
      // non-critical
    }
  }
}

// ── Tool handler for AgentTeams ──────────────────────────────────────────────

/**
 * Execute an AgentTeams tool call.
 * @param {object} args
 * @param {object} executorOptions - Options from the ToolExecutor
 * @returns {Promise<string>}
 */
export async function executeAgentTeams(args, executorOptions = {}) {
  const { action } = args;

  if (!action) {
    return 'Error: action is required. Options: create, add_task, spawn_teammate, message, broadcast, run, status, shutdown';
  }

  switch (action) {
    case "create": {
      if (_activeTeams.size >= 10) {
        return 'Error: Maximum 10 concurrent teams allowed. Shut down an existing team first.';
      }
      if (_activeTeams.has(args.team_name)) {
        return `Error: Team "${args.team_name}" already exists. Use a different name or shut down the existing team.`;
      }
      const team = new AgentTeam({
        teamName: args.team_name,
        workspace: executorOptions.workspace,
        agentOptions: {
          apiKey: executorOptions.apiKey,
          baseURL: executorOptions.baseURL,
          trustMode: executorOptions.trustMode,
          sandboxConfig: executorOptions.sandboxConfig,
          permissionRules: executorOptions.permissionRules || null,
        },
        onEvent: executorOptions.onTeamEvent,
      });
      // Store globally
      _activeTeams.set(team.teamName, team);
      return `Team "${team.teamName}" created. Use add_task to define work, spawn_teammate to add agents, then run.`;
    }

    case "add_task": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found. Create it first.`;
      const task = team.addTask({
        title: args.title || "Untitled task",
        detail: args.detail || args.title || "",
        depends: args.depends || [],
      });
      return `Task "${task.id}" added: ${task.title}`;
    }

    case "spawn_teammate": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found.`;
      if (team.teammates.size >= 10) {
        return `Error: Maximum 10 teammates per team. Shut down existing teammates first.`;
      }
      const mate = team.spawnTeammate({
        name: args.name,
        agentDef: args.agent_def,
      });
      return `Teammate "${mate.name}" (${mate.id}) spawned.`;
    }

    case "message": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found.`;
      team.sendMessage(args.from || "lead", args.to, args.content);
      return `Message sent to ${args.to}.`;
    }

    case "broadcast": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found.`;
      team.broadcast(args.from || "lead", args.content);
      return `Broadcast sent to all teammates.`;
    }

    case "run": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found.`;

      const results = await team.run();
      const lines = [`Team "${team.teamName}" completed. Results:`];
      for (const [taskId, result] of results) {
        const task = team.tasks.get(taskId);
        lines.push(`\n### ${task?.title || taskId}:`);
        lines.push(typeof result === "string" ? result.slice(0, 2000) : String(result));
      }
      return lines.join("\n");
    }

    case "status": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found.`;
      const summary = team.getTaskSummary();
      const lines = [
        `Team: ${team.teamName}`,
        `Tasks: ${summary.total} total — ${summary.pending.length} pending, ${summary.inProgress.length} in progress, ${summary.completed.length} completed`,
        `Teammates: ${team.teammates.size}`,
      ];
      for (const [id, mate] of team.teammates) {
        lines.push(`  - ${mate.name} (${id}): ${mate.status}${mate.currentTaskId ? ` → ${mate.currentTaskId}` : ""}`);
      }
      return lines.join("\n");
    }

    case "shutdown": {
      const team = _activeTeams.get(args.team_name);
      if (!team) return `Error: Team "${args.team_name}" not found.`;
      team.stop();
      for (const [id] of team.teammates) {
        team.shutdownTeammate(id);
      }
      // Clean up persisted state files
      team.cleanup();
      _activeTeams.delete(args.team_name);
      return `Team "${args.team_name}" shut down.`;
    }

    default:
      return `Error: Unknown action "${action}". Options: create, add_task, spawn_teammate, message, broadcast, run, status, shutdown`;
  }
}

/** Active teams indexed by name */
const _activeTeams = new Map();

/**
 * Get an active team by name.
 * @param {string} teamName
 * @returns {AgentTeam|null}
 */
export function getTeam(teamName) {
  return _activeTeams.get(teamName) || null;
}

/**
 * List all active teams.
 * @returns {string[]}
 */
export function listTeams() {
  return [..._activeTeams.keys()];
}
