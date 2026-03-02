// Mercury Code - Labs (Experimental Features)
// All new/advanced features live behind labs flags.
// Users enable labs mode first, then toggle individual features.
//
// Usage:
//   /labs              — show all features & status
//   /labs on           — enable labs mode (master switch)
//   /labs off          — disable labs mode (disables all features)
//   /labs <feature>    — toggle a specific feature
//   /labs <feature> on — explicitly enable
//   /labs <feature> off — explicitly disable

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Feature Definitions ──────────────────────────────────────────────────────

/**
 * @typedef {object} LabsFeature
 * @property {string} id       - Unique identifier
 * @property {string} name     - Display name
 * @property {string} category - Category for grouping
 * @property {string} desc     - Short description
 * @property {boolean} default - Default enabled state (within labs mode)
 * @property {string[]} [tools]    - Tool names this feature gates (empty = no tool gating)
 * @property {string[]} [requires] - Other feature ids that must be enabled
 */

/** @type {LabsFeature[]} */
const FEATURES = [
  // ── Agent System ───────────────────────────────────────────────────────
  {
    id: "subagent",
    name: "Sub-Agents",
    category: "Agents",
    desc: "Spawn autonomous sub-agents with isolated context (explore, plan, general-purpose, custom)",
    default: true,
    tools: ["SubAgent"],
  },
  {
    id: "subagent-team",
    name: "Agent Team (Parallel)",
    category: "Agents",
    desc: "Run up to 5 sub-agents in parallel on independent tasks",
    default: true,
    tools: ["SubAgentTeam"],
    requires: ["subagent"],
  },
  {
    id: "agent-resume",
    name: "Agent Resume",
    category: "Agents",
    desc: "Resume a previous sub-agent by agentId — preserves full conversation history",
    default: false,
    tools: [],
    requires: ["subagent"],
  },
  {
    id: "agent-background",
    name: "Agent Background",
    category: "Agents",
    desc: "Run sub-agents in background — returns agentId immediately, check results later",
    default: false,
    tools: [],
    requires: ["subagent"],
  },
  {
    id: "agent-worktree",
    name: "Agent Worktree Isolation",
    category: "Agents",
    desc: "Run sub-agents in isolated git worktrees — changes go to temporary branches",
    default: false,
    tools: [],
    requires: ["subagent"],
  },
  {
    id: "agent-teams",
    name: "Agent Teams (Multi-Process)",
    category: "Agents",
    desc: "Collaborative agent teams with shared task list, mailbox messaging, and lead/teammate roles",
    default: false,
    tools: ["AgentTeams"],
    requires: ["subagent"],
  },

  // NOTE: LSP and AstSearch are core tools (always available, not labs-gated).
  // They are read-only, zero-risk, and fundamental to code intelligence.

  // ── Context & Memory ───────────────────────────────────────────────────
  {
    id: "context-search",
    name: "Context Search",
    category: "Context & Memory",
    desc: "Search compressed conversation history for lost details",
    default: false,
    tools: ["ContextSearch"],
  },
  {
    id: "project-config",
    name: "Project Config (.mercury.md)",
    category: "Context & Memory",
    desc: "Load project-specific instructions from .mercury.md into system prompt",
    default: true,
    tools: [],
  },

  // ── Security & Isolation ───────────────────────────────────────────────
  {
    id: "sandbox",
    name: "Sandbox",
    category: "Security",
    desc: "Sandboxed tool execution — namespace isolation, resource limits, path blocking",
    default: false,
    tools: [],
  },
];

// ── Labs State ───────────────────────────────────────────────────────────────

class Labs {
  constructor() {
    /** Master switch — must be ON for any feature to be active */
    this.enabled = false;
    /** Per-feature overrides: featureId → boolean */
    this._overrides = new Map();
    /** Path to persist state */
    this._configPath = path.join(os.homedir(), ".mercury", "labs.json");
  }

  /**
   * Get the full feature registry.
   * @returns {LabsFeature[]}
   */
  getFeatures() {
    return FEATURES;
  }

  /**
   * Get a single feature by ID.
   * @param {string} id
   * @returns {LabsFeature|undefined}
   */
  getFeature(id) {
    return FEATURES.find((f) => f.id === id);
  }

  /**
   * Check if a specific feature is currently active.
   * Active = labs enabled + feature enabled + dependencies met.
   * @param {string} featureId
   * @returns {boolean}
   */
  isActive(featureId) {
    if (!this.enabled) return false;
    const feature = this.getFeature(featureId);
    if (!feature) return false;

    const featureOn = this._overrides.has(featureId)
      ? this._overrides.get(featureId)
      : feature.default;

    if (!featureOn) return false;

    // Check dependencies
    if (feature.requires) {
      for (const depId of feature.requires) {
        if (!this.isActive(depId)) return false;
      }
    }

    return true;
  }

  /**
   * Check if a specific tool is allowed by labs configuration.
   * Tools not gated by any feature are always allowed.
   * @param {string} toolName
   * @returns {boolean}
   */
  isToolAllowed(toolName) {
    // Find which feature gates this tool
    const feature = FEATURES.find((f) => f.tools?.includes(toolName));
    if (!feature) return true; // Not gated → always allowed
    return this.isActive(feature.id);
  }

  /**
   * Get list of all tool names currently blocked by labs.
   * @returns {string[]}
   */
  getBlockedTools() {
    const blocked = [];
    for (const feature of FEATURES) {
      if (!feature.tools) continue;
      for (const tool of feature.tools) {
        if (!this.isToolAllowed(tool)) {
          blocked.push(tool);
        }
      }
    }
    return blocked;
  }

  /**
   * Toggle a feature on/off.
   * @param {string} featureId
   * @param {boolean} [value] - Explicit value; omit to toggle
   * @returns {{ ok: boolean, message: string }}
   */
  toggle(featureId, value) {
    const feature = this.getFeature(featureId);
    if (!feature) {
      return { ok: false, message: `Unknown feature: "${featureId}"` };
    }

    const current = this._overrides.has(featureId)
      ? this._overrides.get(featureId)
      : feature.default;
    const next = value !== undefined ? value : !current;
    this._overrides.set(featureId, next);

    // If disabling, also disable dependents
    if (!next) {
      for (const dep of FEATURES) {
        if (dep.requires?.includes(featureId)) {
          this._overrides.set(dep.id, false);
        }
      }
    }

    this._save();
    return { ok: true, message: `${feature.name}: ${next ? "ON" : "OFF"}` };
  }

  /**
   * Enable labs master switch.
   */
  enableLabs() {
    this.enabled = true;
    this._save();
  }

  /**
   * Disable labs master switch (all features become inactive).
   */
  disableLabs() {
    this.enabled = false;
    this._save();
  }

  /**
   * Load state from disk.
   */
  async load() {
    try {
      const data = await readFile(this._configPath, "utf-8");
      const state = JSON.parse(data);
      this.enabled = !!state.enabled;
      if (state.overrides && typeof state.overrides === "object") {
        for (const [k, v] of Object.entries(state.overrides)) {
          this._overrides.set(k, !!v);
        }
      }
    } catch {
      // No config file or parse error — use defaults
    }
  }

  /**
   * Persist state to disk.
   */
  async _save() {
    try {
      const dir = path.dirname(this._configPath);
      await mkdir(dir, { recursive: true });
      const state = {
        enabled: this.enabled,
        overrides: Object.fromEntries(this._overrides),
      };
      await writeFile(this._configPath, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // non-critical
    }
  }

  /**
   * Get a snapshot of all features and their states for display.
   * @returns {Array<{id: string, name: string, category: string, desc: string, active: boolean, enabled: boolean, blocked: string|null}>}
   */
  snapshot() {
    return FEATURES.map((f) => {
      const enabled = this._overrides.has(f.id)
        ? this._overrides.get(f.id)
        : f.default;
      const active = this.isActive(f.id);
      let blocked = null;
      if (!this.enabled) blocked = "labs off";
      else if (!enabled) blocked = "disabled";
      else if (f.requires) {
        for (const depId of f.requires) {
          if (!this.isActive(depId)) {
            blocked = `requires ${depId}`;
            break;
          }
        }
      }
      return {
        id: f.id,
        name: f.name,
        category: f.category,
        desc: f.desc,
        active,
        enabled,
        blocked,
        tools: f.tools || [],
      };
    });
  }
}

// Singleton instance
export const labs = new Labs();

// Re-export feature list for external use
export { FEATURES as LAB_FEATURES };
