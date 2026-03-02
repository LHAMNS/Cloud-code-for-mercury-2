// Mercury Code - Permission Rules System
// Modeled after Claude Code's allow/ask/deny permission rules.
//
// Permission rules control which tool operations are allowed, denied,
// or require user approval. Rules are evaluated in order:
//   1. deny rules are checked first — if any match, operation is blocked
//   2. allow rules are checked next — if any match, operation proceeds
//   3. If no rule matches, fall through to the trust mode default
//
// Rule format:
//   "ToolName"               — matches all uses of that tool
//   "ToolName(specifier)"    — matches tool with specific argument pattern
//   "Bash(git *)"            — matches Bash commands starting with "git "
//   "Bash(npm test)"         — matches exact command "npm test"
//   "Write(src/**)"          — matches Write to files in src/
//   "Read(*)"                — matches all Read operations
//
// Configuration:
//   .mercury/permissions.json or ~/.mercury/permissions.json
//   {
//     "allow": ["Read", "Glob", "Grep", "Bash(git *)"],
//     "ask":   ["Write", "Edit", "Bash"],
//     "deny":  ["Bash(rm -rf *)", "Bash(curl *)"]
//   }

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Permission Results ───────────────────────────────────────────────────────

export const PERMISSION_ALLOW = "allow";
export const PERMISSION_ASK = "ask";
export const PERMISSION_DENY = "deny";

// ── PermissionManager ────────────────────────────────────────────────────────

export class PermissionManager {
  /**
   * @param {object} [options]
   * @param {string} [options.workspace] - Project root
   * @param {string} [options.trustMode] - Base trust mode: 'readonly', 'approval', 'open'
   */
  constructor(options = {}) {
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || "approval";

    /** @type {string[]} Rules that auto-allow */
    this.allowRules = [];
    /** @type {string[]} Rules that require user approval */
    this.askRules = [];
    /** @type {string[]} Rules that block entirely */
    this.denyRules = [];

    this._loaded = false;
  }

  /**
   * Load permission rules from project and global config.
   * Project rules are merged with (and can override) global rules.
   */
  async load() {
    this.allowRules = [];
    this.askRules = [];
    this.denyRules = [];

    // 1. Global: ~/.mercury/permissions.json
    const globalPath = path.join(os.homedir(), ".mercury", "permissions.json");
    await this._loadFromFile(globalPath);

    // 2. Project: .mercury/permissions.json
    const projectPath = path.join(this.workspace, ".mercury", "permissions.json");
    await this._loadFromFile(projectPath);

    this._loaded = true;
  }

  /**
   * Load rules from a JSON file.
   */
  async _loadFromFile(filePath) {
    try {
      const data = await readFile(filePath, "utf-8");
      const config = JSON.parse(data);

      if (Array.isArray(config.allow)) {
        this.allowRules.push(...config.allow);
      }
      if (Array.isArray(config.ask)) {
        this.askRules.push(...config.ask);
      }
      if (Array.isArray(config.deny)) {
        this.denyRules.push(...config.deny);
      }
    } catch {
      // File doesn't exist or invalid — OK
    }
  }

  /**
   * Check the permission for a tool call.
   *
   * @param {string} toolName - The tool being called (e.g., "Bash", "Write")
   * @param {object} toolInput - The tool's input arguments
   * @returns {{ decision: string, rule?: string }}
   *   decision: 'allow' | 'ask' | 'deny'
   *   rule: the matching rule string (if any)
   */
  check(toolName, toolInput = {}) {
    // 1. Check deny rules first (highest priority)
    for (const rule of this.denyRules) {
      if (this._matches(rule, toolName, toolInput)) {
        return { decision: PERMISSION_DENY, rule };
      }
    }

    // 2. Check allow rules
    for (const rule of this.allowRules) {
      if (this._matches(rule, toolName, toolInput)) {
        return { decision: PERMISSION_ALLOW, rule };
      }
    }

    // 3. Check ask rules
    for (const rule of this.askRules) {
      if (this._matches(rule, toolName, toolInput)) {
        return { decision: PERMISSION_ASK, rule };
      }
    }

    // 4. Fall through to trust mode defaults
    return this._trustModeDefault(toolName);
  }

  /**
   * Get the default permission based on trustMode.
   * @param {string} toolName
   * @returns {{ decision: string }}
   */
  _trustModeDefault(toolName) {
    switch (this.trustMode) {
      case "open":
        return { decision: PERMISSION_ALLOW };

      case "readonly": {
        const readOnlyTools = new Set([
          "Read", "Glob", "Grep", "ListDir", "Diff", "Lsp", "AstSearch",
        ]);
        if (readOnlyTools.has(toolName)) {
          return { decision: PERMISSION_ALLOW };
        }
        // Fetch GET is allowed in readonly
        if (toolName === "Fetch") {
          return { decision: PERMISSION_ASK };
        }
        return { decision: PERMISSION_DENY };
      }

      case "approval":
      default: {
        const alwaysAllowed = new Set([
          "Read", "Glob", "Grep", "ListDir", "Diff", "Lsp", "AstSearch",
        ]);
        if (alwaysAllowed.has(toolName)) {
          return { decision: PERMISSION_ALLOW };
        }
        return { decision: PERMISSION_ASK };
      }
    }
  }

  // ── Rule Matching ────────────────────────────────────────────────────────

  /**
   * Check if a rule matches a tool call.
   *
   * Rule formats:
   *   "ToolName"            — matches all calls to that tool
   *   "ToolName(*)"         — same as above
   *   "ToolName(specifier)" — matches if the specifier matches the tool's primary argument
   *
   * Specifier matching by tool:
   *   Bash:  matches against the command string
   *   Write/Edit/Patch/Read: matches against file_path (glob pattern)
   *   Fetch: matches against the URL
   *   Glob:  matches against the glob pattern
   *   Grep:  matches against the search pattern
   *
   * @param {string} rule
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {boolean}
   */
  _matches(rule, toolName, toolInput) {
    // Parse rule: "ToolName" or "ToolName(specifier)"
    const parenIdx = rule.indexOf("(");
    let ruleToolName, specifier;

    if (parenIdx === -1) {
      ruleToolName = rule.trim();
      specifier = null;
    } else {
      ruleToolName = rule.slice(0, parenIdx).trim();
      // Extract specifier, removing trailing ")"
      specifier = rule.slice(parenIdx + 1, -1).trim();
    }

    // Tool name must match (case-insensitive)
    if (ruleToolName.toLowerCase() !== toolName.toLowerCase()) {
      return false;
    }

    // No specifier = match all uses of this tool
    if (!specifier || specifier === "*") {
      return true;
    }

    // Match specifier against the tool's primary argument
    const primaryArg = this._getPrimaryArg(toolName, toolInput);
    if (!primaryArg) return false;

    return this._globMatch(specifier, primaryArg);
  }

  /**
   * Get the primary argument for a tool (used for specifier matching).
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {string|null}
   */
  _getPrimaryArg(toolName, toolInput) {
    switch (toolName.toLowerCase()) {
      case "bash":
        return toolInput.command || null;
      case "write":
      case "read":
      case "edit":
      case "patch":
        return toolInput.file_path || null;
      case "fetch":
        return toolInput.url || null;
      case "glob":
        return toolInput.pattern || null;
      case "grep":
        return toolInput.pattern || null;
      case "subagent":
        return toolInput.agent_type || toolInput.task || null;
      default:
        return null;
    }
  }

  /**
   * Simple glob-like pattern matching.
   * Supports: * (matches anything), ** (same as * for paths), ? (single char)
   * For Bash commands and non-path contexts, * matches any characters.
   * @param {string} pattern
   * @param {string} str
   * @returns {boolean}
   */
  _globMatch(pattern, str) {
    // Convert glob to regex
    let regex = "^";
    let i = 0;
    while (i < pattern.length) {
      const ch = pattern[i];
      if (ch === "*") {
        // Both * and ** match anything (including / and spaces)
        // This is important for command matching like "rm -rf *"
        if (pattern[i + 1] === "*") {
          regex += ".*";
          i += 2;
          if (pattern[i] === "/") i++; // skip **/ separator
        } else {
          regex += ".*";
          i++;
        }
      } else if (ch === "?") {
        regex += ".";
        i++;
      } else if (".+^${}()|[]\\".includes(ch)) {
        regex += "\\" + ch;
        i++;
      } else {
        regex += ch;
        i++;
      }
    }
    regex += "$";

    try {
      return new RegExp(regex).test(str);
    } catch {
      // Invalid regex — fallback to simple includes
      return str.includes(pattern);
    }
  }

  /**
   * Export rules for passing to sub-agents.
   * @returns {object}
   */
  toConfig() {
    return {
      allow: [...this.allowRules],
      ask: [...this.askRules],
      deny: [...this.denyRules],
    };
  }

  /**
   * Import rules from a config object (e.g., from parent agent).
   * @param {object} config
   */
  fromConfig(config) {
    if (config.allow) this.allowRules = [...config.allow];
    if (config.ask) this.askRules = [...config.ask];
    if (config.deny) this.denyRules = [...config.deny];
    this._loaded = true;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _globalPermissions = null;

/**
 * Get or create the global permission manager.
 * @param {object} [options]
 * @returns {PermissionManager}
 */
export function getPermissionManager(options) {
  if (!_globalPermissions || (options?.workspace && _globalPermissions.workspace !== options.workspace)) {
    _globalPermissions = new PermissionManager(options);
  }
  return _globalPermissions;
}

/**
 * Initialize permissions (load config files).
 * @param {string} workspace
 * @param {string} trustMode
 * @returns {Promise<PermissionManager>}
 */
export async function initPermissions(workspace, trustMode) {
  const pm = getPermissionManager({ workspace, trustMode });
  await pm.load();
  return pm;
}
