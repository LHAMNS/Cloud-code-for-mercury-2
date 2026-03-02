// Mercury Code - REPL (Read-Eval-Print Loop)
// Handles user input, sends messages to Mercury-2, processes tool calls,
// and displays results. Includes Codex-style framing, permission system,
// auto-recovery, session history, rollback, and ESC undo.

import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { MercuryClient } from "./client.js";
import { Conversation } from "./conversation.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { REASONING_LEVELS } from "./config.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { ToolExecutor } from "./tools/executor.js";
import { MemoryManager, ConversationLog } from "./memory.js";
import { SessionHistory } from "./history.js";
import { RollbackManager } from "./rollback.js";
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
  printResponseHeader,
  printResponseFooter,
  printRollbackUI,
  printRollbackConfirm,
  printSessionList,
  spinner,
} from "./ui/display.js";

// Maximum agentic tool-call turns before forcing a stop
const MAX_TOOL_TURNS = 100;
// Maximum auto-recovery attempts for truncated output
const MAX_AUTO_RECOVER = 3;
// ESC detection: triple-press within this window triggers rollback
const ESC_WINDOW_MS = 800;

// Trust modes
const TRUST_READONLY = "readonly";
const TRUST_APPROVAL = "approval";
const TRUST_OPEN = "open";

// Read-only tools (allowed in all modes). Fetch is handled separately due to POST restrictions.
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "ListDir", "Diff"]);
// Write tools (need checking in approval mode)
const WRITE_TOOLS = new Set(["Write", "Edit", "Patch"]);

export class MercuryRepl {
  constructor(options = {}) {
    this.client = new MercuryClient(options);
    this.verbose = options.verbose || false;
    this.superCompress = false;
    this.contextSearchEnabled = false;
    this._rl = null;
    this._toolTurnCount = 0;
    this._processing = false;
    this._sessionId = this._generateSessionId();

    // Workspace and trust
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || TRUST_APPROVAL;
    this.allowOutsideWorkspace = false;

    // ToolExecutor receives workspace + trustMode for enforcement
    this.toolExecutor = new ToolExecutor({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      workspace: this.workspace,
      trustMode: this.trustMode,
    });

    // These will be initialized after workspace is chosen
    this.memory = null;
    this.log = null;
    this.conversation = null;
    this.history = new SessionHistory();
    this.rollback = null;

    // ESC tracking
    this._escPresses = [];
    this._inRollbackMode = false;
  }

  _generateSessionId() {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6)
    );
  }

  // ── Interactive mode ─────────────────────────────────────────────────────

  async start() {
    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[38;5;87m\x1b[1m> \x1b[0m",
    });

    // Interactive setup flow: workspace + trust mode
    await this._startupFlow();

    // Init workspace-dependent components
    this.memory = new MemoryManager(this.workspace);
    this.log = new ConversationLog(this.workspace);
    this.rollback = new RollbackManager(this.workspace);
    this.conversation = new Conversation(buildSystemPrompt(this.workspace, this.trustMode));
    await this.conversation.loadMemory(this.memory);

    printWelcome();
    printInfo(`Workspace: ${this.workspace}`);
    printInfo(`Trust: ${this._trustLabel(this.trustMode)}`);
    console.log("");

    // Enable keypress events for ESC detection
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, this._rl);
      this._setupKeyListener();
    }

    this._rl.on("line", async (line) => {
      if (this._processing || this._inRollbackMode) return;
      this._processing = true;
      try {
        await this._handleInput(line);
      } finally {
        this._processing = false;
      }
    });

    this._rl.on("close", async () => {
      await this._gracefulExit();
    });

    this._rl.prompt();
  }

  // ── Startup flow (workspace + trust selection) ────────────────────────────

  async _startupFlow() {
    console.log("");
    console.log("\x1b[1m\x1b[38;5;87m  Mercury Code\x1b[0m");
    console.log("\x1b[90m  ─────────────────────────────────────────────\x1b[0m");
    console.log("");

    // Workspace selection
    const cwd = process.cwd();
    const ws = await this._ask(
      `\x1b[38;5;75m  Workspace\x1b[0m \x1b[2m[${cwd}]\x1b[0m\x1b[38;5;75m:\x1b[0m `
    );
    this.workspace = ws.trim() ? path.resolve(ws.trim()) : cwd;

    console.log("");
    console.log("\x1b[38;5;75m  Trust mode:\x1b[0m");
    console.log("    \x1b[33m1\x1b[0m \x1b[2mRead-only    \u2014 model can only read, no writes or commands\x1b[0m");
    console.log("    \x1b[33m2\x1b[0m \x1b[2mApproval     \u2014 asks before dangerous ops (recommended)\x1b[0m");
    console.log("    \x1b[33m3\x1b[0m \x1b[2mFull open    \u2014 all ops within workspace allowed\x1b[0m");
    console.log("");

    const modeStr = await this._ask("\x1b[38;5;75m  Select\x1b[0m \x1b[2m[2]\x1b[0m\x1b[38;5;75m:\x1b[0m ");
    const modeNum = parseInt(modeStr.trim(), 10);
    if (modeNum === 1) this.trustMode = TRUST_READONLY;
    else if (modeNum === 3) this.trustMode = TRUST_OPEN;
    else this.trustMode = TRUST_APPROVAL;

    console.log("");
  }

  _ask(prompt) {
    return new Promise((resolve) => {
      this._rl.question(prompt, (answer) => resolve(answer));
    });
  }

  _trustLabel(mode) {
    switch (mode) {
      case TRUST_READONLY: return "Read-only (only read operations allowed)";
      case TRUST_APPROVAL: return "Approval (asks before writes/commands)";
      case TRUST_OPEN: return "Full open (all ops within workspace)";
      default: return mode;
    }
  }

  // ── ESC detection ─────────────────────────────────────────────────────────

  _setupKeyListener() {
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      if (key.name === "escape" && !this._processing) {
        const now = Date.now();
        this._escPresses = this._escPresses.filter((t) => now - t < ESC_WINDOW_MS);
        this._escPresses.push(now);
        if (this._escPresses.length >= 3) {
          this._escPresses = [];
          this._enterRollbackMode().catch(() => {});
        }
      }
    });
  }

  // ── Single-shot mode ─────────────────────────────────────────────────────

  async runOnce(promptText) {
    this.memory = new MemoryManager(this.workspace);
    this.log = new ConversationLog(this.workspace);
    this.rollback = new RollbackManager(this.workspace);
    this.conversation = new Conversation(buildSystemPrompt(this.workspace, this.trustMode));
    await this.conversation.loadMemory(this.memory);
    this.conversation.addUserMessage(promptText);
    await this.log.append({ role: "user", content: promptText });
    this._toolTurnCount = 0;
    try {
      await this._sendAndProcess();
    } catch (err) {
      printError(`Error: ${err.message}`);
      if (this.verbose) console.error(err.stack);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Input handling ───────────────────────────────────────────────────────

  async _handleInput(input) {
    const trimmed = input.trim();
    if (!trimmed) {
      this._rl.prompt();
      return;
    }

    if (trimmed.startsWith("/")) {
      await this._handleCommand(trimmed);
      this._rl.prompt();
      return;
    }

    this.rollback.createCheckpoint(trimmed, this.conversation.messages);

    this.conversation.addUserMessage(trimmed);
    await this.log.append({ role: "user", content: trimmed });
    this._toolTurnCount = 0;

    try {
      await this._sendAndProcess();
    } catch (err) {
      printError(`Unexpected error: ${err.message}`);
      if (this.verbose) console.error(err.stack);
    }

    this._rl.prompt();
  }

  // ── Permission check ─────────────────────────────────────────────────────

  _checkPermission(toolName, args) {
    // Fetch: special handling — allow GET in all modes, restrict POST/body in readonly
    if (toolName === "Fetch") {
      if (this.trustMode === TRUST_READONLY) {
        const method = (args.method || "GET").toUpperCase();
        if (method !== "GET") {
          return { allowed: false, needsApproval: false, reason: `Read-only mode: only GET requests allowed (attempted ${method})` };
        }
        if (args.body) {
          return { allowed: false, needsApproval: false, reason: "Read-only mode: request body not allowed" };
        }
      }
      return { allowed: true, needsApproval: false };
    }

    // Other read tools always allowed
    if (READ_TOOLS.has(toolName) || toolName === "ContextSearch") {
      return { allowed: true, needsApproval: false };
    }

    // SubAgent/SubAgentTeam: allowed except readonly
    if (toolName === "SubAgent" || toolName === "SubAgentTeam") {
      if (this.trustMode === TRUST_READONLY) {
        return { allowed: false, needsApproval: false, reason: "Read-only mode: sub-agents disabled" };
      }
      return { allowed: true, needsApproval: false };
    }

    // Readonly: block all writes and commands
    if (this.trustMode === TRUST_READONLY) {
      return { allowed: false, needsApproval: false, reason: `Read-only mode: ${toolName} blocked` };
    }

    // Check workspace boundary for file operations (symlink-safe)
    const filePath = args.file_path || args.path;
    if (filePath && WRITE_TOOLS.has(toolName)) {
      const inWorkspace = this._isInWorkspace(filePath);
      if (!inWorkspace && !this.allowOutsideWorkspace) {
        if (this.trustMode === TRUST_OPEN) {
          return { allowed: false, needsApproval: false, reason: `Outside workspace: ${path.resolve(filePath)}` };
        }
        return { allowed: true, needsApproval: true, reason: `File outside workspace: ${path.resolve(filePath)}` };
      }
    }

    // Approval mode: Bash always needs approval
    if (this.trustMode === TRUST_APPROVAL && toolName === "Bash") {
      return { allowed: true, needsApproval: true, reason: null };
    }

    // Approval mode: writes within workspace are allowed
    if (this.trustMode === TRUST_APPROVAL && WRITE_TOOLS.has(toolName)) {
      return { allowed: true, needsApproval: false };
    }

    return { allowed: true, needsApproval: false };
  }

  /**
   * Symlink-safe workspace boundary check.
   * Uses fs.realpathSync to resolve symlinks before comparison.
   */
  _isInWorkspace(filePath) {
    try {
      const resolvedWorkspace = fs.realpathSync(this.workspace);
      let resolvedPath;
      try {
        resolvedPath = fs.realpathSync(filePath);
      } catch {
        resolvedPath = path.resolve(filePath);
      }
      return resolvedPath === resolvedWorkspace ||
        resolvedPath.startsWith(resolvedWorkspace + path.sep);
    } catch {
      const resolvedPath = path.resolve(filePath);
      const resolvedWorkspace = path.resolve(this.workspace);
      return resolvedPath === resolvedWorkspace ||
        resolvedPath.startsWith(resolvedWorkspace + path.sep);
    }
  }

  async _requestApproval(toolName, args, reason) {
    const detail = reason || `${toolName} requires approval`;
    console.log(`\x1b[33m  ? ${detail}\x1b[0m`);

    if (toolName === "Bash" && args.command) {
      console.log(`\x1b[90m    $ ${args.command.length > 100 ? args.command.slice(0, 100) + "..." : args.command}\x1b[0m`);
    }

    const answer = await this._ask("\x1b[33m  Allow? (y/n) \x1b[0m");
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

        const activeTools = this.contextSearchEnabled
          ? TOOL_DEFINITIONS
          : TOOL_DEFINITIONS.filter((t) => t.function.name !== "ContextSearch");

        // In readonly mode, only allow read tools
        const permittedTools = this.trustMode === TRUST_READONLY
          ? activeTools.filter((t) => READ_TOOLS.has(t.function.name) || t.function.name === "ContextSearch")
          : activeTools;

        let inReasoning = false;

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
            printStreamChunk(delta.content);
          }
        }

        if (firstChunk) spinner.stop();
        if (inReasoning) printStreamChunk("\x1b[0m\n");
        response = this._assembleStreamResponse(chunks);
        if (response.content) printStreamEnd();
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
        await this.log.append({
          role: "assistant",
          content: response.content,
          tool_calls: response.tool_calls.map((tc) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        });

        for (const tc of response.tool_calls) {
          const fnName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
            printError(`Bad arguments for tool "${fnName}"`);
          }

          const perm = this._checkPermission(fnName, args);

          if (!perm.allowed) {
            printToolCall(fnName, args);
            const errMsg = `Blocked: ${perm.reason}`;
            printToolResult(errMsg);
            this.conversation.addToolResult(tc.id, errMsg);
            await this.log.append({ role: "tool", name: fnName, result: errMsg });
            continue;
          }

          if (perm.needsApproval) {
            printToolCall(fnName, args);
            const approved = await this._requestApproval(fnName, args, perm.reason);
            if (!approved) {
              const errMsg = "User denied this operation.";
              printToolResult(errMsg);
              this.conversation.addToolResult(tc.id, errMsg);
              await this.log.append({ role: "tool", name: fnName, result: errMsg });
              continue;
            }
          } else {
            printToolCall(fnName, args);
          }

          const result = await this.toolExecutor.execute(fnName.toLowerCase(), args);
          printToolResult(result);
          this.conversation.addToolResult(tc.id, String(result));
          await this.log.append({ role: "tool", name: fnName, result: String(result) });
        }

        continue;
      }

      // Final text response
      this.conversation.addAssistantMessage(response.content || "");
      await this.log.append({ role: "assistant", content: response.content });
      if (response.usage) printTokenUsage(response.usage);
      printResponseFooter();
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
        const cpIndex = checkpoints[selectedIdx].index;
        if (option === 0) {
          const result = this.rollback.fullRollback(cpIndex);
          if (result.restored) {
            this.conversation.messages = result.messages;
            printSuccess(`Full rollback to checkpoint ${cpIndex + 1}.`);
          } else printError("Rollback failed.");
        } else if (option === 1) {
          const result = this.rollback.contextRollback(cpIndex);
          if (result.restored) {
            this.conversation.messages = result.messages;
            printSuccess(`Context restored to checkpoint ${cpIndex + 1}.`);
          } else printError("Context restore failed.");
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKey);
        this._inRollbackMode = false;
        process.stdout.write("\x1b[2J\x1b[H");
        printInfo("Exited rollback mode.");
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

    switch (command) {
      case "/help":
        printHelp();
        break;

      case "/clear":
        this.conversation.clear();
        await this.log.clear();
        printInfo("Conversation cleared.");
        break;

      case "/config":
        printInfo("Current config:");
        console.log(JSON.stringify(this.client.config, null, 2));
        break;

      case "/reasoning": {
        const level = parts[1]?.toLowerCase();
        if (!level) {
          printInfo(`Reasoning: ${this.client.config.reasoning_effort}`);
          break;
        }
        if (!REASONING_LEVELS.includes(level)) {
          printError(`Invalid. Options: ${REASONING_LEVELS.join(", ")}`);
          break;
        }
        this.client.config.reasoning_effort = level;
        printSuccess(`Reasoning: ${level}`);
        break;
      }

      case "/supercompress":
        this.superCompress = !this.superCompress;
        printInfo(`Super compress: ${this.superCompress ? "ON" : "OFF"}`);
        break;

      case "/contextsearch":
        this.contextSearchEnabled = !this.contextSearchEnabled;
        printInfo(`Context search: ${this.contextSearchEnabled ? "ON" : "OFF"}`);
        break;

      case "/trust": {
        const mode = parts[1]?.toLowerCase();
        if (!mode) {
          printInfo(`Trust: ${this._trustLabel(this.trustMode)}`);
          printInfo(`Outside workspace: ${this.allowOutsideWorkspace ? "allowed" : "blocked"}`);
          printInfo("Usage: /trust readonly|approval|open|outside");
          break;
        }
        if (mode === "readonly" || mode === "1") this.trustMode = TRUST_READONLY;
        else if (mode === "approval" || mode === "2") this.trustMode = TRUST_APPROVAL;
        else if (mode === "open" || mode === "3") this.trustMode = TRUST_OPEN;
        else if (mode === "outside") {
          this.allowOutsideWorkspace = !this.allowOutsideWorkspace;
          printInfo(`Outside workspace: ${this.allowOutsideWorkspace ? "allowed" : "blocked"}`);
          break;
        } else {
          printError(`Unknown mode: ${mode}`);
          break;
        }
        // Update ToolExecutor and rebuild system prompt
        this.toolExecutor.trustMode = this.trustMode;
        this.conversation.updateSystemPrompt(buildSystemPrompt(this.workspace, this.trustMode));
        printSuccess(`Trust: ${this._trustLabel(this.trustMode)}`);
        break;
      }

      case "/workspace": {
        const newWs = parts.slice(1).join(" ").trim();
        if (!newWs) {
          printInfo(`Workspace: ${this.workspace}`);
          break;
        }
        this.workspace = path.resolve(newWs);
        this.memory = new MemoryManager(this.workspace);
        this.log = new ConversationLog(this.workspace);
        this.rollback = new RollbackManager(this.workspace);
        // Update ToolExecutor and rebuild system prompt
        this.toolExecutor.workspace = this.workspace;
        this.conversation.updateSystemPrompt(buildSystemPrompt(this.workspace, this.trustMode));
        printSuccess(`Workspace: ${this.workspace}`);
        break;
      }

      case "/history":
        await this._handleHistory(parts.slice(1));
        break;

      case "/context":
        printInfo(`Context: ${this.conversation.getUsagePercent()}`);
        printInfo(`Messages: ${this.conversation.messages.length}`);
        printInfo(`Checkpoints: ${this.rollback.count}`);
        printInfo(`Session: ${this._sessionId}`);
        break;

      case "/settings":
        await this._handleSettings(parts.slice(1));
        break;

      case "/exit":
        await this._gracefulExit();
        break;

      default:
        printError(`Unknown command: ${cmd}. Type /help for commands.`);
    }
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
      const filepath = await this.history.save({
        id: this._sessionId,
        cwd: this.workspace,
        messages: this.conversation.getMessages(),
        config: this.client.config,
      });
      printSuccess(`Saved: ${filepath}`);
      return;
    }
    if (subCmd === "restore") {
      const id = args[1];
      if (!id) { printError("Usage: /history restore <number>"); return; }
      const session = await this.history.load(id);
      if (!session) { printError(`Not found: ${id}`); return; }
      this.conversation.messages = session.messages;
      this._sessionId = session.id;
      printSuccess(`Restored (${session.messageCount} messages)`);
      return;
    }
    printError(`Unknown: ${subCmd}. Options: list, save, restore`);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async _handleSettings(args) {
    const subCmd = args[0]?.toLowerCase();
    if (!subCmd) {
      const G = "\x1b[90m", R = "\x1b[0m", C = "\x1b[38;5;87m", B = "\x1b[1m";
      const GR = "\x1b[32m", D = "\x1b[2m";
      console.log("");
      console.log(`${B}${C}  \u256d\u2500 Settings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e${R}`);
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
        ["supercompress", this.superCompress ? "ON" : "OFF"],
        ["contextsearch", this.contextSearchEnabled ? "ON" : "OFF"],
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
      case "stream": this.client.config.stream = value === "true" || value === "on"; break;
      case "diffusing": this.client.config.diffusing = value === "true" || value === "on"; break;
      case "api_base": this.client.baseURL = value; break;
      case "api_key": this.client.apiKey = value; break;
      case "supercompress": this.superCompress = value === "true" || value === "on"; break;
      case "contextsearch": this.contextSearchEnabled = value === "true" || value === "on"; break;
      default:
        printError(`Unknown setting: ${subCmd}`);
        return;
    }
    printSuccess(`${subCmd} updated.`);
  }

  // ── Graceful exit ─────────────────────────────────────────────────────────

  async _gracefulExit() {
    if (this.conversation && this.conversation.messages.length > 1) {
      try {
        await this.history.save({
          id: this._sessionId,
          cwd: this.workspace,
          messages: this.conversation.getMessages(),
          config: this.client.config,
        });
        printInfo("Session auto-saved.");
      } catch { /* non-critical */ }
    }
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
