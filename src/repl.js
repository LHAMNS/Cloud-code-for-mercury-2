// Mercury Code - REPL (Read-Eval-Print Loop)
// Handles user input, sends messages to Mercury-2, processes tool calls,
// and displays results. Includes Codex-style framing, permission system,
// auto-recovery, session history, rollback, and ESC undo.

import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync as _execSync, execFileSync as _execFileSync, spawnSync as _spawnSync } from "node:child_process";
import { MercuryClient } from "./client.js";
import { Conversation } from "./conversation.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { REASONING_LEVELS, MODEL_LIMITS, normalizeClientConfig } from "./config.js";
import { getModelLimits } from "./providers.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { ToolExecutor } from "./tools/executor.js";
import { MemoryManager, ConversationLog } from "./memory.js";
import { SessionHistory } from "./history.js";
import { RollbackManager } from "./rollback.js";
import { Sandbox, SANDBOX_OFF, SANDBOX_ON, SANDBOX_STRICT, SANDBOX_MODES } from "./sandbox.js";
import { AiSafetyDecider } from "./ai-safety-decide.js";
import { ActionSafetyLead, ACTION_DENY, ACTION_ESCALATE, ACTION_TERMINATE } from "./action-safety-lead.js";
import { ContextSentinel, VERDICT_SAFE, VERDICT_SUSPICIOUS, VERDICT_BLOCKED } from "./context-sentinel.js";
import { TaintTracker, TAINT_WORKSPACE_UNTRUSTED } from "./taint-tracker.js";
import { discoverAgents, formatAgentList, scaffoldAgent } from "./agent-definitions.js";
import { loadProjectConfig, findProjectConfig, scaffoldProjectConfig } from "./project-config.js";
import { setProjectConfig, getUntrustedProjectConfig } from "./system-prompt.js";
import { initPermissions } from "./permissions.js";
import { labs } from "./labs.js";
import { encodeUntrustedToolResult } from "./untrusted-content.js";
import {
  printWelcome,
  printHelp,
  printToolCall,
  printToolResult,
  printError,
  printInfo,
  printSuccess,
  printTokenUsage,
  printStreamChunk,
  printStreamEnd,
  TerminalMarkdownRenderer,
  printResponseHeader,
  printResponseFooter,
  printWarning,
  printRollbackUI,
  printRollbackConfirm,
  printSessionList,
  renderContextGauge,
  printPlanModeBanner,
  printMcpStatus,
  printEditableLogo,
  playMercuryColdEasterEgg,
  spinner,
  AutocompleteWidget,
} from "./ui/display.js";
import { McpManager } from "./mcp.js";
import { getHooksManager } from "./hooks.js";
import { SkillManager } from "./skills.js";
import { CommandRouter } from "./command-router.js";
import { isInWorkspace } from "./utils/path-safety.js";
import {
  ESC, RESET, BOLD, DIM, ITALIC, CYAN, GRAY, YELLOW, GREEN, RED,
} from "./utils/colors.js";
import { debugLog } from "./utils/debug-log.js";

// Maximum agentic tool-call turns before forcing a stop
const MAX_TOOL_TURNS = 100;
// Maximum auto-recovery attempts for truncated output
const MAX_AUTO_RECOVER = 3;
// ESC detection: triple-press within this window triggers rollback
const ESC_WINDOW_MS = 800;
// Long paste threshold: inputs longer than this get collapsed in display
const PASTE_COLLAPSE_THRESHOLD = 200;

// Trust modes (5-mode system matching Claude Code)
const TRUST_READONLY = "readonly";
const TRUST_APPROVAL = "approval";
const TRUST_ACCEPT_EDITS = "acceptEdits";
const TRUST_OPEN = "open";
const TRUST_DONT_ASK = "dontAsk";
const TRUST_AI_SAFETY_DECIDE = "aiSafetyDecide";
const TRUST_PLAN = "plan"; // alias for readonly + plan file output

// Read-only tools (allowed in all modes). Fetch is handled separately due to POST restrictions.
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "ListDir", "Diff"]);
// Write tools (need checking in approval mode)
const WRITE_TOOLS = new Set(["Write", "Edit", "Patch"]);

export class MercuryRepl {
  constructor(options = {}) {
    // Pass provider and model through to the client
    const clientOpts = { ...options };
    if (options.provider) clientOpts.provider = options.provider;
    if (options.model) clientOpts.model = options.model;
    this.client = new MercuryClient(clientOpts);
    this.verbose = options.verbose || false;
    this.superCompress = false;
    this.contextSearchEnabled = false;
    this._rl = null;
    this._toolTurnCount = 0;
    this._processing = false;
    /** @type {string[]} Buffer for multiline input (Ctrl+J) */
    this._multilineBuffer = [];
    this._inMultilineMode = false;
    this._sessionId = this._generateSessionId();
    this.skipStartupFlow = options.skipStartupFlow === true;
    this.webBridgeMode = options.webBridgeMode === true || process.env.MERCURY_WEB_CHILD === "1";
    this._sigintHandler = null;
    this._keypressHandler = null;
    this._exiting = false;

    // Workspace and trust
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || TRUST_APPROVAL;
    this.planMode = options.trustMode === TRUST_PLAN || options.trustMode === "plan";
    if (this.planMode) this.trustMode = TRUST_READONLY;
    this.allowOutsideWorkspace = false;
    this.allowProjectHooks = options.allowProjectHooks === true || process.env.MERCURY_ALLOW_PROJECT_HOOKS === "1";
    this.allowProjectMcp = options.allowProjectMcp === true || process.env.MERCURY_ALLOW_PROJECT_MCP === "1";
    this._hooksSessionWorkspace = null;

    // MCP and Skills
    this.mcpManager = new McpManager();
    this.skillManager = new SkillManager();
    this.hooks = getHooksManager(this.workspace, {
      allowProjectHooks: this.allowProjectHooks,
      onInfo: (msg) => printInfo(msg),
    });
    this._mcpConfigPath = options.mcpConfigPath || null;
    this.permissionManager = null;

    // UI preferences
    this.showPlanet = options.showPlanet === true; // default: OFF (classic text logo)

    // Sandbox: default ON for main agent and all sub-agents
    this.sandbox = new Sandbox({
      mode: options.sandboxMode || SANDBOX_ON,
      workspace: this.workspace,
      sandboxSubAgents: options.sandboxSubAgents !== false,
      allowNetwork: options.sandboxAllowNetwork !== false,
    });

    // ToolExecutor receives workspace + trustMode + sandbox for enforcement
    this.toolExecutor = new ToolExecutor({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      workspace: this.workspace,
      trustMode: this.trustMode,
      sandbox: this.sandbox,
      allowProjectHooks: this.allowProjectHooks,
    });

    // Command router: dispatches slash commands (/help, /trust, etc.)
    this._commandRouter = new CommandRouter(this);

    // Keep trust-dependent helpers synchronized through _syncTrustModeState()
    // so later mode changes cannot leave runtime state stale.
    this._aiSafetyDecider = null;

    // Context Sentinel: independent prompt injection firewall
    // Enabled by default in non-open trust modes; can be toggled via /sentinel
    this._contextSentinel = new ContextSentinel({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      enabled: options.sentinelEnabled !== false && process.env.MERCURY_SENTINEL !== "0",
      mode: options.sentinelMode || process.env.MERCURY_SENTINEL_MODE || "warn",
      timeout: 10000,
      onVerdict: (detail) => {
        debugLog("ContextSentinel.verdict", `${detail.verdict} (${detail.source}) — ${detail.reason}`);
      },
      onInfo: (msg) => printInfo(msg),
    });

    this._actionSafetyLead = new ActionSafetyLead({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      enabled: options.actionSafetyEnabled !== false && process.env.MERCURY_ACTION_SAFETY !== "0",
      timeout: 10000,
      onInfo: (msg) => printInfo(msg),
    });

    // Taint tracker: tracks provenance of untrusted content in the conversation
    this._taintTracker = new TaintTracker();

    // These will be initialized after workspace is chosen
    this.memory = null;
    this.log = null;
    this.conversation = null;
    this.history = new SessionHistory({ dir: options.historyDir });
    this.rollback = null;

    // ESC tracking
    this._escPresses = [];
    this._inRollbackMode = false;

    // Easter egg: double-tap Enter on empty prompt
    this._lastEmptyEnterTime = 0;
    this._inLogoEditMode = false;

    this._syncTrustModeState();
  }

  _generateSessionId() {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6)
    );
  }

  // ── Interactive mode ─────────────────────────────────────────────────────

  async start() {
    const SLASH_CMDS = [
      "/help", "/clear", "/trust", "/workspace", "/reasoning",
      "/supercompress", "/contextsearch", "/sandbox", "/history",
      "/context", "/settings", "/config", "/edit", "/exit",
      "/agents", "/diff", "/compact", "/new", "/copy", "/init", "/labs",
      "/cost", "/doctor", "/bug", "/status", "/memory", "/model",
      "/undo", "/login", "/logout", "/verbose", "/mcp", "/skills",
      "/export", "/sentinel", "/provider",
    ];

    // Sub-argument completions for commands that accept parameters.
    // When user types e.g. "/trust " + Tab, they get the list of modes.
    const SLASH_ARGS = {
      "/trust":     ["readonly", "approval", "acceptEdits", "open", "dontAsk", "aiSafetyDecide", "plan", "outside"],
      "/sandbox":   ["on", "strict", "off", "subagents", "network"],
      "/reasoning": ["instant", "low", "medium", "high"],
      "/history":   ["save", "restore", "list"],
      "/memory":    ["show", "add", "clear", "edit"],
      "/agents":    ["list", "create"],
      "/mcp":       ["status", "reload"],
      "/labs":      ["list", "enable", "disable"],
      "/sentinel":  ["on", "off", "mode", "status"],
      "/export":    [".md", ".json", ".txt", ".html"],
      "/settings":  ["model", "max_tokens", "temperature", "reasoning_effort", "reasoning_summary", "stream", "diffusing"],
      "/provider":  ["list", "mercury", "openai"],
    };

    // ── Enhanced autocomplete widget ──
    this._autocomplete = new AutocompleteWidget(null, SLASH_CMDS, this.skillManager);

    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[38;5;87m\x1b[1m> \x1b[0m",
      completer: (line) => {
        // Delegate to autocomplete widget (shows interactive dropdown)
        return this._autocomplete.completer(line);
      },
    });

    // Link the autocomplete widget to the readline interface
    this._autocomplete._rl = this._rl;

    this._installSignalHandlers();

    // Interactive setup flow: workspace + trust mode + sandbox
    if (!this.skipStartupFlow) {
      await this._startupFlow();
    }

    this.sandbox.init();

    // Load labs state
    await labs.load();
    const { mcpResult } = await this._reloadWorkspaceState({
      resetConversation: true,
      reloadMcp: true,
      reloadSkills: true,
      announceProjectConfig: true,
    });

    await printWelcome({ showPlanet: this.showPlanet });

    // Show plan mode banner if active
    if (this.planMode) {
      printPlanModeBanner();
    }

    // Show MCP status if any servers configured
    if (mcpResult.count > 0) {
      printMcpStatus(this.mcpManager.getStatus());
      console.log("");
    }

    // Show skills count if any found
    if (this.skillManager.count > 0) {
      printInfo(`${this.skillManager.count} skill(s) loaded. Use /skills to list.`);
    }

    this._printStatusBar();
    console.log("");

    // Enable keypress events for ESC detection
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, this._rl);
      this._setupKeyListener();
    }

    this._rl.on("line", async (line) => {
      if (this._processing || this._inRollbackMode) return;

      // Multiline mode: if buffer exists, collect lines and submit
      if (this._inMultilineMode) {
        this._multilineBuffer.push(line);
        const combined = this._multilineBuffer.join("\n");
        this._multilineBuffer = [];
        this._inMultilineMode = false;
        this._processing = true;
        this._aborted = false;
        try {
          await this._handleInput(combined);
        } finally {
          this._processing = false;
          this._aborted = false;
        }
        return;
      }

      this._processing = true;
      this._aborted = false;
      try {
        await this._handleInput(line);
      } finally {
        this._processing = false;
        this._aborted = false;
      }
    });

    this._rl.on("close", async () => {
      await this._gracefulExit();
    });

    this._rl.setPrompt(this._buildPrompt());
    this._rl.prompt();
  }

  // ── Startup flow (workspace + trust selection) ────────────────────────────

  async _startupFlow() {
    const R = RESET, B = BOLD, D = DIM, C = CYAN, G = GRAY, Y = YELLOW, GR = GREEN;

    console.log("");
    console.log(`${B}${C}  ╭─ Setup ──────────────────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${B}${C}Step 1/2${R}  ${D}Workspace${R}`);
    console.log(`${G}  │${R}`);

    const cwd = process.cwd();
    console.log(`${G}  │${R}  ${D}Current directory:${R}`);
    console.log(`${G}  │${R}    ${C}${cwd}${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${D}Press Enter to accept, or type a new path:${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);

    const ws = await this._ask(`  ${C}>${R} `);
    this.workspace = ws.trim() ? path.resolve(ws.trim()) : cwd;

    // Update toolExecutor workspace
    this.toolExecutor.setWorkspace?.(this.workspace);

    console.log("");
    console.log(`${B}${C}  ╭─ Setup ──────────────────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${B}${C}Step 2/2${R}  ${D}Trust Mode${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}    ${Y}1${R}  ${D}Read-only${R}      ${G}Model can only read files${R}`);
    console.log(`${G}  │${R}  ${B}${GR}▸ 2${R}  ${D}Approval${R}       ${G}Asks before writes/commands (recommended)${R}`);
    console.log(`${G}  │${R}    ${Y}3${R}  ${D}Full open${R}      ${G}All ops within workspace${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${D}Tip: Change later with /trust${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);

    const modeStr = await this._ask(`  ${C}Select [2]:${R} `);
    const modeNum = parseInt(modeStr.trim(), 10);
    if (modeNum === 1) this.trustMode = TRUST_READONLY;
    else if (modeNum === 3) this.trustMode = TRUST_OPEN;
    else this.trustMode = TRUST_APPROVAL;

    // Update toolExecutor trust mode
    this.toolExecutor.trustMode = this.trustMode;

    // ── Step 3: Sandbox ─────────────────────────────────────────────────
    const sandboxStatus = this.sandbox.getStatus();

    console.log("");
    console.log(`${B}${C}  ╭─ Setup ──────────────────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${B}${C}Step 3/3${R}  ${D}Sandbox Isolation${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${D}Detected backend:${R} ${C}${sandboxStatus.backend}${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${B}${GR}▸ 1${R}  ${D}On${R}          ${G}Workspace-scoped filesystem, resource limits (default)${R}`);
    console.log(`${G}  │${R}    ${Y}2${R}  ${D}Strict${R}      ${G}Read-only root, no network for Bash, domain allowlist${R}`);
    console.log(`${G}  │${R}    ${Y}3${R}  ${D}Off${R}         ${G}No sandboxing (not recommended)${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${D}Applies to: main agent + all sub-agents${R}`);
    console.log(`${G}  │${R}  ${D}Tip: Change later with /sandbox${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);

    const sandboxStr = await this._ask(`  ${C}Select [1]:${R} `);
    const sandboxNum = parseInt(sandboxStr.trim(), 10);
    if (sandboxNum === 2) this.sandbox.setMode(SANDBOX_STRICT);
    else if (sandboxNum === 3) this.sandbox.setMode(SANDBOX_OFF);
    else this.sandbox.setMode(SANDBOX_ON);

    // Update sandbox workspace after selection
    this.sandbox.setWorkspace(this.workspace);
    this.toolExecutor.sandbox = this.sandbox;

    console.log("");
  }

  async _reloadPermissions() {
    this.permissionManager = await initPermissions(this.workspace, this.trustMode);
    this.trustMode = this.permissionManager.trustMode;
    this.toolExecutor.setPermissionRules?.(this.permissionManager.toConfig());
    this._syncTrustModeState();
  }

  async _refreshProjectConfig({ announce = false } = {}) {
    let configResult = await loadProjectConfig(this.workspace);
    setProjectConfig(this.workspace, configResult);

    // ── Context Sentinel: scan untrusted config before it enters conversation ──
    const untrusted = getUntrustedProjectConfig();
    if (untrusted && this._contextSentinel?.enabled) {
      try {
        const sentinel = await this._contextSentinel.checkProjectConfig(untrusted);
        if (!sentinel.allowed) {
          printError(`[Sentinel] Blocked workspace config — potential prompt injection detected: ${sentinel.reason}`);
          const blockedConfig = {
            ...configResult,
            untrusted:
              `⚠️ BLOCKED BY CONTEXT SENTINEL: Workspace configuration was blocked due to detected prompt injection.\n` +
              `Reason: ${sentinel.reason}\n` +
              `Threats: ${sentinel.threats.join(", ")}\n\n` +
              `The original workspace config has NOT been loaded into context. Please review the project files manually.`,
          };
          configResult = blockedConfig;
          setProjectConfig(this.workspace, blockedConfig);
          // Replace untrusted config with a warning instead of injecting the payload
          if (this.conversation) {
            this.conversation.setUntrustedProjectConfig(blockedConfig.untrusted);
          }
          return blockedConfig;
        }
        if (sentinel.verdict === VERDICT_SUSPICIOUS && sentinel.sanitized) {
          printInfo(`[Sentinel] Workspace config flagged as suspicious: ${sentinel.reason}`);
          const sanitizedConfig = { ...configResult, untrusted: sentinel.sanitized };
          configResult = sanitizedConfig;
          setProjectConfig(this.workspace, sanitizedConfig);
          // Use the sanitized (warning-bannered) version
          if (this.conversation) {
            this.conversation.setUntrustedProjectConfig(sanitizedConfig.untrusted);
          }
          return sanitizedConfig;
        }
      } catch (err) {
        debugLog("MercuryRepl._refreshProjectConfig.sentinel", err);
        const blockedConfig = {
          ...configResult,
          untrusted:
            `⚠️ BLOCKED BY CONTEXT SENTINEL: Workspace configuration was not loaded because the safety check failed.\n` +
            `Reason: ${err.message}\n\n` +
            `The original workspace config has NOT been loaded into context. Please review the project files manually.`,
        };
        configResult = blockedConfig;
        setProjectConfig(this.workspace, blockedConfig);
        printError(`[Sentinel] Failed to analyze workspace config — blocking untrusted config: ${err.message}`);
        if (this.conversation) {
          this.conversation.setUntrustedProjectConfig(blockedConfig.untrusted);
        }
        return blockedConfig;
      }
    }

    // Propagate untrusted config to conversation for structural isolation
    const effectiveUntrusted = configResult.untrusted || "";
    if (this.conversation) {
      this.conversation.setUntrustedProjectConfig(effectiveUntrusted);
    }
    // Register workspace config taint for provenance tracking
    if (effectiveUntrusted && this._taintTracker) {
      this._taintTracker.registerWorkspaceConfig(effectiveUntrusted);
    }
    if (announce) {
      const configPath = await findProjectConfig(this.workspace);
      if (configPath) {
        printInfo(`Loaded project config: ${configPath}`);
      }
    }
    return configResult;
  }

  async _reloadWorkspaceState(options = {}) {
    const {
      resetConversation = false,
      reloadMcp = false,
      reloadSkills = false,
      announceProjectConfig = false,
    } = options;
    const previousHooks = this.hooks;
    const previousHooksWorkspace = this._hooksSessionWorkspace;

    this.toolExecutor.setWorkspace?.(this.workspace);
    this.sandbox.setWorkspace?.(this.workspace);
    this.toolExecutor.sandbox = this.sandbox;

    await this._reloadPermissions();
    this.memory = new MemoryManager(this.workspace);
    this.log = new ConversationLog(this.workspace, { trustMode: this.trustMode });
    this.rollback = new RollbackManager(this.workspace);
    this._syncTrustModeState();
    await this._refreshProjectConfig({ announce: announceProjectConfig });

    if (previousHooksWorkspace && previousHooksWorkspace !== this.workspace && previousHooks) {
      try { await previousHooks.fireSessionEnd(); } catch (err) { debugLog("MercuryRepl._reloadWorkspaceState.sessionEnd", err); }
    }

    this.hooks = getHooksManager(this.workspace, {
      allowProjectHooks: this.allowProjectHooks,
      onInfo: (msg) => printInfo(msg),
    });
    await this.hooks.load();
    if (this._hooksSessionWorkspace !== this.workspace) {
      await this.hooks.fireSessionStart(this.workspace);
      this._hooksSessionWorkspace = this.workspace;
    }

    const providerInfo = {
      displayName: this.client.provider?.displayName,
      model: this.client.config.model,
      maxContext: this._getMaxContextTokens(),
    };
    const systemPrompt = buildSystemPrompt(this.workspace, this.trustMode, this.sandbox, providerInfo);
    if (!this.conversation || resetConversation) {
      this.conversation = new Conversation(systemPrompt);
      if (this._taintTracker) this._taintTracker.clear();
    } else {
      this.conversation.updateSystemPrompt(systemPrompt);
    }
    // Inject untrusted workspace config as structurally isolated user message
    this.conversation.setUntrustedProjectConfig(getUntrustedProjectConfig());
    await this._refreshConversationMemory();

    let mcpResult = { count: 0 };
    if (reloadMcp) {
      try { await this.mcpManager.shutdown(); } catch (err) { debugLog("MercuryRepl._initWorkspace.mcpShutdown", err); }
      mcpResult = await this.mcpManager.loadConfig(this.workspace, this._mcpConfigPath, {
        allowProjectConfig: this.allowProjectMcp,
      });
    }

    if (reloadSkills) {
      await this.skillManager.discover(this.workspace);
    }

    return { mcpResult };
  }

  _refreshConversationSystemPrompt() {
    if (!this.conversation) return;
    const providerInfo = {
      displayName: this.client.provider?.displayName,
      model: this.client.config.model,
      maxContext: this._getMaxContextTokens(),
    };
    this.conversation.updateSystemPrompt(buildSystemPrompt(this.workspace, this.trustMode, this.sandbox, providerInfo));
  }

  /**
   * Get the max context tokens for the current provider/model.
   * Falls back to MODEL_LIMITS.max_context_tokens for backward compat.
   */
  _getMaxContextTokens() {
    const limits = getModelLimits(this.client.providerName, this.client.config.model);
    return limits.maxContext || MODEL_LIMITS.max_context_tokens;
  }

  /**
   * Called after provider or model changes to update dependent state.
   */
  _onProviderChanged() {
    this._refreshConversationSystemPrompt();
  }

  _isLogEnabledForCurrentMode() {
    return this.trustMode !== TRUST_READONLY && !this.planMode;
  }

  _syncTrustModeState() {
    this.toolExecutor.trustMode = this.trustMode;

    if (this.trustMode === TRUST_AI_SAFETY_DECIDE) {
      if (!this._aiSafetyDecider) {
        this._aiSafetyDecider = new AiSafetyDecider({
          apiKey: this.client.apiKey,
          baseURL: this.client.baseURL,
          workspace: this.workspace,
          timeout: 15000,
          onInfo: this.verbose ? (msg) => console.error(msg) : null,
        });
      } else {
        this._aiSafetyDecider.workspace = this.workspace;
        this._aiSafetyDecider.client.apiKey = this.client.apiKey;
        this._aiSafetyDecider.client.baseURL = this.client.baseURL;
      }
    } else {
      this._aiSafetyDecider = null;
    }

    // Keep sentinel credentials in sync
    if (this._contextSentinel) {
      this._contextSentinel.updateCredentials(this.client.apiKey, this.client.baseURL);
    }
    if (this._actionSafetyLead) {
      this._actionSafetyLead.updateCredentials(this.client.apiKey, this.client.baseURL);
    }

    if (this.log) {
      this.log._logEnabled = this._isLogEnabledForCurrentMode();
    }
  }

  async _refreshConversationMemory() {
    if (!this.conversation || !this.memory) return;
    await this.conversation.loadMemory(this.memory);
  }

  _buildPermissionPolicy(toolName, args, reason = null) {
    if (toolName === "Fetch") {
      const method = (args.method || "GET").toUpperCase();
      return {
        kind: "fetch",
        method,
        hasBody: !!args.body,
        hasQuery: !!(args.url && /\?[^#]/.test(args.url)),
        url: args.url || null,
        reason,
      };
    }

    if (WRITE_TOOLS.has(toolName)) {
      const filePath = args.file_path || args.path || null;
      if (reason && reason.toLowerCase().includes("outside workspace")) {
        return {
          kind: "outside_write",
          path: filePath ? path.resolve(filePath) : null,
          outsideWorkspace: true,
          reason,
        };
      }
    }

    return null;
  }

  _setClientConnection({ apiKey, baseURL } = {}) {
    if (apiKey !== undefined) {
      this.client.apiKey = apiKey;
      this.toolExecutor._clientOptions.apiKey = apiKey;
      if (this._aiSafetyDecider) {
        this._aiSafetyDecider.client.apiKey = apiKey;
      }
      if (this._contextSentinel) {
        this._contextSentinel.updateCredentials(apiKey, undefined);
      }
      if (this._actionSafetyLead) {
        this._actionSafetyLead.updateCredentials(apiKey, undefined);
      }
    }
    if (baseURL !== undefined) {
      this.client.baseURL = baseURL;
      this.toolExecutor._clientOptions.baseURL = baseURL;
      if (this._aiSafetyDecider) {
        this._aiSafetyDecider.client.baseURL = baseURL;
      }
      if (this._contextSentinel) {
        this._contextSentinel.updateCredentials(undefined, baseURL);
      }
      if (this._actionSafetyLead) {
        this._actionSafetyLead.updateCredentials(undefined, baseURL);
      }
    }
  }

  async _prepareSkillPrompt(skillName, skill, argsText = "") {
    const rendered = skill.render(argsText);
    if (!this._contextSentinel?.enabled) return rendered;

    const check = await this._contextSentinel.check(rendered, {
      source: "skill-prompt",
      path: skill.source,
      tool: "Skill",
    });

    if (!check.allowed) {
      throw new Error(`Skill "${skillName}" blocked by Context Sentinel: ${check.reason}`);
    }
    if (check.verdict === VERDICT_SUSPICIOUS && check.sanitized) {
      printInfo(`[Sentinel] Skill "${skillName}" prompt flagged as suspicious: ${check.reason}`);
      return check.sanitized;
    }
    return rendered;
  }

  _parseBooleanSetting(value) {
    const normalized = String(value).trim().toLowerCase();
    if (["true", "on", "1"].includes(normalized)) return true;
    if (["false", "off", "0"].includes(normalized)) return false;
    return null;
  }

  _serializableClientConfig() {
    const {
      model,
      max_tokens,
      temperature,
      reasoning_effort,
      reasoning_summary,
      stream,
      diffusing,
    } = this.client.config || {};

    return {
      model,
      max_tokens,
      temperature,
      reasoning_effort,
      reasoning_summary,
      stream,
      diffusing,
    };
  }

  _getSessionSnapshot() {
    return {
      id: this._sessionId,
      cwd: this.workspace,
      messages: [...(this.conversation?.messages || [])],
      config: this._serializableClientConfig(),
      trustMode: this.trustMode,
      planMode: this.planMode,
      sandbox: {
        mode: this.sandbox.mode,
        allowNetwork: this.sandbox.allowNetwork,
        sandboxSubAgents: this.sandbox.sandboxSubAgents,
      },
    };
  }

  async _submitUserText(text, options = {}) {
    const {
      resolveFileMentions = true,
      logContent = text,
      createCheckpoint = true,
    } = options;

    let submitted = text;
    if (resolveFileMentions) {
      submitted = this._resolveFileMentions(submitted);
    }

    if (createCheckpoint) {
      this.rollback.createCheckpoint(submitted, this.conversation.messages);
    }

    this.conversation.addUserMessage(submitted);
    this.log.append({ role: "user", content: logContent ?? submitted }); // fire-and-forget, queue handles ordering
    this._toolTurnCount = 0;
    await this._sendAndProcess();
  }

  async _restoreSession(session) {
    if (!session || !Array.isArray(session.messages)) {
      throw new Error("Invalid session data");
    }

    // Clamp restored trustMode: never allow restoring a less restrictive mode
    // than the current session's trust mode.
    // Trust mode hierarchy (most restrictive to least):
    //   readonly(4) > dontAsk(3) > approval(2) > acceptEdits(1) > aiSafetyDecide(0.5) > open(0)
    if (session.trustMode) {
      const TRUST_ORDER = { open: 0, aiSafetyDecide: 0.5, acceptEdits: 1, approval: 2, dontAsk: 3, readonly: 4 };
      const currentLevel = TRUST_ORDER[this.trustMode] ?? 2;
      const restoredLevel = TRUST_ORDER[session.trustMode] ?? 2;
      // Only restore if the restored mode is at least as restrictive (higher or equal level)
      if (restoredLevel >= currentLevel) {
        this.trustMode = session.trustMode;
      }
      // Otherwise keep the current (more restrictive) trustMode
    }
    if (typeof session.planMode === "boolean") {
      this.planMode = session.planMode;
    }
    // Clamp restored sandbox mode: never allow restoring a less restrictive sandbox
    // Sandbox hierarchy (most restrictive to least): strict(2) > on(1) > off(0)
    if (session.sandbox?.mode) {
      const SANDBOX_ORDER = { off: 0, on: 1, strict: 2 };
      const currentSandboxLevel = SANDBOX_ORDER[this.sandbox?.mode] ?? 0;
      const restoredSandboxLevel = SANDBOX_ORDER[session.sandbox.mode] ?? 0;
      // Only restore if the restored sandbox is at least as restrictive
      if (restoredSandboxLevel >= currentSandboxLevel) {
        this.sandbox.setMode(session.sandbox.mode);
      }
      // Otherwise keep the current (more restrictive) sandbox mode
    }
    if (typeof session.sandbox?.allowNetwork === "boolean") {
      // Only restore allowNetwork if it's MORE restrictive (false is more restrictive)
      if (!session.sandbox.allowNetwork || this.sandbox.allowNetwork) {
        this.sandbox.allowNetwork = session.sandbox.allowNetwork;
      }
    }
    if (typeof session.sandbox?.sandboxSubAgents === "boolean") {
      // Only restore sandboxSubAgents if it's MORE restrictive (true is more restrictive)
      if (session.sandbox.sandboxSubAgents || !this.sandbox.sandboxSubAgents) {
        this.sandbox.sandboxSubAgents = session.sandbox.sandboxSubAgents;
      }
    }

    this.client.config = normalizeClientConfig(session.config && typeof session.config === "object"
      ? session.config
      : this.client.config);

    const nextWorkspace = session.cwd ? path.resolve(session.cwd) : this.workspace;
    const workspaceChanged = nextWorkspace !== this.workspace;
    this.workspace = nextWorkspace;

    await this._reloadWorkspaceState({
      resetConversation: true,
      reloadMcp: workspaceChanged,
      reloadSkills: workspaceChanged,
      announceProjectConfig: false,
    });

    this.conversation.messages = session.messages.filter(
      (msg) => msg && msg.role && msg.role !== "system"
    );
    this._sessionId = session.id || this._generateSessionId();

    return { workspaceChanged, messageCount: this.conversation.messages.length };
  }

  _getEmptyResponseHint(response) {
    if (response?.tool_calls?.length) return null;
    if (response?.content) return null;

    if (response?.finish_reason === "length") {
      return "The model returned no visible text before hitting the token limit. Try a higher /settings max_tokens or a lower /reasoning level.";
    }

    return "The model returned no visible text. Try a higher /settings max_tokens, a lower /reasoning level, or ask for a shorter, direct answer.";
  }

  _ask(prompt) {
    return new Promise((resolve, reject) => {
      if (!this._rl) {
        reject(new Error("Input interface is not available."));
        return;
      }

      const onClose = () => reject(new Error("Input closed."));
      this._rl.once("close", onClose);
      this._rl.question(prompt, (answer) => {
        this._rl?.removeListener("close", onClose);
        resolve(answer);
      });
    });
  }

  _trustLabel(mode) {
    switch (mode) {
      case TRUST_READONLY: return this.planMode ? "Plan (read-only analysis + plan file)" : "Read-only (only read operations allowed)";
      case TRUST_APPROVAL: return "Approval (asks before writes/commands)";
      case TRUST_ACCEPT_EDITS: return "Accept Edits (auto-approve file edits, ask for Bash)";
      case TRUST_OPEN: return "Full open (all ops within workspace)";
      case TRUST_AI_SAFETY_DECIDE: return "AI Safety Decide (AI evaluates each operation's safety)";
      case TRUST_DONT_ASK: return "Don't Ask (deny unless pre-approved)";
      default: return mode;
    }
  }

  /**
   * Print a compact status bar showing workspace, trust, and context gauge.
   */
  _printStatusBar() {
    const R = RESET, B = BOLD, D = DIM, C = CYAN, G = GRAY, GR = GREEN;
    const w = Math.min((process.stdout.columns || 80) - 4, 74);
    const inner = Math.max(44, w);

    const wsName = path.basename(this.workspace);
    const trustIcon = this.trustMode === TRUST_READONLY ? "🔒" : this.trustMode === TRUST_OPEN ? "🔓" : "🔐";
    const usedTokens = this.conversation ? this.conversation.getTokenEstimate() : 0;
    const gauge = renderContextGauge(usedTokens, this._getMaxContextTokens());
    const sandboxStatus = this.sandbox.getStatus();
    const sandboxLabel = `${sandboxStatus.icon} ${sandboxStatus.mode}/${sandboxStatus.backend}`;
    const workspaceLine = this.workspace.length > inner - 14
      ? "…" + this.workspace.slice(-(inner - 15))
      : this.workspace;
    const row = `${C}${B}${wsName}${R} ${G}│${R} ${trustIcon} ${D}${this._trustLabel(this.trustMode)}${R} ${G}│${R} ${sandboxLabel} ${G}│${R} ${gauge}`;

    console.log(`${B}${C}  ╭─ Session ${"─".repeat(Math.max(0, inner - 10))}╮${R}`);
    console.log(`  ${G}│${R} ${row}`);
    console.log(`  ${G}│${R} ${GR}workspace${R} ${D}${workspaceLine}${R}`);
    console.log(`${B}${C}  ╰${"─".repeat(inner)}╯${R}`);
  }

  /**
   * Build a context-aware prompt string showing workspace + circular gauge + usage %.
   */
  _buildPrompt() {
    const R = RESET, B = BOLD, C = CYAN, G = GRAY;

    const wsName = path.basename(this.workspace);
    const usedTokens = this.conversation ? this.conversation.getTokenEstimate() : 0;
    const gauge = renderContextGauge(usedTokens, this._getMaxContextTokens());

    return `${G}${wsName}${R} ${gauge} ${C}${B}>${R} `;
  }

  // ── ESC detection ─────────────────────────────────────────────────────────

  _setupKeyListener() {
    if (this._keypressHandler) {
      process.stdin.removeListener("keypress", this._keypressHandler);
    }

    this._keypressHandler = (_str, key) => {
      if (!key) return;

      // Ctrl+J: enter multiline input mode
      if (key.ctrl && key.name === "j" && !this._processing) {
        // Get current line content and add to buffer
        const currentLine = this._rl.line || "";
        this._multilineBuffer.push(currentLine);
        this._inMultilineMode = true;
        // Clear current line and show multiline prompt
        this._rl.line = "";
        this._rl.cursor = 0;
        const lineNum = this._multilineBuffer.length + 1;
        process.stdout.write(`\n\x1b[90m${String(lineNum).padStart(2)}│\x1b[0m `);
        return;
      }

      // ESC triple-tap for rollback
      if (key.name === "escape" && !this._processing) {
        const now = Date.now();
        this._escPresses = this._escPresses.filter((t) => now - t < ESC_WINDOW_MS);
        this._escPresses.push(now);
        if (this._escPresses.length >= 3) {
          this._escPresses = [];
          this._enterRollbackMode().catch(() => {});
        }
      }
    };

    process.stdin.on("keypress", this._keypressHandler);
  }

  _installSignalHandlers() {
    if (this._sigintHandler) {
      process.removeListener("SIGINT", this._sigintHandler);
    }

    this._aborted = false;
    this._sigintHandler = () => {
      if (this._processing) {
        this._aborted = true;
        spinner.stop();
        printWarning("Interrupted by user (Ctrl+C).");
      } else {
        printInfo("Press Ctrl+C again or type /exit to quit.");
      }
    };
    process.on("SIGINT", this._sigintHandler);
  }

  _disposeInteractiveHandlers() {
    if (this._sigintHandler) {
      process.removeListener("SIGINT", this._sigintHandler);
      this._sigintHandler = null;
    }
    if (this._keypressHandler) {
      process.stdin.removeListener("keypress", this._keypressHandler);
      this._keypressHandler = null;
    }
    if (this._autocomplete) {
      this._autocomplete.dispose();
    }
  }

  // ── Easter Egg: Logo Edit Mode ───────────────────────────────────────────

  /**
   * Enter logo edit mode (triggered by double-tap Enter on empty prompt).
   * Shows the editable logo prompt, waits for user input.
   * If user types "cold" (case insensitive), plays the easter egg animation.
   */
  async _enterLogoEditMode() {
    printEditableLogo();
    const userText = await this._ask(`  \x1b[38;5;87m\x1b[1m☿ MERCURY \x1b[0m`);
    const cleaned = userText.trim().toLowerCase();
    if (cleaned === "cold") {
      await playMercuryColdEasterEgg();
    } else if (cleaned) {
      // Show the user's custom text briefly
      const R = RESET, B = BOLD, D = DIM, C = CYAN;
      console.log(`${C}${B}  ☿ MERCURY ${userText.trim().toUpperCase()}${R}`);
      console.log(`${D}  (Nice try! But the secret word is... well, it's a secret.)${R}`);
      console.log("");
    } else {
      printInfo("Logo edit cancelled.");
    }
  }

  // ── Multiline input via $EDITOR ─────────────────────────────────────────

  /**
   * Open the user's $EDITOR for composing a multiline message.
   * Triggered by /edit command or when user types just `\`.
   * @returns {string|null} The composed text, or null if cancelled.
   */
  _openEditor() {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
    const tmpFile = path.join(os.tmpdir(), `mercury-input-${Date.now()}.md`);

    try {
      // Write a hint to the temp file
      fs.writeFileSync(tmpFile, "# Type your message below. Save and close the editor to submit.\n# Lines starting with # will be stripped.\n\n");

      // Open editor (blocking) — use execFileSync to prevent command injection
      const editorParts = editor.split(/\s+/);
      const editorCmd = editorParts[0];
      const editorArgs = [...editorParts.slice(1), tmpFile];
      _execFileSync(editorCmd, editorArgs, { stdio: "inherit" });

      // Read the result
      const content = fs.readFileSync(tmpFile, "utf-8");

      // Strip comment lines and trim
      const lines = content.split("\n").filter((l) => !l.startsWith("#"));
      const result = lines.join("\n").trim();

      return result || null;
    } catch (err) {
      debugLog("MercuryRepl._openExternalEditor", err);
      return null;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (err) { debugLog("MercuryRepl._openExternalEditor.cleanup", err); }
    }
  }

  // ── @file mention resolver ────────────────────────────────────────────

  /**
   * Resolve @file mentions in user input.
   * Syntax: @path/to/file or @./relative/path
   * Replaces each @mention with the file contents wrapped in a code fence.
   * Returns the expanded text.
   */
  _resolveFileMentions(input) {
    // Match @file patterns: @./foo.js, @src/bar.ts, @/absolute/path.py
    // Must be preceded by start-of-string or whitespace
    const FILE_MENTION_RE = /(?:^|\s)@(\.?\/?\S+)/g;
    const mentions = [];
    let match;

    while ((match = FILE_MENTION_RE.exec(input)) !== null) {
      const rawPath = match[1];
      const resolvedPath = path.resolve(this.workspace, rawPath);
      mentions.push({ raw: match[0].trim(), rawPath, resolvedPath });
    }

    if (mentions.length === 0) return input;

    let expanded = input;
    for (const m of mentions) {
      try {
        const resolvedAbs = path.resolve(m.resolvedPath);
        const relPath = path.relative(this.workspace, resolvedAbs);

        // Block path traversal attempts that escape the workspace
        if (this.sandbox) {
          const pathCheck = this.sandbox.checkPath(resolvedAbs, 'read');
          if (!pathCheck.allowed) {
            expanded = expanded.replaceAll(m.raw, `[File access denied: ${relPath} — outside workspace or blocked by sandbox]`);
            continue;
          }
        }

        // Fallback: at minimum check if path is within workspace
        if (this.workspace) {
          const realWorkspace = path.resolve(this.workspace);
          if (!resolvedAbs.startsWith(realWorkspace + path.sep) && resolvedAbs !== realWorkspace) {
            expanded = expanded.replaceAll(m.raw, `[File access denied: ${relPath} — outside workspace]`);
            continue;
          }
        }

        const content = fs.readFileSync(resolvedAbs, "utf-8");
        const ext = path.extname(resolvedAbs).slice(1) || "";

        // Check file size limit (~50KB)
        if (content.length > 50000) {
          const truncated = content.slice(0, 50000);
          const fenced = encodeUntrustedToolResult(truncated);
          expanded = expanded.replace(
            m.raw,
            `[Referenced file: ${relPath} — ${content.length} chars, truncated to 50K]\n${fenced}\n[... truncated ...]`
          );
        } else {
          const fenced = encodeUntrustedToolResult(content);
          expanded = expanded.replace(
            m.raw,
            `[Referenced file: ${relPath}]\n${fenced}`
          );
        }

        printInfo(`Included @${relPath} (${content.length} chars)`);
      } catch (err) {
        if (err.code === "ENOENT") {
          // Not a real file reference — leave it as-is
        } else {
          printWarning(`Could not read @${m.rawPath}: ${err.message}`);
        }
      }
    }

    return expanded;
  }

  // ── Single-shot mode ─────────────────────────────────────────────────────

  async runOnce(promptText) {
    this.sandbox.init();
    await labs.load();
    try {
      await this._reloadWorkspaceState({
        resetConversation: true,
        reloadMcp: true,
        reloadSkills: true,
      });
      await this._submitUserText(promptText, {
        resolveFileMentions: true,
        logContent: promptText,
        createCheckpoint: false,
      });
      try { await this.hooks?.fireSessionEnd(); } catch (err) { debugLog("MercuryRepl.runOnce.sessionEnd", err); }
      try { await this.mcpManager.shutdown(); } catch (err) { debugLog("MercuryRepl.runOnce.mcpShutdown", err); }
    } catch (err) {
      printError(`Error: ${err.message}`);
      if (this.verbose) console.error(err.stack);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Input handling ───────────────────────────────────────────────────────

  /**
   * Collapse long paste in terminal display.
   * If input exceeds threshold, clear the echoed lines and show a compact summary.
   * The full text is still sent to the model.
   */
  _collapseLongInput(input) {
    if (input.length <= PASTE_COLLAPSE_THRESHOLD) return;

    const R = RESET, D = DIM, G = GRAY, E = ESC;

    // Count stats
    const lineCount = input.split("\n").length;
    const charCount = input.length;
    const byteCount = Buffer.byteLength(input, "utf-8");

    // Estimate how many terminal lines were consumed by the echoed paste
    const termWidth = process.stdout.columns || 80;
    const inputLines = input.split("\n");
    let echoedLines = 0;
    for (const line of inputLines) {
      echoedLines += Math.max(1, Math.ceil((line.length + 1) / termWidth));
    }

    // Move cursor up and clear the echoed lines
    if (echoedLines > 1) {
      process.stdout.write(`${E}${echoedLines}A`);
      for (let i = 0; i < echoedLines; i++) {
        process.stdout.write(`${E}2K\n`);
      }
      process.stdout.write(`${E}${echoedLines}A`);
    } else {
      // Single long line: clear current line
      process.stdout.write(`\r${E}2K`);
    }

    // Show compact summary with first line preview
    const firstLine = inputLines[0];
    const preview = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
    const sizeStr = byteCount >= 1024
      ? `${(byteCount / 1024).toFixed(1)}KB`
      : `${byteCount}B`;

    console.log(
      `${G}  ┌─ Pasted${R} ${D}${charCount} chars, ${lineCount} line${lineCount > 1 ? "s" : ""}, ${sizeStr}${R}`
    );
    console.log(`${G}  │${R} ${D}${preview}${R}`);
    if (lineCount > 1) {
      const lastLine = inputLines[lineCount - 1].trim();
      const lastPreview = lastLine.length > 60 ? lastLine.slice(0, 57) + "..." : lastLine;
      if (lastPreview) {
        console.log(`${G}  │${R} ${D}... (${lineCount - 2} more lines)${R}`);
        console.log(`${G}  │${R} ${D}${lastPreview}${R}`);
      } else {
        console.log(`${G}  │${R} ${D}... (${lineCount - 1} more lines)${R}`);
      }
    }
    console.log(`${G}  └─${R}`);
  }

  async _handleInput(input) {
    let trimmed = input.trim();
    if (!trimmed) {
      // Easter egg: double-tap Enter on empty prompt triggers logo edit mode
      const now = Date.now();
      if (now - this._lastEmptyEnterTime < 500) {
        this._lastEmptyEnterTime = 0;
        await this._enterLogoEditMode();
        this._rl.setPrompt(this._buildPrompt());
        this._rl.prompt();
        return;
      }
      this._lastEmptyEnterTime = now;
      this._rl.setPrompt(this._buildPrompt());
      this._rl.prompt();
      return;
    }
    // Reset empty-enter tracking on non-empty input
    this._lastEmptyEnterTime = 0;

    // Backslash alone → open $EDITOR for multiline input
    if (trimmed === "\\") {
      if (this.webBridgeMode) {
        printInfo("Use the web composer for multiline input in browser mode.");
        this._rl.setPrompt(this._buildPrompt());
        this._rl.prompt();
        return;
      }
      printInfo(`Opening ${process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi")} for multiline input...`);
      const editorText = this._openEditor();
      if (!editorText) {
        printInfo("Editor cancelled (empty input).");
        this._rl.setPrompt(this._buildPrompt());
    this._rl.prompt();
        return;
      }
      trimmed = editorText;
      printInfo(`Received ${trimmed.length} chars from editor.`);
    }

    // ! prefix → execute shell command inline via the standard Bash tool path
    if (trimmed.startsWith("!") && trimmed.length > 1) {
      if (this.trustMode === "readonly" || this.planMode) {
        printWarning("Shell escape (!) is not available in readonly/plan mode.");
        this._rl.setPrompt(this._buildPrompt());
        this._rl.prompt();
        return;
      }
      let args = { command: trimmed.slice(1).trim(), timeout: 30000 };
      const hookResult = await this.hooks.firePreToolUse("Bash", args);
      if (hookResult.action === "deny") {
        printError(`Blocked by hook: ${hookResult.message || "Tool denied."}`);
        this._rl.setPrompt(this._buildPrompt());
        this._rl.prompt();
        return;
      }
      if (hookResult.action === "modify" && hookResult.updatedInput) {
        args = { ...args, ...hookResult.updatedInput };
      }

      const perm = await this._checkPermission("Bash", args);
      if (perm.updatedArgs) {
        args = perm.updatedArgs;
      }
      if (!perm.allowed) {
        printError(`Blocked: ${perm.reason}`);
        this._rl.setPrompt(this._buildPrompt());
        this._rl.prompt();
        return;
      }

      let approvalReason = null;
      const hookAllows = hookResult.action === "allow";
      const hookAsks = hookResult.action === "ask";
      let taintResult = null;
      if (this._taintTracker) {
        taintResult = this._taintTracker.check("Bash", args, this.conversation?.messages || []);
      }
      if (this._actionSafetyLead?.enabled && !hookAllows) {
        const leadResult = await this._actionSafetyLead.review(
          "Bash",
          args,
          this.conversation?.messages || [],
          {
            source_tags: taintResult?.tags || [],
            source_sources: taintResult?.sources || [],
            policy: { kind: "bash" },
            trust_mode: this.trustMode,
          }
        );
        if (leadResult.decision === ACTION_DENY) {
          printError(`Action Safety blocked: ${leadResult.reason}`);
          this._rl.setPrompt(this._buildPrompt());
          this._rl.prompt();
          return;
        }
        if (leadResult.decision === ACTION_TERMINATE) {
          printError(`Action Safety terminated this task: ${leadResult.reason}`);
          this._rl.setPrompt(this._buildPrompt());
          this._rl.prompt();
          return;
        }
        if (leadResult.decision === ACTION_ESCALATE) {
          approvalReason = `Action Safety escalated: ${leadResult.reason}`;
        }
      }
      if (!approvalReason && taintResult?.tainted) {
        approvalReason = `Taint detected: shell command references ${taintResult.tags.join(", ")} content`;
      }
      if (!approvalReason && perm.needsAiSafety && this._aiSafetyDecider && !hookAllows) {
        const safetyResult = await this._aiSafetyDecider.evaluate(
          "Bash",
          args,
          this.conversation?.messages?.[0]?.content || "",
          this.conversation?.messages || []
        );
        if (safetyResult.decision === "DENY") {
          printError(`AI Safety blocked: ${safetyResult.reason}`);
          this._rl.setPrompt(this._buildPrompt());
          this._rl.prompt();
          return;
        }
        if (safetyResult.decision === "ESCALATE") {
          approvalReason = `AI Safety escalated (${(safetyResult.confidence * 100).toFixed(0)}%): ${safetyResult.reason}`;
        }
      }
      if (!approvalReason && hookAsks) {
        approvalReason = hookResult.message || perm.reason || "Hook requested approval.";
      }
      if (!approvalReason && perm.needsApproval && !hookAllows) {
        approvalReason = perm.reason;
      }
      if (approvalReason) {
        const approved = await this._requestApproval("Bash", args, approvalReason, {
          sourceTags: taintResult?.tags || [],
          sourceSources: taintResult?.sources || [],
          policy: { kind: "bash" },
        });
        if (!approved) {
          printWarning("Shell escape denied.");
          this._rl.setPrompt(this._buildPrompt());
          this._rl.prompt();
          return;
        }
      }

      printInfo(`$ ${args.command}`);
      try {
        const result = await this.toolExecutor.execute("bash", args);
        await this.hooks.firePostToolUse("Bash", args, String(result));
        if (result) console.log(result);
      } catch (err) {
        printError(`Shell escape error: ${err.message}`);
      }
      this._rl.setPrompt(this._buildPrompt());
      this._rl.prompt();
      return;
    }

    // Collapse long pasted content in display (full text still used)
    this._collapseLongInput(trimmed);

    if (trimmed.startsWith("/")) {
      await this._handleCommand(trimmed);
      this._rl.setPrompt(this._buildPrompt());
    this._rl.prompt();
      return;
    }

    try {
      await this._submitUserText(trimmed, {
        resolveFileMentions: true,
        logContent: trimmed,
      });
    } catch (err) {
      printError(`Unexpected error: ${err.message}`);
      if (this.verbose) console.error(err.stack);
    }

    this._rl.setPrompt(this._buildPrompt());
    this._rl.prompt();
  }

  // ── Permission check ─────────────────────────────────────────────────────

  async _checkPermission(rawToolName, args) {
    // Normalize tool name using canonical lookup map (handles multi-word names like SubAgentTeam)
    const CANONICAL_NAMES = {
      read: "Read", write: "Write", edit: "Edit", patch: "Patch",
      bash: "Bash", glob: "Glob", grep: "Grep", listdir: "ListDir",
      diff: "Diff", fetch: "Fetch", contextsearch: "ContextSearch",
      subagent: "SubAgent", subagentteam: "SubAgentTeam",
      skill: "Skill",
    };
    const toolName = CANONICAL_NAMES[rawToolName.toLowerCase()] || rawToolName;

    // MCP tools: follow same rules as Bash (they execute external code)
    const isMcpTool = toolName.startsWith("mcp__");

    const explicitRule = await this.permissionManager?.checkAsync(toolName, args);
    if (explicitRule?.decision === "deny") {
      return {
        allowed: false,
        needsApproval: false,
        reason: explicitRule.rule ? `Permission rule denied: ${explicitRule.rule}` : `Permission rule denied ${toolName}`,
      };
    }
    if (explicitRule?.decision === "allow" && (explicitRule?.source === "allow_rule" || explicitRule?.source === "canUseTool")) {
      const filePath = args.file_path || args.path;
      if (filePath && WRITE_TOOLS.has(toolName)) {
        const inWorkspace = this._isInWorkspace(filePath);
        if (!inWorkspace && !this.allowOutsideWorkspace) {
          const reason = `File outside workspace: ${path.resolve(filePath)}`;
          return {
            allowed: true,
            needsApproval: true,
            reason,
            policy: this._buildPermissionPolicy(toolName, args, reason),
            updatedArgs: explicitRule.updatedInput ? { ...args, ...explicitRule.updatedInput } : null,
          };
        }
      }
      if (this.trustMode === TRUST_AI_SAFETY_DECIDE && !READ_TOOLS.has(toolName) && toolName !== "ContextSearch") {
        return {
          allowed: true,
          needsApproval: false,
          needsAiSafety: true,
          updatedArgs: explicitRule.updatedInput ? { ...args, ...explicitRule.updatedInput } : null,
        };
      }
      return {
        allowed: true,
        needsApproval: false,
        updatedArgs: explicitRule.updatedInput ? { ...args, ...explicitRule.updatedInput } : null,
      };
    }
    if (explicitRule?.decision === "ask") {
      return {
        allowed: true,
        needsApproval: true,
        reason: explicitRule.rule ? `Permission rule requires approval: ${explicitRule.rule}` : null,
      };
    }

    // ── dontAsk mode: deny everything not explicitly in READ_TOOLS ──
    if (this.trustMode === TRUST_DONT_ASK) {
      if (READ_TOOLS.has(toolName) || toolName === "ContextSearch") {
        return { allowed: true, needsApproval: false };
      }
      return { allowed: false, needsApproval: false, reason: `dontAsk mode: ${toolName} denied (not pre-approved)` };
    }

    // ── Readonly / Plan mode: only read tools ──
    if (this.trustMode === TRUST_READONLY) {
      if (READ_TOOLS.has(toolName) || toolName === "ContextSearch") {
        return { allowed: true, needsApproval: false };
      }
      // Fetch: allow pure GET without query params
      if (toolName === "Fetch") {
        const method = (args.method || "GET").toUpperCase();
        const hasQuery = args.url && /\?[^#]/.test(args.url);
        if (method === "GET" && !args.body && !hasQuery) {
          return { allowed: true, needsApproval: false };
        }
        return { allowed: false, needsApproval: false, reason: `Read-only mode: only pure GET requests allowed` };
      }
      // SubAgent: allow in readonly (they inherit readonly trust)
      if (toolName === "SubAgent" || toolName === "SubAgentTeam") {
        return { allowed: false, needsApproval: false, reason: "Read-only mode: sub-agents disabled" };
      }
      return { allowed: false, needsApproval: false, reason: `Read-only mode: ${toolName} blocked` };
    }

    // ── aiSafetyDecide mode: AI evaluates safety instead of asking user ──
    if (this.trustMode === TRUST_AI_SAFETY_DECIDE) {
      // Read tools always allowed without AI evaluation
      if (READ_TOOLS.has(toolName) || toolName === "ContextSearch") {
        return { allowed: true, needsApproval: false };
      }
      // All other tools go through AI safety evaluation
      return { allowed: true, needsApproval: false, needsAiSafety: true };
    }

    // ── open mode: allow everything within workspace ──
    if (this.trustMode === TRUST_OPEN) {
      // Check workspace boundary for file operations
      const filePath = args.file_path || args.path;
      if (filePath && WRITE_TOOLS.has(toolName)) {
        const inWorkspace = this._isInWorkspace(filePath);
        if (!inWorkspace && !this.allowOutsideWorkspace) {
          return { allowed: false, needsApproval: false, reason: `Outside workspace: ${path.resolve(filePath)}` };
        }
      }
      return { allowed: true, needsApproval: false };
    }

    // ── acceptEdits mode: auto-approve file edits, ask for Bash/Fetch ──
    if (this.trustMode === TRUST_ACCEPT_EDITS) {
      // Read tools always allowed
      if (READ_TOOLS.has(toolName) || toolName === "ContextSearch") {
        return { allowed: true, needsApproval: false };
      }
      // File edits auto-approved within workspace
      if (WRITE_TOOLS.has(toolName)) {
        const filePath = args.file_path || args.path;
        if (filePath) {
          const inWorkspace = this._isInWorkspace(filePath);
          if (!inWorkspace && !this.allowOutsideWorkspace) {
            const reason = `File outside workspace: ${path.resolve(filePath)}`;
            return { allowed: true, needsApproval: true, reason, policy: this._buildPermissionPolicy(toolName, args, reason) };
          }
        }
        return { allowed: true, needsApproval: false }; // Auto-approve edits
      }
      // Bash, Fetch, MCP tools need approval
      if (toolName === "Bash" || toolName === "Fetch" || isMcpTool) {
        return { allowed: true, needsApproval: true, reason: null };
      }
      // SubAgent/AgentTeams: allowed
      if (toolName === "SubAgent" || toolName === "SubAgentTeam" || toolName === "AgentTeams") {
        return { allowed: true, needsApproval: false };
      }
      // Skill: allowed
      if (toolName === "Skill") {
        return { allowed: true, needsApproval: false };
      }
      return { allowed: true, needsApproval: true, reason: null };
    }

    // ── approval mode (default): ask for writes and commands ──
    // Read tools always allowed
    if (READ_TOOLS.has(toolName) || toolName === "ContextSearch") {
      return { allowed: true, needsApproval: false };
    }

    // Fetch: special handling
    if (toolName === "Fetch") {
        const method = (args.method || "GET").toUpperCase();
        const hasQuery = args.url && /\?[^#]/.test(args.url);
        if (method !== "GET" || args.body || hasQuery) {
          const reason = `Fetch ${method} requires approval`;
          return { allowed: true, needsApproval: true, reason, policy: this._buildPermissionPolicy(toolName, args, reason) };
        }
        return { allowed: true, needsApproval: false };
      }

    // SubAgent/SubAgentTeam: need approval
    if (toolName === "SubAgent" || toolName === "SubAgentTeam" || toolName === "AgentTeams") {
      return { allowed: true, needsApproval: true, reason: null };
    }

    // Check workspace boundary for file operations (symlink-safe)
    const filePath = args.file_path || args.path;
    if (filePath && WRITE_TOOLS.has(toolName)) {
      const inWorkspace = this._isInWorkspace(filePath);
      if (!inWorkspace && !this.allowOutsideWorkspace) {
        const reason = `File outside workspace: ${path.resolve(filePath)}`;
        return { allowed: true, needsApproval: true, reason, policy: this._buildPermissionPolicy(toolName, args, reason) };
      }
    }

    // Bash always needs approval
    if (toolName === "Bash") {
      return { allowed: true, needsApproval: true, reason: null };
    }
    // Write/Edit/Patch need approval
    if (WRITE_TOOLS.has(toolName)) {
      return { allowed: true, needsApproval: true, reason: null };
    }
    // MCP tools need approval
    if (isMcpTool) {
      return { allowed: true, needsApproval: true, reason: null };
    }
    // Skill: allowed without approval
    if (toolName === "Skill") {
      return { allowed: true, needsApproval: false };
    }

    return { allowed: true, needsApproval: false };
  }

  /**
   * Symlink-safe workspace boundary check.
   * Delegates to shared utility in utils/path-safety.js.
   */
  _isInWorkspace(filePath) {
    return isInWorkspace(filePath, this.workspace);
  }

  async _requestApproval(toolName, args, reason, details = {}) {
    const R = RESET, B = BOLD, D = DIM;
    const Y = YELLOW, G = GRAY, GR = GREEN, RD = RED, C = CYAN;

    const detail = reason || `${toolName} requires approval`;

    console.log("");
    console.log(`${Y}${B}  ╭─ Approval Required ──────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${Y}⚠${R}  ${B}${detail}${R}`);

    if (toolName === "Bash" && args.command) {
      const cmd = args.command.length > 60 ? args.command.slice(0, 57) + "..." : args.command;
      console.log(`${G}  │${R}  ${D}$ ${cmd}${R}`);
    } else if ((toolName === "Write" || toolName === "Edit") && args.file_path) {
      console.log(`${G}  │${R}  ${D}→ ${args.file_path}${R}`);
    } else if (toolName === "Fetch" && args.url) {
      console.log(`${G}  │${R}  ${D}→ ${args.url}${R}`);
    }

    if (details.sourceTags?.length) {
      console.log(`${G}  │${R}  ${D}sources: ${details.sourceTags.join(", ")}${R}`);
    }
    if (details.sourceSources?.length) {
      const preview = details.sourceSources.slice(0, 2).join(" | ");
      console.log(`${G}  │${R}  ${D}provenance: ${preview}${details.sourceSources.length > 2 ? " ..." : ""}${R}`);
    }
    if (details.policy?.kind === "fetch") {
      const parts = [
        details.policy.method,
        details.policy.hasBody ? "body" : null,
        details.policy.hasQuery ? "query" : null,
      ].filter(Boolean);
      console.log(`${G}  │${R}  ${D}policy: fetch ${parts.join(", ")}${R}`);
    }
    if (details.policy?.kind === "outside_write") {
      console.log(`${G}  │${R}  ${D}policy: outside-workspace write${details.policy.path ? ` → ${details.policy.path}` : ""}${R}`);
    }

    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}    ${GR}y${R}${D} = allow    ${RD}n${R}${D} = deny${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${Y}${B}  ╰───────────────────────────────────────────────────────╯${R}`);

    const answer = await this._ask(`  ${Y}${B}Allow? ${R}${D}(y/n)${R} `);
    return answer.trim().toLowerCase().startsWith("y");
  }

  // ── Core loop ────────────────────────────────────────────────────────────

  async _sendAndProcess() {
    let autoRecoverCount = 0;

    printResponseHeader();

    while (true) {
      await this.conversation.compress(
        this.client,
        this.memory,
        (msg) => printInfo(msg),
        this.superCompress
      );

      spinner.start("Thinking...");

      let response;
      try {
        const chunks = [];
        let firstChunk = true;

        // Filter tools through labs system
        const labsFiltered = TOOL_DEFINITIONS.filter((t) => labs.isToolAllowed(t.function.name));

        // Legacy ContextSearch toggle (kept for backwards compat, also gated by labs)
        let activeTools = this.contextSearchEnabled
          ? labsFiltered
          : labsFiltered.filter((t) => t.function.name !== "ContextSearch");

        // Add MCP tools
        const mcpDefs = this.mcpManager.getToolDefinitions();
        if (mcpDefs.length > 0) {
          activeTools = [...activeTools, ...mcpDefs];
        }

        // Add Skill tool if skills are available.
        // SECURITY: In restrictive trust modes (approval, dontAsk), exclude
        // project-level skills since they are untrusted (anyone can commit
        // a .mercury/skills/*.md file). Only user-level skills are included.
        const skillDef = this.skillManager.getToolDefinition({ excludeProjectSkills: true });
        if (skillDef) {
          activeTools = [...activeTools, skillDef];
        }

        // In readonly mode, only allow read tools
        const permittedTools = this.trustMode === TRUST_READONLY
          ? activeTools.filter((t) => READ_TOOLS.has(t.function.name) || t.function.name === "ContextSearch")
          : activeTools;

        let inReasoning = false;
        let hasContent = false;

        // Streaming Markdown renderer: renders each complete line in real-time
        // with full formatting (headers, bold, code blocks, LaTeX, tables, etc.)
        const mdRenderer = new TerminalMarkdownRenderer();

        for await (const chunk of this.client.chatCompletionStream(
          this.conversation.getMessages(),
          { tools: permittedTools }
        )) {
          if (firstChunk) {
            spinner.stop();
            firstChunk = false;
          }
          chunks.push(chunk);
          const delta = chunk.choices?.[0]?.delta;

          const reasoning = delta?.reasoning_content || delta?.reasoning;
          if (reasoning) {
            if (!inReasoning) {
              inReasoning = true;
              printStreamChunk("\x1b[2m\x1b[3m\ud83d\udcad ");
            }
            printStreamChunk(reasoning);
          }

          if (delta?.content) {
            if (inReasoning) {
              inReasoning = false;
              printStreamChunk("\x1b[0m\n");
            }
            hasContent = true;
            // Stream through Markdown renderer for real-time formatted output
            mdRenderer.write(delta.content);
          }
        }

        if (firstChunk) spinner.stop();
        if (inReasoning) printStreamChunk("\x1b[0m\n");

        // Flush any remaining buffered content in the Markdown renderer
        if (hasContent) {
          mdRenderer.flush();
          printStreamEnd();
        }

        response = this._assembleStreamResponse(chunks);
        if (response.usage) this.conversation.updateUsage(response.usage);
      } catch (err) {
        spinner.stop();
        printError(`API error: ${err.message}`);
        if (this.verbose) console.error(err.stack);
        printResponseFooter();
        return;
      }

      // Auto-recovery for truncated output
      if (
        response.finish_reason === "length" &&
        !response.tool_calls &&
        autoRecoverCount < MAX_AUTO_RECOVER
      ) {
        autoRecoverCount++;
        printInfo(`Output truncated \u2014 auto-recovering (${autoRecoverCount}/${MAX_AUTO_RECOVER})...`);
        this.conversation.addAssistantMessage(response.content || "");
        this.conversation.addUserMessage(
          "[System: Your previous output was truncated due to length. Continue from where you left off.]"
        );
        continue;
      }

      // Tool calls
      if (response.tool_calls && response.tool_calls.length > 0) {
        this._toolTurnCount++;
        autoRecoverCount = 0;

        if (this._toolTurnCount > MAX_TOOL_TURNS) {
          printError(`Max tool turns (${MAX_TOOL_TURNS}) reached.`);
          this.conversation.addAssistantMessage(
            response.content || "(Stopped: max tool turns)"
          );
          printResponseFooter();
          return;
        }

        this.conversation.addAssistantMessage(
          response.content || null,
          response.tool_calls
        );
        this.log.append({ // fire-and-forget, queue handles ordering
          role: "assistant",
          content: response.content,
          tool_calls: response.tool_calls.map((tc) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        });

        for (const tc of response.tool_calls) {
          // Check if user pressed Ctrl+C to abort
          if (this._aborted) {
            const abortMsg = "Aborted by user (Ctrl+C).";
            this.conversation.addToolResult(tc.id, abortMsg);
            printWarning("Remaining tool calls skipped.");
            break;
          }

          const fnName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (err) {
            debugLog("MercuryRepl._processToolCalls.parseArgs", err);
            printError(`Bad JSON arguments for tool "${fnName}"`);
            const errMsg = "Error: Invalid JSON in tool arguments.";
            this.conversation.addToolResult(tc.id, errMsg);
            this.log.append({ role: "tool", name: fnName, result: errMsg }); // fire-and-forget
            continue;
          }

          const hookResult = await this.hooks.firePreToolUse(fnName, args);
          if (hookResult.action === "deny") {
            printToolCall(fnName, args);
            const errMsg = `Blocked by hook: ${hookResult.message || "Tool denied."}`;
            printToolResult(errMsg);
            this.conversation.addToolResult(tc.id, errMsg);
            this.log.append({ role: "tool", name: fnName, result: errMsg }); // fire-and-forget
            continue;
          }
          if (hookResult.action === "modify" && hookResult.updatedInput) {
            args = { ...args, ...hookResult.updatedInput };
          }

          const perm = await this._checkPermission(fnName, args);
          if (perm.updatedArgs) {
            args = perm.updatedArgs;
          }
          const hookAllows = hookResult.action === "allow";
          const hookAsks = hookResult.action === "ask";

          if (!perm.allowed) {
            printToolCall(fnName, args);
            const errMsg = `Blocked: ${perm.reason}`;
            printToolResult(errMsg);
            this.conversation.addToolResult(tc.id, errMsg);
            this.log.append({ role: "tool", name: fnName, result: errMsg }); // fire-and-forget
            continue;
          }

          let approvalReason = null;

          // Taint check: detect if tool args reference untrusted content
          let taintResult = null;
          if (this._taintTracker) {
            taintResult = this._taintTracker.check(fnName, args, this.conversation?.messages || []);
            if (taintResult.tainted) {
              debugLog("TaintTracker.check", `${fnName}: ${taintResult.summary}`);
            }
          }

          if (this._actionSafetyLead?.enabled && !hookAllows) {
            const leadResult = await this._actionSafetyLead.review(
              fnName,
              args,
              this.conversation?.messages || [],
              {
                source_tags: taintResult?.tags || [],
                source_sources: taintResult?.sources || [],
                policy: perm.policy || null,
                trust_mode: this.trustMode,
              }
            );
            // If taint detected and action was going to be allowed, escalate instead
            if (leadResult.decision !== ACTION_DENY && leadResult.decision !== ACTION_TERMINATE
                && taintResult?.tainted) {
              const taintWarning = `Taint detected: tool args reference ${taintResult.tags.join(", ")} content`;
              if (!approvalReason) {
                approvalReason = taintWarning;
              }
            }
            if (leadResult.decision === ACTION_DENY) {
              printToolCall(fnName, args);
              const errMsg = `Action Safety blocked: ${leadResult.reason}`;
              printToolResult(errMsg);
              this.conversation.addToolResult(tc.id, errMsg);
              this.log.append({ role: "tool", name: fnName, result: errMsg });
              continue;
            }
            if (leadResult.decision === ACTION_TERMINATE) {
              printToolCall(fnName, args);
              const errMsg = `Action Safety terminated this task: ${leadResult.reason}`;
              printToolResult(errMsg);
              this.conversation.addToolResult(tc.id, errMsg);
              this.log.append({ role: "tool", name: fnName, result: errMsg });
              printResponseFooter();
              return;
            }
            if (leadResult.decision === ACTION_ESCALATE) {
              approvalReason = `Action Safety escalated: ${leadResult.reason}`;
            }
          }
          if (!approvalReason && perm.needsAiSafety && this._aiSafetyDecider && !hookAllows) {
            printToolCall(fnName, args);
            const userTask = this.conversation.messages?.[0]?.content || "";
            const safetyResult = await this._aiSafetyDecider.evaluate(
              fnName, args, userTask, this.conversation.messages || []
            );
            if (safetyResult.decision === "DENY") {
              const errMsg = `AI Safety blocked: ${safetyResult.reason}${safetyResult.suggestion ? ` Suggestion: ${safetyResult.suggestion}` : ""}`;
              printToolResult(errMsg);
              this.conversation.addToolResult(tc.id, errMsg);
              this.log.append({ role: "tool", name: fnName, result: errMsg }); // fire-and-forget
              continue;
            }
            if (safetyResult.decision === "ESCALATE") {
              approvalReason = `AI Safety escalated (${(safetyResult.confidence * 100).toFixed(0)}%): ${safetyResult.reason}`;
            }
          }

          if (!approvalReason && hookAsks) {
            approvalReason = hookResult.message || perm.reason || "Hook requested approval.";
          }
          if (!approvalReason && perm.needsApproval && !hookAllows) {
            approvalReason = perm.reason;
          }

          if (approvalReason) {
            printToolCall(fnName, args);
            const approved = await this._requestApproval(fnName, args, approvalReason, {
              sourceTags: taintResult?.tags || [],
              sourceSources: taintResult?.sources || [],
              policy: perm.policy || null,
            });
            if (!approved) {
              const errMsg = "User denied this operation.";
              printToolResult(errMsg);
              this.conversation.addToolResult(tc.id, errMsg);
              this.log.append({ role: "tool", name: fnName, result: errMsg }); // fire-and-forget
              continue;
            }
          } else if (!perm.needsAiSafety || hookAllows) {
            printToolCall(fnName, args);
          }

          // Token-based outside-workspace bypass: if user approved an outside-workspace
          // write, grant a unique cryptographic token for THIS single call only,
          // scoped to the exact file path being written. The token is consumed on use
          // or revoked in the finally block — no persistent backdoor,
          // and no race condition between concurrent calls sharing a boolean flag.
          const isOutsideApproved = perm.needsApproval && perm.reason &&
            perm.reason.includes("outside workspace");
          let outsideToken = null;
          if (isOutsideApproved) {
            // Normalize via path.resolve() to match executor's normalization
            // (executor calls path.resolve(file_path) before _consumeOutsideWriteToken)
            const targetPath = path.resolve(args.file_path || args.path || '');
            outsideToken = this.toolExecutor.grantOutsideWriteToken(targetPath);
          }

          spinner.start(`Running ${fnName}...`);
          let result, toolElapsed;
          try {
            const toolStart = Date.now();
            // Route to appropriate executor
            if (this.mcpManager.isMcpTool(fnName)) {
              result = await this.mcpManager.executeTool(fnName, args);
            } else if (fnName === "Skill") {
              result = await this._executeSkill(args);
            } else {
              result = await this.toolExecutor.execute(fnName.toLowerCase(), args);
            }
            toolElapsed = Date.now() - toolStart;
            result = String(result);
            await this.hooks.firePostToolUse(fnName, args, result);
          } catch (err) {
            spinner?.stop?.();
            const errorMsg = `Tool execution error: ${err.message || String(err)}`;
            this.conversation.addToolResult(tc.id, errorMsg);
            printError(errorMsg);
            continue;
          } finally {
            // Revoke the token if it wasn't consumed (e.g. error before write check)
            if (outsideToken) {
              this.toolExecutor.revokeOutsideWriteToken(outsideToken);
            }
          }
          spinner.stop();
          printToolResult(result, toolElapsed);

          // ── Context Sentinel: scan high-risk tool outputs for injection ──
          let finalResult = result;
          if (this._contextSentinel?.enabled) {
            try {
              const sentinelCheck = await this._contextSentinel.checkToolOutput(fnName, args, result);
              if (!sentinelCheck.allowed) {
                const blockedMsg = `[Sentinel blocked tool output] Potential prompt injection in ${fnName} result: ${sentinelCheck.reason}`;
                printError(blockedMsg);
                finalResult = blockedMsg;
              } else if (sentinelCheck.verdict === VERDICT_SUSPICIOUS && sentinelCheck.sanitized) {
                // Use sanitized version with warning banner
                finalResult = sentinelCheck.sanitized;
              }
            } catch (err) {
              debugLog("MercuryRepl.sentinel.toolOutput", err);
              finalResult = `[Sentinel blocked tool output] Safety analysis failed for ${fnName} result: ${err.message}`;
              printError(finalResult);
            }
          }

          // Register taint for provenance tracking
          if (this._taintTracker) {
            this._taintTracker.registerToolResult(fnName, args, String(result), tc.id);
          }
          // Wrap tool result in content fence to mitigate prompt injection
          this.conversation.addToolResult(tc.id, encodeUntrustedToolResult(finalResult));
          this.log.append({ role: "tool", name: fnName, result: String(result) }); // fire-and-forget
        }

        // If aborted during tool execution, stop the agentic loop
        if (this._aborted) {
          this.conversation.addAssistantMessage(
            response.content || "(Interrupted by user)"
          );
          printResponseFooter();
          return;
        }

        continue;
      }

      // Final text response
      this.conversation.addAssistantMessage(response.content || "");
      this.log.append({ role: "assistant", content: response.content }); // fire-and-forget
      const emptyResponseHint = this._getEmptyResponseHint(response);
      if (emptyResponseHint) {
        printWarning(emptyResponseHint);
      }
      if (response.usage) {
        printTokenUsage(response.usage);
        this.conversation.updateUsage(response.usage);
      }
      // Context usage warning
      const usedTokens = this.conversation.getTokenEstimate();
      const contextPct = usedTokens / this._getMaxContextTokens();
      if (contextPct > 0.9) {
        printWarning("Context usage above 90%. Consider /clear or /supercompress to free space.");
      } else if (contextPct > 0.75) {
        printWarning("Context usage above 75%. Compression may trigger soon.");
      }
      printResponseFooter({
        usedTokens,
        maxTokens: this._getMaxContextTokens(),
      });
      return;
    }
  }

  // ── Rollback Mode ─────────────────────────────────────────────────────────

  async _enterRollbackMode() {
    const checkpoints = this.rollback.getCheckpoints();
    if (checkpoints.length === 0) {
      printInfo("No checkpoints available.");
      return;
    }

    this._inRollbackMode = true;
    let selectedIdx = 0;
    let phase = "select";
    let confirmIdx = 0;

    const render = () => {
      if (phase === "select") printRollbackUI(checkpoints, selectedIdx);
      else printRollbackConfirm(checkpoints[selectedIdx], confirmIdx);
    };

    render();

    return new Promise((resolve) => {
      const onKey = (str, key) => {
        if (!key) return;
        if (key.name === "escape") { cleanup(); return; }

        if (phase === "select") {
          if (key.name === "up" && selectedIdx > 0) { selectedIdx--; render(); }
          else if (key.name === "down" && selectedIdx < checkpoints.length - 1) { selectedIdx++; render(); }
          else if (key.name === "return") { phase = "confirm"; confirmIdx = 0; render(); }
        } else {
          if (key.name === "up" && confirmIdx > 0) { confirmIdx--; render(); }
          else if (key.name === "down" && confirmIdx < 2) { confirmIdx++; render(); }
          else if (key.name === "return") { executeRollback(confirmIdx); cleanup(); }
        }
      };

      const executeRollback = (option) => {
        try {
          const cpIndex = checkpoints[selectedIdx].index;
          if (option === 0) {
            const result = this.rollback.fullRollback(cpIndex, this.conversation.messages);
            if (result.restored) {
              this.conversation.messages = result.messages;
              printSuccess(`Full rollback to checkpoint ${cpIndex + 1}.`);
            } else printError("Rollback failed.");
          } else if (option === 1) {
            const result = this.rollback.contextRollback(cpIndex, this.conversation.messages);
            if (result.restored) {
              this.conversation.messages = result.messages;
              printSuccess(`Context restored to checkpoint ${cpIndex + 1}.`);
            } else printError("Context restore failed.");
          }
          // option === 2 is Cancel — do nothing
        } catch (err) {
          printError(`Rollback error: ${err.message}`);
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKey);
        this._inRollbackMode = false;
        process.stdout.write("\x1b[2J\x1b[H");
        printInfo("Exited rollback mode.");
        this._rl.setPrompt(this._buildPrompt());
    this._rl.prompt();
        resolve();
      };

      process.stdin.on("keypress", onKey);
    });
  }

  // ── Slash commands ───────────────────────────────────────────────────────

  async _handleCommand(cmd) {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    // ── Internal web-bridge protocol (not a user-facing command) ──
    if (command === "/_web_submit") {
      if (!this.webBridgeMode) {
        printError("This command is only available in web bridge mode.");
        return;
      }
      const encoded = parts.slice(1).join("");
      if (!encoded) {
        printError("Missing web submission payload.");
        return;
      }
      let decoded;
      try {
        decoded = Buffer.from(encoded, "base64").toString("utf-8");
      } catch (err) {
        debugLog("MercuryRepl._handleWebSubmission.decode", err);
        printError("Invalid web submission payload.");
        return;
      }
      if (!decoded.trim()) {
        printInfo("Ignored empty web submission.");
        return;
      }
      try {
        await this._submitUserText(decoded, {
          resolveFileMentions: true,
          logContent: decoded,
        });
      } catch (err) {
        printError(`Error: ${err.message}`);
      }
      return;
    }

    // ── Delegate to CommandRouter for all registered slash commands ──
    const cmdName = command.startsWith("/") ? command.slice(1) : command;
    if (await this._commandRouter.execute(cmdName, parts)) {
      return;
    }

    // ── Skill invocation fallback: /skillname [args] ──
    if (command.startsWith("/") && this.skillManager.has(cmdName)) {
      const skillArgs = parts.slice(1).join(" ");
      const skill = this.skillManager.get(cmdName);
      try {
        const rendered = await this._prepareSkillPrompt(cmdName, skill, skillArgs);
        printInfo(`Running skill: ${cmdName}`);
        await this._submitUserText(rendered, {
          resolveFileMentions: false,
          logContent: `[Skill: /${cmdName}] ${rendered}`,
        });
      } catch (err) {
        printError(`Error: ${err.message}`);
      }
      return;
    }

    printError(`Unknown command: ${cmd}. Type /help for commands.`);
  }

  // ── History ──────────────────────────────────────────────────────────────

  async _handleHistory(args) {
    const subCmd = args[0]?.toLowerCase();
    if (!subCmd || subCmd === "list") {
      const sessions = await this.history.list();
      printSessionList(sessions);
      return;
    }
    if (subCmd === "save") {
      const filepath = await this.history.save(this._getSessionSnapshot());
      printSuccess(`Saved: ${filepath}`);
      return;
    }
    if (subCmd === "restore") {
      const id = args[1];
      if (!id) { printError("Usage: /history restore <number>"); return; }
      const session = await this.history.load(id);
      if (!session) { printError(`Not found: ${id}`); return; }
      const { workspaceChanged, messageCount } = await this._restoreSession(session);
      if (workspaceChanged) {
        printInfo(`Workspace switched to saved session root: ${this.workspace}`);
      }
      printSuccess(`Restored (${messageCount} messages)`);
      return;
    }
    printError(`Unknown: ${subCmd}. Options: list, save, restore`);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async _handleSettings(args) {
    const subCmd = args[0]?.toLowerCase();
    if (!subCmd) {
      const G = GRAY, R = RESET, C = CYAN, B = BOLD;
      const GR = GREEN, D = DIM;
      console.log("");
      console.log(`${B}${C}  \u256d\u2500 Settings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e${R}`);
      const sandboxStatus = this.sandbox.getStatus();
      const rows = [
        ["model", this.client.config.model],
        ["reasoning", this.client.config.reasoning_effort],
        ["temperature", this.client.config.temperature],
        ["max_tokens", this.client.config.max_tokens],
        ["stream", this.client.config.stream],
        ["diffusing", this.client.config.diffusing],
        ["api_base", this.client.baseURL],
        ["api_key", this.client.apiKey ? this.client.apiKey.slice(0, 8) + "..." + this.client.apiKey.slice(-4) : "(not set)"],
        ["workspace", this.workspace],
        ["trust", this.trustMode],
        ["sandbox", `${sandboxStatus.mode} (${sandboxStatus.backend})`],
        ["supercompress", this.superCompress ? "ON" : "OFF"],
        ["contextsearch", this.contextSearchEnabled ? "ON" : "OFF"],
        ["labs", labs.enabled ? "ON" : "OFF"],
        ["planet_logo", this.showPlanet ? "ON" : "OFF"],
      ];
      for (const [k, v] of rows) {
        console.log(`${G}  \u2502${R}  ${GR}${k.padEnd(15)}${R} ${D}${v}${R}`);
      }
      console.log(`${B}${C}  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f${R}`);
      console.log("");
      printInfo("Usage: /settings <key> <value>");
      console.log("");
      return;
    }

    const value = args.slice(1).join(" ");
    if (!value) { printError(`Usage: /settings ${subCmd} <value>`); return; }
    const boolValue = this._parseBooleanSetting(value);

    switch (subCmd) {
      case "model": this.client.config.model = value; break;
      case "reasoning":
        if (!REASONING_LEVELS.includes(value)) { printError(`Invalid. Options: ${REASONING_LEVELS.join(", ")}`); return; }
        this.client.config.reasoning_effort = value; break;
      case "temperature": {
        const t = parseFloat(value);
        if (isNaN(t) || t < 0 || t > 2) { printError("Must be 0-2."); return; }
        this.client.config.temperature = t; break;
      }
      case "max_tokens": {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1 || n > 50000) { printError("Must be 1-50000."); return; }
        this.client.config.max_tokens = n; break;
      }
      case "stream":
        if (boolValue === null) { printError("Must be one of: true, false, on, off, 1, 0."); return; }
        this.client.config.stream = boolValue;
        break;
      case "diffusing":
        if (boolValue === null) { printError("Must be one of: true, false, on, off, 1, 0."); return; }
        this.client.config.diffusing = boolValue;
        break;
      case "api_base":
        this._setClientConnection({ baseURL: value });
        break;
      case "api_key":
        this._setClientConnection({ apiKey: value });
        break;
      case "supercompress":
        if (boolValue === null) { printError("Must be one of: true, false, on, off, 1, 0."); return; }
        this.superCompress = boolValue;
        break;
      case "contextsearch":
        if (boolValue === null) { printError("Must be one of: true, false, on, off, 1, 0."); return; }
        this.contextSearchEnabled = boolValue;
        break;
      case "planet_logo":
        if (boolValue === null) { printError("Must be one of: true, false, on, off, 1, 0."); return; }
        this.showPlanet = boolValue;
        break;
      default:
        printError(`Unknown setting: ${subCmd}`);
        return;
    }
    printSuccess(`${subCmd} updated.`);
  }

  // ── Sandbox management ──────────────────────────────────────────────

  async _handleSandbox(args) {
    const subCmd = args[0]?.toLowerCase();

    // No args: show current sandbox status
    if (!subCmd) {
      const R = RESET, B = BOLD, D = DIM;
      const C = CYAN, G = GRAY, GR = GREEN;

      const status = this.sandbox.getStatus();
      console.log("");
      console.log(`${B}${C}  ╭─ Sandbox ─────────────────────────────────────────────╮${R}`);
      const rows = [
        ["mode", status.mode],
        ["backend", status.backend],
        ["sub-agents", this.sandbox.sandboxSubAgents ? "sandboxed" : "unsandboxed"],
        ["network", this.sandbox.allowNetwork ? "allowed" : "blocked"],
        ["domains", this.sandbox.allowedDomains.length > 0 ? this.sandbox.allowedDomains.join(", ") : "(all)"],
      ];
      for (const [k, v] of rows) {
        console.log(`${G}  │${R}  ${GR}${k.padEnd(15)}${R} ${D}${v}${R}`);
      }
      console.log(`${B}${C}  ╰─────────────────────────────────────────────────────────╯${R}`);
      console.log("");
      printInfo("Usage: /sandbox on|off|strict|subagents|network");
      printInfo("Tip: subagents and network toggle their current state.");
      console.log("");
      return;
    }

    // Change sandbox mode
    if (subCmd === "on" || subCmd === "1") {
      this.sandbox.setMode(SANDBOX_ON);
      this.toolExecutor.sandbox = this.sandbox;
      this._refreshConversationSystemPrompt();
      printSuccess("Sandbox: ON (workspace-scoped, resource limits)");
      return;
    }
    if (subCmd === "strict" || subCmd === "2") {
      this.sandbox.setMode(SANDBOX_STRICT);
      this.toolExecutor.sandbox = this.sandbox;
      this._refreshConversationSystemPrompt();
      printSuccess("Sandbox: STRICT (read-only root, network restricted)");
      return;
    }
    if (subCmd === "off" || subCmd === "3") {
      this.sandbox.setMode(SANDBOX_OFF);
      this.toolExecutor.sandbox = this.sandbox;
      this._refreshConversationSystemPrompt();
      printWarning("Sandbox: OFF — no isolation active");
      return;
    }

    // Toggle sub-agent sandboxing
    if (subCmd === "subagents") {
      this.sandbox.sandboxSubAgents = !this.sandbox.sandboxSubAgents;
      this._refreshConversationSystemPrompt();
      printInfo(`Sub-agent sandbox: ${this.sandbox.sandboxSubAgents ? "ON" : "OFF"}`);
      return;
    }

    // Toggle network access
    if (subCmd === "network") {
      this.sandbox.allowNetwork = !this.sandbox.allowNetwork;
      this._refreshConversationSystemPrompt();
      printInfo(`Sandbox network: ${this.sandbox.allowNetwork ? "allowed" : "blocked"}`);
      return;
    }

    printError(`Unknown sandbox option: ${subCmd}. Options: on, off, strict, subagents, network`);
  }

  // ── Context Sentinel management ─────────────────────────────────────────

  async _handleSentinel(args) {
    const subCmd = args[0]?.toLowerCase();
    const sentinel = this._contextSentinel;

    // No args: show current sentinel status
    if (!subCmd) {
      const R = RESET, B = BOLD, D = DIM;
      const C = CYAN, G = GRAY, GR = GREEN;
      const stats = sentinel.getStats();

      console.log("");
      console.log(`${B}${C}  ╭─ Context Sentinel ──────────────────────────────────────╮${R}`);
      const rows = [
        ["enabled", sentinel.enabled ? "yes" : "no"],
        ["mode", sentinel.mode],
        ["checked", String(stats.checked)],
        ["safe", String(stats.safe)],
        ["suspicious", String(stats.suspicious)],
        ["blocked", String(stats.blocked)],
        ["errors", String(stats.errors)],
        ["cache hits", String(stats.cacheHits)],
      ];
      for (const [k, v] of rows) {
        console.log(`${G}  │${R}  ${GR}${k.padEnd(15)}${R} ${D}${v}${R}`);
      }
      console.log(`${B}${C}  ╰──────────────────────────────────────────────────────────╯${R}`);
      console.log("");
      printInfo("Usage: /sentinel on|off|warn|strict|monitor|rescan");
      printInfo("  on/off    — enable/disable sentinel");
      printInfo("  warn      — allow suspicious content with warning (default)");
      printInfo("  strict    — block suspicious content too");
      printInfo("  monitor   — log only, never block");
      printInfo("  rescan    — re-scan current workspace config");
      console.log("");
      return;
    }

    if (subCmd === "on" || subCmd === "enable") {
      sentinel.enabled = true;
      printSuccess("Context Sentinel: enabled");
      return;
    }
    if (subCmd === "off" || subCmd === "disable") {
      sentinel.enabled = false;
      printInfo("Context Sentinel: disabled");
      return;
    }
    if (subCmd === "warn" || subCmd === "strict" || subCmd === "monitor") {
      sentinel.mode = subCmd;
      printSuccess(`Context Sentinel mode: ${subCmd}`);
      return;
    }
    if (subCmd === "rescan") {
      if (!sentinel.enabled) {
        printError("Sentinel is disabled. Use /sentinel on first.");
        return;
      }
      printInfo("Re-scanning workspace config...");
      sentinel._cache.clear();
      await this._refreshProjectConfig({ announce: true });
      printSuccess("Workspace config re-scanned.");
      return;
    }

    printError(`Unknown sentinel option: ${subCmd}. Options: on, off, warn, strict, monitor, rescan`);
  }

  // ── MCP management ──────────────────────────────────────────────────────

  async _handleMcp(args) {
    const subCmd = args[0]?.toLowerCase();

    if (!subCmd || subCmd === "status") {
      const servers = this.mcpManager.getStatus();
      if (servers.length === 0) {
        printInfo("No MCP servers configured.");
        printInfo("Global config: ~/.mercury/mcp.json");
        printInfo("Project MCP config is disabled by default. Start Mercury with --allow-project-mcp to load .mercury/mcp.json or .mcp.json.");
      } else {
        printMcpStatus(servers);
      }
      return;
    }

    if (subCmd === "reload") {
      printInfo("Reloading MCP servers...");
      await this.mcpManager.shutdown();
      const result = await this.mcpManager.loadConfig(this.workspace, this._mcpConfigPath, {
        allowProjectConfig: this.allowProjectMcp,
      });
      if (result.count > 0) {
        printSuccess(`Loaded ${result.count} MCP server(s) from ${result.path}`);
        printMcpStatus(this.mcpManager.getStatus());
      } else {
        printInfo("No MCP servers found.");
      }
      return;
    }

    printError(`Unknown /mcp option: ${subCmd}. Options: status, reload`);
  }

  // ── Skills management ─────────────────────────────────────────────────────

  _handleSkills() {
    if (this.skillManager.count === 0) {
      printInfo("No skills found.");
      printInfo("Create .mercury/skills/<name>.md with YAML frontmatter.");
      return;
    }
    console.log(this.skillManager.formatList());
  }

  // ── Export conversation ──────────────────────────────────────────────────

  /**
   * Export the full conversation history to a user-specified file.
   * Usage: /export [filename]
   * If no filename given, prompts the user.
   * Supports: .json, .md, .txt, .html
   */
  async _handleExport(args) {
    let filename = args.join(" ").trim();

    if (!filename) {
      printInfo("Export conversation to a file.");
      printInfo("Specify a filename with extension (e.g. chat.md, log.json, notes.txt)");
      filename = (await this._ask("  \x1b[38;5;87m\x1b[1mFilename:\x1b[0m ")).trim();
      if (!filename) {
        printInfo("Export cancelled.");
        return;
      }
    }

    // Resolve path relative to workspace
    const filePath = path.resolve(this.workspace, filename);
    const ext = path.extname(filename).toLowerCase();
    const messages = this.conversation ? this.conversation.getMessages() : [];

    if (messages.length === 0) {
      printWarning("No conversation to export.");
      return;
    }

    let content;
    switch (ext) {
      case ".json":
        content = JSON.stringify({
          exported: new Date().toISOString(),
          session: this._sessionId,
          workspace: this.workspace,
          model: this.client.config.model,
          messages: messages.map(m => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
        }, null, 2);
        break;

      case ".html":
        content = this._exportAsHtml(messages);
        break;

      case ".md":
        content = this._exportAsMarkdown(messages);
        break;

      default:
        // .txt or any other extension — plain text
        content = this._exportAsText(messages);
        break;
    }

    try {
      // Ensure parent directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, "utf-8");
      const sizeKb = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);
      printSuccess(`Exported ${messages.length} messages to ${filePath} (${sizeKb} KB)`);
    } catch (err) {
      printError(`Export failed: ${err.message}`);
    }
  }

  _exportAsMarkdown(messages) {
    const lines = [];
    lines.push(`# Mercury Code — Conversation Export`);
    lines.push(`> Exported: ${new Date().toISOString()}`);
    lines.push(`> Session: ${this._sessionId}`);
    lines.push(`> Model: ${this.client.config.model}`);
    lines.push(`> Workspace: ${this.workspace}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    for (const msg of messages) {
      if (msg.role === "system") {
        lines.push("## System Prompt");
        lines.push("");
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push("<details><summary>System prompt (click to expand)</summary>");
        lines.push("");
        lines.push("```");
        lines.push(text.slice(0, 2000) + (text.length > 2000 ? "\n... (truncated)" : ""));
        lines.push("```");
        lines.push("</details>");
        lines.push("");
      } else if (msg.role === "user") {
        lines.push("### User");
        lines.push("");
        lines.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
        lines.push("");
      } else if (msg.role === "assistant") {
        lines.push("### Mercury");
        lines.push("");
        if (typeof msg.content === "string") {
          lines.push(msg.content);
        } else if (msg.content === null && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const argStr = typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments);
            lines.push(`**Tool call:** \`${tc.function.name}\``);
            lines.push("```json");
            lines.push(argStr.length > 500 ? argStr.slice(0, 500) + "..." : argStr);
            lines.push("```");
          }
        }
        lines.push("");
      } else if (msg.role === "tool") {
        lines.push(`**Tool result** (\`${msg.tool_call_id || "?"}\`):`);
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push("```");
        lines.push(text.length > 1000 ? text.slice(0, 1000) + "\n... (truncated)" : text);
        lines.push("```");
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  _exportAsText(messages) {
    const lines = [];
    lines.push(`Mercury Code — Conversation Export`);
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push(`Session: ${this._sessionId}`);
    lines.push(`Model: ${this.client.config.model}`);
    lines.push(`Workspace: ${this.workspace}`);
    lines.push("=".repeat(60));
    lines.push("");

    for (const msg of messages) {
      if (msg.role === "system") continue; // Skip system prompt in text export
      const label = msg.role === "user" ? "USER" : msg.role === "assistant" ? "MERCURY" : "TOOL";
      lines.push(`[${label}]`);
      if (typeof msg.content === "string") {
        lines.push(msg.content);
      } else if (msg.content === null && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          lines.push(`  → ${tc.function.name}(${typeof tc.function.arguments === "string" ? tc.function.arguments.slice(0, 200) : "..."})`);
        }
      } else {
        lines.push(JSON.stringify(msg.content));
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  _exportAsHtml(messages) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lines = [];
    lines.push("<!DOCTYPE html>");
    lines.push("<html><head><meta charset='utf-8'>");
    lines.push("<title>Mercury Code — Conversation Export</title>");
    lines.push("<style>");
    lines.push("body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:2em;background:#0d1117;color:#c9d1d9}");
    lines.push(".msg{margin:1em 0;padding:1em;border-radius:8px;border-left:3px solid}");
    lines.push(".user{border-color:#58a6ff;background:#161b22}");
    lines.push(".assistant{border-color:#3fb950;background:#161b22}");
    lines.push(".tool{border-color:#d29922;background:#161b22;font-size:0.9em}");
    lines.push(".role{font-weight:bold;font-size:0.85em;text-transform:uppercase;margin-bottom:0.5em}");
    lines.push(".user .role{color:#58a6ff}");
    lines.push(".assistant .role{color:#3fb950}");
    lines.push(".tool .role{color:#d29922}");
    lines.push("pre{background:#0d1117;padding:0.5em;border-radius:4px;overflow-x:auto;font-size:0.85em}");
    lines.push("h1{color:#58a6ff}");
    lines.push(".meta{color:#8b949e;font-size:0.8em}");
    lines.push("</style></head><body>");
    lines.push(`<h1>☿ Mercury Code</h1>`);
    lines.push(`<p class="meta">Exported: ${new Date().toISOString()} | Session: ${esc(this._sessionId)} | Model: ${esc(this.client.config.model)}</p>`);
    lines.push("<hr>");

    for (const msg of messages) {
      if (msg.role === "system") continue;
      const cls = msg.role;
      const label = msg.role === "user" ? "User" : msg.role === "assistant" ? "Mercury" : "Tool";
      lines.push(`<div class="msg ${cls}">`);
      lines.push(`<div class="role">${label}</div>`);

      if (typeof msg.content === "string") {
        lines.push(`<div>${esc(msg.content).replace(/\n/g, "<br>")}</div>`);
      } else if (msg.content === null && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const argStr = typeof tc.function.arguments === "string"
            ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          lines.push(`<div><strong>${esc(tc.function.name)}</strong></div>`);
          lines.push(`<pre>${esc(argStr.slice(0, 500))}</pre>`);
        }
      }
      lines.push("</div>");
    }

    lines.push("</body></html>");
    return lines.join("\n");
  }

  /**
   * Execute a skill by name (called when model invokes the Skill tool).
   */
  async _executeSkill(args) {
    const skillName = args.skill;
    const skill = this.skillManager.get(skillName);
    if (!skill) {
      return `Error: Skill "${skillName}" not found. Available: ${this.skillManager.getAll().map(s => s.name).join(", ")}`;
    }
    const rendered = await this._prepareSkillPrompt(skillName, skill, args.args || "");
    return `[Skill "${skillName}" prompt injected into conversation]\n\n${rendered}`;
  }

  // ── Agent management ─────────────────────────────────────────────────────

  async _handleAgents(args) {
    const subCmd = args[0]?.toLowerCase();

    if (!subCmd || subCmd === "list") {
      const agents = await discoverAgents(this.workspace);
      console.log(formatAgentList(agents));
      return;
    }

    if (subCmd === "create" || subCmd === "new") {
      const name = args[1];
      if (!name) {
        printError("Usage: /agents create <name>");
        return;
      }
      try {
        const filePath = await scaffoldAgent(this.workspace, name);
        printSuccess(`Created agent: ${filePath}`);
        printInfo("Edit the file to customize the agent's system prompt and tools.");
        // Clear agent cache
        this.toolExecutor._agents = null;
      } catch (err) {
        printError(`Error creating agent: ${err.message}`);
      }
      return;
    }

    printError(`Unknown /agents option: ${subCmd}. Options: list, create <name>`);
  }

  // ── /labs command ────────────────────────────────────────────────────────

  async _handleLabs(args) {
    const G = GRAY, R = RESET, C = CYAN, B = BOLD;
    const GR = GREEN, RD = RED, YL = YELLOW, D = DIM;

    const subCmd = args[0]?.toLowerCase();

    // /labs — show all features
    if (!subCmd) {
      console.log("");
      console.log(`${B}${C}  ╭─ Labs (Experimental Features) ${"─".repeat(28)}╮${R}`);
      console.log(`${G}  │${R}  Master switch: ${labs.enabled ? `${GR}${B}ON${R}` : `${RD}OFF${R}`}${D}    (/labs on|off)${R}`);
      console.log(`${G}  │${R}`);

      const snapshot = labs.snapshot();
      let lastCategory = "";
      for (const feat of snapshot) {
        if (feat.category !== lastCategory) {
          lastCategory = feat.category;
          console.log(`${G}  │${R}  ${B}${C}${feat.category}${R}`);
        }
        const statusIcon = feat.active ? `${GR}●${R}` : feat.enabled ? `${YL}○${R}` : `${RD}○${R}`;
        const statusText = feat.active ? `${GR}active${R}` : feat.blocked ? `${D}${feat.blocked}${R}` : `${RD}off${R}`;
        const tools = feat.tools.length > 0 ? `${D} [${feat.tools.join(", ")}]${R}` : "";
        console.log(`${G}  │${R}   ${statusIcon} ${feat.name.padEnd(28)} ${statusText}${tools}`);
        console.log(`${G}  │${R}     ${D}${feat.desc}${R}`);
      }
      console.log(`${G}  │${R}`);
      console.log(`${G}  │${R}  ${D}Toggle: /labs <feature-id> [on|off]${R}`);
      console.log(`${G}  │${R}  ${D}IDs: ${snapshot.map((f) => f.id).join(", ")}${R}`);
      console.log(`${B}${C}  ╰${"─".repeat(55)}╯${R}`);
      console.log("");
      return;
    }

    // /labs on — enable master switch
    if (subCmd === "on") {
      labs.enableLabs();
      printSuccess("Labs mode: ON — experimental features available");
      return;
    }

    // /labs off — disable master switch
    if (subCmd === "off") {
      labs.disableLabs();
      printInfo("Labs mode: OFF — all experimental features disabled");
      return;
    }

    // /labs <feature-id> [on|off] — toggle specific feature
    const featureId = subCmd;
    const valueArg = args[1]?.toLowerCase();
    const explicitValue = valueArg === "on" ? true : valueArg === "off" ? false : undefined;

    const result = labs.toggle(featureId, explicitValue);
    if (result.ok) {
      if (!labs.enabled) {
        printWarning("Note: Labs master switch is OFF. Enable with /labs on");
      }
      printSuccess(result.message);
    } else {
      printError(result.message);
      const features = labs.getFeatures();
      printInfo(`Available IDs: ${features.map((f) => f.id).join(", ")}`);
    }
  }

  // ── /init command ────────────────────────────────────────────────────────

  async _handleInit() {
    const existing = await findProjectConfig(this.workspace);
    if (existing) {
      printInfo(`Project config already exists: ${existing}`);
      return;
    }
    try {
      const filePath = await scaffoldProjectConfig(this.workspace);
      printSuccess(`Created project config: ${filePath}`);
      printInfo("Edit this file to add project-specific instructions for Mercury Code.");
    } catch (err) {
      printError(`Error creating config: ${err.message}`);
    }
  }

  // ── /diff command ───────────────────────────────────────────────────────

  async _handleDiff(args) {
    const ref = args[0] || "HEAD";
    // Validate ref to prevent command injection — only allow safe git ref characters
    if (ref.startsWith('-') || !/^[a-zA-Z0-9_.\/~^@{}\-]+$/.test(ref)) {
      printError(`Invalid git ref: "${ref}". Refs cannot start with a hyphen and may only contain alphanumeric, dots, slashes, tildes, ^, @, {}, - characters.`);
      return;
    }
    const runGit = (gitArgs) => {
      try {
        return _execFileSync("git", gitArgs, {
          encoding: "utf-8",
          timeout: 15000,
          cwd: this.workspace,
          maxBuffer: 5 * 1024 * 1024,
        });
      } catch (err) {
        if (err?.status === 0) {
          return String(err.stdout || "");
        }
        throw err;
      }
    };
    try {
      // Use execFileSync with array args to prevent shell injection
      const diff = runGit(["diff", ref]);
      const cached = runGit(["diff", "--cached"]);
      const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
      const result = [diff, cached, untracked ? `---UNTRACKED---\n${untracked}` : ""].filter(Boolean).join("\n");
      if (!result.trim() || result.trim() === "---UNTRACKED---") {
        printInfo("No changes detected.");
      } else {
        console.log(result);
      }
    } catch (err) {
      printError(`Git diff error: ${err.stderr || err.message}`);
    }
  }

  // ── /compact command ────────────────────────────────────────────────────

  async _handleCompact() {
    printInfo("Compacting conversation...");
    const before = this.conversation.messages.length;
    try {
      await this.conversation.compress(this.client, this.memory, (msg) => printInfo(msg));
      const after = this.conversation.messages.length;
      printSuccess(`Compacted: ${before} messages → ${after} messages`);
    } catch (err) {
      printError(`Compact error: ${err.message}`);
    }
  }

  // ── /new command ────────────────────────────────────────────────────────

  async _handleNew() {
    // Save current session
    if (this.conversation && this.conversation.messages.length > 1) {
      try {
        await this.history.save(this._getSessionSnapshot());
        printInfo("Current session saved.");
      } catch (err) { debugLog("MercuryRepl._handleNew.saveSession", err); }
    }

    // Reset conversation
    this._sessionId = `s-${Date.now().toString(36)}`;
    this.conversation = new Conversation(buildSystemPrompt(this.workspace, this.trustMode, this.sandbox));
    this.rollback = new RollbackManager(this.workspace);
    this._toolTurnCount = 0;
    if (this._taintTracker) this._taintTracker.clear();
    printSuccess("Started new conversation. Previous session saved.");
  }

  // ── /copy command ───────────────────────────────────────────────────────

  _handleCopy() {
    // Find the last assistant message
    const msgs = this.conversation.messages;
    const last = [...msgs].reverse().find((m) => m.role === "assistant" && m.content);
    if (!last) {
      printError("No assistant message to copy.");
      return;
    }

    // Attempt copy to clipboard
    try {
      const clip = process.platform === "darwin"
        ? "pbcopy"
        : process.platform === "win32"
          ? "clip"
          : "xclip -selection clipboard";
      _execSync(clip, { input: last.content, timeout: 5000 });
      printSuccess(`Copied ${last.content.length} chars to clipboard.`);
    } catch (err) {
      debugLog("MercuryRepl._handleCopy.clipboard", err);
      printInfo("Clipboard not available. Last assistant response:");
      console.log(last.content);
    }
  }

  // ── Context info ─────────────────────────────────────────────────────────

  _printContextInfo() {
    const R = RESET, B = BOLD, D = DIM;
    const C = CYAN, G = GRAY, GR = GREEN, Y = YELLOW, RD = RED;

    const used = this.conversation.getTokenEstimate();
    const max = this._getMaxContextTokens();
    const pct = Math.round((used / max) * 100);
    const barWidth = 30;
    const filled = Math.round((pct / 100) * barWidth);
    const empty = barWidth - filled;
    const barColor = pct > 90 ? RD : pct > 75 ? Y : GR;
    const gaugeChars = ["○", "◔", "◑", "◕", "●"];
    const gaugeChar = pct <= 5 ? gaugeChars[0] : pct <= 30 ? gaugeChars[1] : pct <= 55 ? gaugeChars[2] : pct <= 80 ? gaugeChars[3] : gaugeChars[4];

    // Source indicator: heuristic or API-based
    const hasApiUsage = this.conversation._lastActualUsage?.prompt_tokens;
    const sourceLabel = hasApiUsage ? `${GR}API-reported${R}` : `${Y}estimated (bytes/4)${R}`;

    console.log("");
    console.log(`${B}${C}  ╭─ Context Usage ─────────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}`);

    // Circular gauge + progress bar
    const bar = `${barColor}${"━".repeat(filled)}${G}${"━".repeat(empty)}${R}`;
    console.log(`${G}  │${R}  ${barColor}${B}${gaugeChar}${R} ${bar} ${barColor}${B}${pct}%${R}`);
    console.log(`${G}  │${R}  ${D}${used.toLocaleString()} / ${max.toLocaleString()} tokens${R}  ${D}(${sourceLabel})${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${GR}Messages${R}     ${D}${this.conversation.messages.length}${R}`);
    console.log(`${G}  │${R}  ${GR}Checkpoints${R}  ${D}${this.rollback.count}${R}`);
    console.log(`${G}  │${R}  ${GR}Session${R}      ${D}${this._sessionId}${R}`);
    console.log(`${G}  │${R}  ${GR}Compression${R}  ${D}${this.superCompress ? "Super (50%)" : "Normal (80%)"}${R}`);
    console.log(`${G}  │${R}  ${GR}Estimation${R}   ${D}Codex-style (bytes÷4 + API usage)${R}`);
    const sbStatus = this.sandbox.getStatus();
    console.log(`${G}  │${R}  ${GR}Sandbox${R}      ${D}${sbStatus.label}${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);
    console.log("");
  }

  // ── /cost command ────────────────────────────────────────────────────────

  _handleCost() {
    const R = RESET, B = BOLD, D = DIM;
    const C = CYAN, G = GRAY, GR = GREEN;

    const used = this.conversation.getTokenEstimate();
    const hasApi = this.conversation._lastActualUsage;
    const promptTokens = hasApi?.prompt_tokens || used;
    const completionTokens = hasApi?.completion_tokens || 0;
    const totalTokens = hasApi?.total_tokens || used;

    // Mercury-2 pricing estimate (placeholder — update with actual pricing)
    const inputCostPer1K = 0.003;  // $/1K input tokens
    const outputCostPer1K = 0.015; // $/1K output tokens
    const inputCost = (promptTokens / 1000) * inputCostPer1K;
    const outputCost = (completionTokens / 1000) * outputCostPer1K;
    const totalCost = inputCost + outputCost;

    console.log("");
    console.log(`${B}${C}  ╭─ Cost Estimate ──────────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}  ${GR}Input tokens${R}      ${D}${promptTokens.toLocaleString()}${R}`);
    console.log(`${G}  │${R}  ${GR}Output tokens${R}     ${D}${completionTokens.toLocaleString()}${R}`);
    console.log(`${G}  │${R}  ${GR}Total tokens${R}      ${D}${totalTokens.toLocaleString()}${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${GR}Input cost${R}        ${D}$${inputCost.toFixed(4)}${R}`);
    console.log(`${G}  │${R}  ${GR}Output cost${R}       ${D}$${outputCost.toFixed(4)}${R}`);
    console.log(`${G}  │${R}  ${GR}Session total${R}     ${B}$${totalCost.toFixed(4)}${R}`);
    console.log(`${G}  │${R}`);
    console.log(`${G}  │${R}  ${D}Note: Estimates based on Mercury-2 pricing. Actual${R}`);
    console.log(`${G}  │${R}  ${D}costs may vary. Check api.inceptionlabs.ai for details.${R}`);
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);
    console.log("");
  }

  // ── /doctor command ────────────────────────────────────────────────────

  async _handleDoctor() {
    const R = RESET, B = BOLD, D = DIM;
    const C = CYAN, G = GRAY, GR = GREEN, RD = RED, Y = YELLOW;

    console.log("");
    console.log(`${B}${C}  ╭─ Doctor ─────────────────────────────────────────────╮${R}`);

    const checks = [];

    // Node.js version
    const nodeVer = process.version;
    const nodeMajor = parseInt(nodeVer.replace("v", "").split(".")[0]);
    checks.push({
      name: "Node.js",
      ok: nodeMajor >= 18,
      detail: `${nodeVer} ${nodeMajor >= 18 ? "(OK)" : "(need >= 18.17.0)"}`,
    });

    // API key
    const hasKey = !!(this.client.apiKey && this.client.apiKey.length > 0);
    checks.push({
      name: "API Key",
      ok: hasKey,
      detail: hasKey
        ? `Set (${this.client.apiKey.slice(0, 8)}...)`
        : `NOT SET — use /login or ${this.client.provider?.envKey || "INCEPTION_API_KEY"}`,
    });

    // Git
    let gitOk = false;
    try { _execSync("git --version", { timeout: 5000, encoding: "utf-8" }); gitOk = true; } catch (err) { debugLog("MercuryRepl._handleDoctor.gitCheck", err); }
    checks.push({ name: "Git", ok: gitOk, detail: gitOk ? "Available" : "Not found" });

    // Workspace
    const wsExists = fs.existsSync(this.workspace);
    checks.push({ name: "Workspace", ok: wsExists, detail: wsExists ? this.workspace : "Not found" });

    // Config files
    const configExists = await findProjectConfig(this.workspace);
    checks.push({
      name: "Project config",
      ok: !!configExists,
      detail: configExists || "No MERCURY.md found (use /init to create)",
    });

    // Memory file
    const memPath = path.join(this.workspace, ".mercury", "memory.md");
    const memExists = fs.existsSync(memPath);
    checks.push({ name: "Memory file", ok: memExists, detail: memExists ? memPath : "Not created yet" });

    // Sandbox
    const sbStatus = this.sandbox.getStatus();
    checks.push({ name: "Sandbox", ok: true, detail: sbStatus.label });

    for (const c of checks) {
      const icon = c.ok ? `${GR}✓${R}` : `${RD}✗${R}`;
      console.log(`${G}  │${R}  ${icon} ${c.name.padEnd(16)} ${D}${c.detail}${R}`);
    }

    const allOk = checks.every((c) => c.ok);
    console.log(`${G}  │${R}`);
    if (allOk) {
      console.log(`${G}  │${R}  ${GR}${B}All checks passed!${R}`);
    } else {
      console.log(`${G}  │${R}  ${Y}Some issues detected. Fix the items marked ✗.${R}`);
    }
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);
    console.log("");
  }

  // ── /status command ────────────────────────────────────────────────────

  _handleStatus() {
    const R = RESET, B = BOLD, D = DIM;
    const C = CYAN, G = GRAY, GR = GREEN;

    const used = this.conversation.getTokenEstimate();
    const max = this._getMaxContextTokens();
    const pct = Math.round((used / max) * 100);
    const sandboxStatus = this.sandbox.getStatus();
    const mcpServers = this.mcpManager.getStatus().filter((s) => s.ready).length;

    console.log("");
    console.log(`${B}${C}  ╭─ Status ─────────────────────────────────────────────╮${R}`);
    console.log(`${G}  │${R}  ${GR}Session${R}        ${D}${this._sessionId}${R}`);
    console.log(`${G}  │${R}  ${GR}Provider${R}       ${D}${this.client.provider?.displayName || "Mercury-2"}${R}`);
    console.log(`${G}  │${R}  ${GR}Model${R}          ${D}${this.client.config.model}${R}`);
    console.log(`${G}  │${R}  ${GR}Reasoning${R}      ${D}${this.client.config.reasoning_effort}${R}`);
    console.log(`${G}  │${R}  ${GR}Trust${R}          ${D}${this._trustLabel(this.trustMode)}${R}`);
    console.log(`${G}  │${R}  ${GR}Workspace${R}      ${D}${this.workspace}${R}`);
    console.log(`${G}  │${R}  ${GR}Sandbox${R}        ${D}${sandboxStatus.mode} (${sandboxStatus.backend}) • network ${this.sandbox.allowNetwork ? "on" : "off"}${R}`);
    console.log(`${G}  │${R}  ${GR}Context${R}        ${D}${pct}% (${used.toLocaleString()} / ${max.toLocaleString()} tokens)${R}`);
    console.log(`${G}  │${R}  ${GR}Messages${R}       ${D}${this.conversation.messages.length}${R}`);
    console.log(`${G}  │${R}  ${GR}API Key${R}        ${D}${this.client.apiKey ? "Set" : "NOT SET"}${R}`);
    console.log(`${G}  │${R}  ${GR}Skills${R}         ${D}${this.skillManager.count}${R}`);
    console.log(`${G}  │${R}  ${GR}MCP Servers${R}    ${D}${mcpServers}${R}`);
    console.log(`${G}  │${R}  ${GR}Labs${R}           ${D}${labs.enabled ? "ON" : "OFF"}${R}`);
    console.log(`${B}${C}  ╰──────────────────────────────────────────────────────╯${R}`);
    console.log("");
  }

  // ── /memory command ────────────────────────────────────────────────────

  async _handleMemory(subCmd, value) {
    const memPath = path.join(this.workspace, ".mercury", "memory.md");

    if (!subCmd || subCmd === "show") {
      try {
        const content = fs.readFileSync(memPath, "utf-8");
        printInfo(`Memory file: ${memPath}`);
        console.log(content.slice(0, 5000));
        if (content.length > 5000) printInfo(`... (${content.length} chars total)`);
      } catch (err) {
        debugLog("MercuryRepl._handleMemory.read", err);
        printInfo("No memory file yet. Mercury Code will create one during context compression.");
      }
      return;
    }

    if (subCmd === "add") {
      if (!value) { printError("Usage: /memory add <text>"); return; }
      try {
        await this.memory.append(value);
        await this._refreshConversationMemory();
        printSuccess("Added to memory.");
      } catch (err) {
        printError(`Error: ${err.message}`);
      }
      return;
    }

    if (subCmd === "clear") {
      try {
        await this.memory.write("");
        await this._refreshConversationMemory();
        printSuccess("Memory cleared.");
      } catch (err) {
        printError(`Error: ${err.message}`);
      }
      return;
    }

    if (subCmd === "edit") {
      try {
        const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
        _execFileSync(editor, [memPath], { stdio: "inherit", timeout: 300000 });
        await this._refreshConversationMemory();
        printSuccess("Memory file updated.");
      } catch (err) {
        printError(`Editor error: ${err.message}`);
      }
      return;
    }

    printError("Usage: /memory [show|add <text>|clear|edit]");
  }

  // ── /undo command ─────────────────────────────────────────────────────

  async _handleUndo() {
    if (!this.rollback || this.rollback.count === 0) {
      printInfo("No checkpoints available for undo. (Tip: Triple-press ESC for rollback mode)");
      return;
    }
    // Undo the last checkpoint (context rollback — revert messages only, not files)
    const last = this.rollback.count - 1;
    const result = this.rollback.contextRollback(last, this.conversation.messages);
    if (result?.restored) {
      this.conversation.messages = result.messages;
      printSuccess(`Undo: Reverted to checkpoint ${last + 1} (${result.label || "previous state"}).`);
    } else {
      printError("Undo failed. Try triple-press ESC for full rollback mode.");
    }
  }

  // ── Graceful exit ─────────────────────────────────────────────────────────

  async _gracefulExit() {
    if (this._exiting) return;
    this._exiting = true;
    this._disposeInteractiveHandlers();
    if (this._rl) {
      const rl = this._rl;
      this._rl = null;
      rl.removeAllListeners("close");
      try { rl.close(); } catch (err) { debugLog("MercuryRepl._gracefulExit.rlClose", err); }
    }
    if (this.conversation && this.conversation.messages.length > 1) {
      try {
        await this.history.save(this._getSessionSnapshot());
        printInfo("Session auto-saved.");
      } catch (err) { debugLog("MercuryRepl._gracefulExit.saveSession", err); }
    }
    try { await this.hooks?.fireSessionEnd(); } catch (err) { debugLog("MercuryRepl._gracefulExit.sessionEnd", err); }
    // Shutdown MCP servers
    try { await this.mcpManager.shutdown(); } catch (err) { debugLog("MercuryRepl._gracefulExit.mcpShutdown", err); }
    printInfo("Goodbye!");
    process.exit(0);
  }

  // ── Stream assembly ──────────────────────────────────────────────────────

  _assembleStreamResponse(chunks) {
    let content = "";
    let reasoning = "";
    const toolCallMap = {};
    let usage = null;
    let finish_reason = null;

    for (const chunk of chunks) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish_reason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.reasoning) reasoning += delta.reasoning;

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap[idx]) {
            toolCallMap[idx] = {
              id: tc.id || "",
              type: tc.type || "function",
              function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" },
            };
          } else {
            if (tc.id) toolCallMap[idx].id = tc.id;
            if (tc.function?.name) toolCallMap[idx].function.name = tc.function.name;
            if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    const indices = Object.keys(toolCallMap).map(Number).sort((a, b) => a - b);
    const tool_calls = indices.length > 0 ? indices.map((i) => toolCallMap[i]) : null;
    return { content: content || null, reasoning: reasoning || null, tool_calls, usage, finish_reason };
  }
}
