/**
 * Command Router -- extracts slash-command dispatching from MercuryRepl.
 *
 * Reduces the God-Object surface of repl.js by moving the 30+ case
 * switch statement into a registry/dispatch pattern.  Each command is
 * registered with a name, description, and handler function.  Handlers
 * receive `(parts, repl)` where `parts` is the tokenised input array
 * and `repl` is the MercuryRepl instance that owns all state.
 *
 * The individual handler *implementations* remain as methods on
 * MercuryRepl (they reference dozens of `this.*` properties), so the
 * router simply delegates to them.  The win is that _handleCommand()
 * in repl.js shrinks from ~310 lines to a ~10-line delegation call.
 */

import path from "node:path";
import {
  printHelp,
  printInfo,
  printSuccess,
  printError,
  printWarning,
  printPlanModeBanner,
  printMcpStatus,
} from "./ui/display.js";
import { REASONING_LEVELS, normalizeClientConfig } from "./config.js";
import { listProviders, listProvidersDetailed, getProvider, getProviderForModel } from "./providers.js";
import { debugLog } from "./utils/debug-log.js";

// ── Command descriptor shape ─────────────────────────────────────────────
// { handler: async (parts, repl) => void, description: string }

export class CommandRouter {
  /**
   * @param {import('./repl.js').MercuryRepl} repl - the owning REPL instance
   */
  constructor(repl) {
    /** @type {import('./repl.js').MercuryRepl} */
    this._repl = repl;
    /** @type {Map<string, {handler: Function, description: string}>} */
    this._commands = new Map();
    this._registerBuiltins();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Check whether `name` (without leading slash) is a registered command. */
  hasCommand(name) {
    return this._commands.has(name);
  }

  /** Return the full command map (for /help or introspection). */
  getCommands() {
    return this._commands;
  }

  /**
   * Execute a command by name.
   * @param {string} name  - command name without leading slash
   * @param {string[]} parts - full tokenised input (including the "/cmd" at index 0)
   * @returns {Promise<boolean>} true if the command was found and executed
   */
  async execute(name, parts) {
    const cmd = this._commands.get(name);
    if (!cmd) return false;
    await cmd.handler(parts, this._repl);
    return true;
  }

  // ── Registration ────────────────────────────────────────────────────────

  _register(name, description, handler) {
    this._commands.set(name, { handler, description });
  }

  _registerBuiltins() {
    const R = this; // alias for brevity inside lambdas

    // ── /help ──
    R._register("help", "Show available commands", async (_parts, _repl) => {
      printHelp();
    });

    // ── /clear ──
    R._register("clear", "Clear conversation", async (_parts, repl) => {
      repl.conversation.clear();
      await repl.log.clear();
      repl.rollback.checkpoints = [];
      printInfo("Conversation cleared.");
    });

    // ── /config ──
    R._register("config", "Show current config", async (_parts, repl) => {
      printInfo("Current config:");
      console.log(JSON.stringify(repl.client.config, null, 2));
    });

    // ── /reasoning ──
    R._register("reasoning", "Set reasoning effort level", async (parts, repl) => {
      const level = parts[1]?.toLowerCase();
      if (!level) {
        printInfo(`Reasoning: ${repl.client.config.reasoning_effort}`);
        return;
      }
      if (!REASONING_LEVELS.includes(level)) {
        printError(`Invalid. Options: ${REASONING_LEVELS.join(", ")}`);
        return;
      }
      repl.client.config.reasoning_effort = level;
      printSuccess(`Reasoning: ${level}`);
    });

    // ── /supercompress ──
    R._register("supercompress", "Toggle super compression", async (_parts, repl) => {
      repl.superCompress = !repl.superCompress;
      printInfo(`Super compress: ${repl.superCompress ? "ON" : "OFF"}`);
    });

    // ── /contextsearch ──
    R._register("contextsearch", "Toggle context search", async (_parts, repl) => {
      repl.contextSearchEnabled = !repl.contextSearchEnabled;
      printInfo(`Context search: ${repl.contextSearchEnabled ? "ON" : "OFF"}`);
    });

    // ── /trust ──
    R._register("trust", "Set trust mode", async (parts, repl) => {
      const mode = parts[1]?.toLowerCase();
      if (!mode) {
        printInfo(`Trust: ${repl._trustLabel(repl.trustMode)}`);
        printInfo(`Plan mode: ${repl.planMode ? "ON" : "OFF"}`);
        printInfo(`Outside workspace: ${repl.allowOutsideWorkspace ? "allowed" : "blocked"}`);
        printInfo("Usage: /trust readonly|approval|acceptedits|open|dontask|aisafetydecide|plan|outside");
        return;
      }
      // Import trust-mode constants lazily (they live in repl.js scope)
      if (mode === "readonly" || mode === "1") { repl.trustMode = "readonly"; repl.planMode = false; }
      else if (mode === "approval" || mode === "2") { repl.trustMode = "approval"; repl.planMode = false; }
      else if (mode === "acceptedits" || mode === "3") { repl.trustMode = "acceptEdits"; repl.planMode = false; }
      else if (mode === "open" || mode === "4") { repl.trustMode = "open"; repl.planMode = false; }
      else if (mode === "dontask" || mode === "5") { repl.trustMode = "dontAsk"; repl.planMode = false; }
      else if (mode === "aisafetydecide" || mode === "6") { repl.trustMode = "aiSafetyDecide"; repl.planMode = false; }
      else if (mode === "plan") { repl.trustMode = "readonly"; repl.planMode = true; printPlanModeBanner(); }
      else if (mode === "outside") {
        repl.allowOutsideWorkspace = !repl.allowOutsideWorkspace;
        printInfo(`Outside workspace: ${repl.allowOutsideWorkspace ? "allowed" : "blocked"}`);
        if (repl.allowOutsideWorkspace && repl.sandbox.enabled) {
          printWarning("Sandbox is still active, so outside-workspace file access may remain blocked until sandbox is turned off.");
        }
        return; // skip the trust-label printout
      } else {
        printError(`Unknown mode: ${mode}`);
        return;
      }
      await repl._reloadPermissions();
      repl._refreshConversationSystemPrompt();
      printSuccess(`Trust: ${repl._trustLabel(repl.trustMode)}`);
    });

    // ── /workspace ──
    R._register("workspace", "Show or change workspace", async (parts, repl) => {
      const newWs = parts.slice(1).join(" ").trim();
      if (!newWs) {
        printInfo(`Workspace: ${repl.workspace}`);
        return;
      }
      repl.workspace = path.resolve(newWs);
      const { mcpResult } = await repl._reloadWorkspaceState({
        resetConversation: true,
        reloadMcp: true,
        reloadSkills: true,
        announceProjectConfig: true,
      });
      if (mcpResult.count > 0) {
        printMcpStatus(repl.mcpManager.getStatus());
      }
      if (repl.skillManager.count > 0) {
        printInfo(`${repl.skillManager.count} skill(s) loaded. Use /skills to list.`);
      }
      printInfo("Conversation context reset for the new workspace.");
      printSuccess(`Workspace: ${repl.workspace}`);
    });

    // ── /sandbox ──
    R._register("sandbox", "Sandbox settings", async (parts, repl) => {
      await repl._handleSandbox(parts.slice(1));
    });

    // ── /sentinel ──
    R._register("sentinel", "Context injection sentinel", async (parts, repl) => {
      await repl._handleSentinel(parts.slice(1));
    });

    // ── /history ──
    R._register("history", "Session history", async (parts, repl) => {
      await repl._handleHistory(parts.slice(1));
    });

    // ── /context ──
    R._register("context", "Show context info", async (_parts, repl) => {
      repl._printContextInfo();
    });

    // ── /settings ──
    R._register("settings", "Edit settings", async (parts, repl) => {
      await repl._handleSettings(parts.slice(1));
    });

    // ── /agents ──
    R._register("agents", "Manage agent definitions", async (parts, repl) => {
      await repl._handleAgents(parts.slice(1));
    });

    // ── /labs ──
    R._register("labs", "Labs experimental features", async (parts, repl) => {
      await repl._handleLabs(parts.slice(1));
    });

    // ── /init ──
    R._register("init", "Initialize project config", async (_parts, repl) => {
      await repl._handleInit();
    });

    // ── /diff ──
    R._register("diff", "Show git diff", async (parts, repl) => {
      await repl._handleDiff(parts.slice(1));
    });

    // ── /compact ──
    R._register("compact", "Compress conversation context", async (_parts, repl) => {
      await repl._handleCompact();
    });

    // ── /new ──
    R._register("new", "Start new conversation", async (_parts, repl) => {
      await repl._handleNew();
    });

    // ── /copy ──
    R._register("copy", "Copy last response to clipboard", async (_parts, repl) => {
      repl._handleCopy();
    });

    // ── /edit ──
    R._register("edit", "Open editor for multiline input", async (_parts, repl) => {
      if (repl.webBridgeMode) {
        printInfo("Use the browser composer for multiline input in web mode.");
        return;
      }
      printInfo(`Opening ${process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi")} for multiline input...`);
      const editorText = repl._openEditor();
      if (!editorText) {
        printInfo("Editor cancelled (empty input).");
        return;
      }
      printInfo(`Received ${editorText.length} chars from editor.`);
      try {
        await repl._submitUserText(editorText, {
          resolveFileMentions: true,
          logContent: editorText,
        });
      } catch (err) {
        printError(`Error: ${err.message}`);
      }
    });

    // ── /cost ──
    R._register("cost", "Show cost estimate", async (_parts, repl) => {
      repl._handleCost();
    });

    // ── /doctor ──
    R._register("doctor", "Run diagnostics", async (_parts, repl) => {
      await repl._handleDoctor();
    });

    // ── /bug ──
    R._register("bug", "Report a bug", async (_parts, _repl) => {
      printInfo("Report bugs at: https://github.com/LHAMNS/Cloud-code-for-mercury-2/issues");
      printInfo("Include your Mercury Code version, Node.js version, and OS.");
    });

    // ── /status ──
    R._register("status", "Show system status", async (_parts, repl) => {
      repl._handleStatus();
    });

    // ── /memory ──
    R._register("memory", "Memory management", async (parts, repl) => {
      const memArg = parts[1]?.toLowerCase();
      await repl._handleMemory(memArg, parts.slice(2).join(" "));
    });

    // ── /model ──
    R._register("model", "Show or change model", async (parts, repl) => {
      const modelArg = parts.slice(1).join(" ").trim();
      if (!modelArg) {
        printInfo(`Provider: ${repl.client.providerName} (${repl.client.provider.displayName})`);
        printInfo(`Model: ${repl.client.config.model}`);
        return;
      }
      // Auto-detect provider from model name
      const detectedProvider = getProviderForModel(modelArg);
      if (detectedProvider && detectedProvider.name !== repl.client.providerName) {
        repl.client.switchProvider(detectedProvider.name, { model: modelArg });
        if (repl._onProviderChanged) repl._onProviderChanged();
        printSuccess(`Auto-switched to ${detectedProvider.displayName}, model: ${modelArg}`);
      } else {
        repl.client.config.model = modelArg;
        repl.client.config = normalizeClientConfig(repl.client.config, repl.client.providerName);
        if (repl._onProviderChanged) repl._onProviderChanged();
        printSuccess(`Model: ${modelArg}`);
      }
    });

    // ── /undo ──
    R._register("undo", "Undo last checkpoint", async (_parts, repl) => {
      await repl._handleUndo();
    });

    // ── /login ──
    R._register("login", "Set API key", async (parts, repl) => {
      const key = parts.slice(1).join(" ").trim();
      if (!key) {
        const envKeyName = repl.client.provider?.envKey || "INCEPTION_API_KEY";
        printInfo("Usage: /login <api-key>");
        printInfo(`Or set ${envKeyName} environment variable.`);
      } else {
        repl._setClientConnection({ apiKey: key });
        printSuccess("API key set. Use /settings to verify.");
      }
    });

    // ── /logout ──
    R._register("logout", "Clear API key", async (_parts, repl) => {
      repl._setClientConnection({ apiKey: null });
      const envKeyName = repl.client.provider?.envKey || "INCEPTION_API_KEY";
      printInfo(`API key cleared. Set again with /login or ${envKeyName} env var.`);
    });

    // ── /verbose ──
    R._register("verbose", "Toggle verbose logging", async (_parts, repl) => {
      repl.verbose = !repl.verbose;
      printInfo(`Verbose logging: ${repl.verbose ? "ON" : "OFF"}`);
    });

    // ── /mcp ──
    R._register("mcp", "MCP server management", async (parts, repl) => {
      await repl._handleMcp(parts.slice(1));
    });

    // ── /skills ──
    R._register("skills", "List loaded skills", async (_parts, repl) => {
      repl._handleSkills();
    });

    // ── /export ──
    R._register("export", "Export conversation", async (parts, repl) => {
      await repl._handleExport(parts.slice(1));
    });

    // ── /provider ──
    R._register("provider", "Switch AI provider", async (parts, repl) => {
      const arg = parts[1]?.toLowerCase();
      if (!arg || arg === "list") {
        // Show current provider info and list all available
        printInfo(`Provider: ${repl.client.providerName} (${repl.client.provider.displayName})`);
        printInfo(`Model: ${repl.client.config.model}`);
        printInfo("");
        const providers = listProvidersDetailed();
        for (const p of providers) {
          const active = p.name === repl.client.providerName ? " ← active" : "";
          printInfo(`  ${p.name} — ${p.displayName}${active}`);
          for (const m of p.models) {
            const activeModel = (p.name === repl.client.providerName && m.id === repl.client.config.model) ? " ★" : "";
            printInfo(`    ${m.id} — ${m.description}${activeModel}`);
          }
        }
        printInfo("");
        printInfo("Usage: /provider <name> [model]");
        return;
      }
      const modelArg = parts[2] || undefined;
      try {
        repl.client.switchProvider(arg, { model: modelArg });
        if (repl._onProviderChanged) repl._onProviderChanged();
        printSuccess(`Switched to ${repl.client.provider.displayName} (model: ${repl.client.config.model})`);
      } catch (e) {
        printError(e.message);
      }
    });

    // ── /exit ──
    R._register("exit", "Exit Mercury Code", async (_parts, repl) => {
      await repl._gracefulExit();
    });
  }
}
