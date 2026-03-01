// Mercury Code - REPL (Read-Eval-Print Loop)
// Handles user input, sends messages to Mercury-2, processes tool calls,
// and displays results. Integrates session history, rollback, and ESC undo.

import readline from "node:readline";
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
  printRollbackUI,
  printRollbackConfirm,
  printSessionList,
  spinner,
} from "./ui/display.js";

// Maximum number of agentic tool-call turns before forcing a stop
const MAX_TOOL_TURNS = 100;

// ESC detection: triple-press within this window triggers rollback
const ESC_WINDOW_MS = 800;

export class MercuryRepl {
  constructor(options = {}) {
    this.client = new MercuryClient(options);
    this.toolExecutor = new ToolExecutor({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.memory = new MemoryManager(process.cwd());
    this.log = new ConversationLog(process.cwd());
    this.conversation = new Conversation(buildSystemPrompt(process.cwd()));
    this.history = new SessionHistory();
    this.rollback = new RollbackManager(process.cwd());
    this.verbose = options.verbose || false;
    this.superCompress = false;
    this.contextSearchEnabled = false; // Expensive tool — user must enable with /contextsearch
    this._rl = null;
    this._toolTurnCount = 0;
    this._processing = false;
    this._sessionId = this._generateSessionId();

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
    await this.conversation.loadMemory(this.memory);
    printWelcome();

    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[38;5;87m\x1b[1m❯ \x1b[0m",
    });

    // Enable keypress events for ESC detection
    // Must be called BEFORE readline manages stdin, and readline handles raw mode itself
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

  /**
   * Set up raw keyboard listener for ESC detection.
   */
  _setupKeyListener() {
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;

      // Detect ESC key
      if (key.name === "escape" && !this._processing) {
        const now = Date.now();
        // Remove old presses outside the window
        this._escPresses = this._escPresses.filter(
          (t) => now - t < ESC_WINDOW_MS
        );
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

    // Create a rollback checkpoint before processing
    // Use .messages directly (not getMessages which prepends system prompt)
    this.rollback.createCheckpoint(
      trimmed,
      this.conversation.messages
    );

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

  // ── Core loop: send to Mercury-2 and process the response ────────────────

  async _sendAndProcess() {
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

        // Dynamically build tools list — exclude ContextSearch when disabled
        const activeTools = this.contextSearchEnabled
          ? TOOL_DEFINITIONS
          : TOOL_DEFINITIONS.filter(t => t.function.name !== 'ContextSearch');

        let inReasoning = false; // Track whether we're in reasoning output

        for await (const chunk of this.client.chatCompletionStream(
          this.conversation.getMessages(),
          { tools: activeTools }
        )) {
          if (firstChunk) {
            spinner.stop();
            firstChunk = false;
          }
          chunks.push(chunk);
          const delta = chunk.choices?.[0]?.delta;

          // Handle reasoning/thinking output (Mercury-2 chain-of-thought)
          const reasoning = delta?.reasoning_content || delta?.reasoning;
          if (reasoning) {
            if (!inReasoning) {
              inReasoning = true;
              printStreamChunk("\x1b[2m\x1b[3m💭 "); // Dim italic for reasoning
            }
            printStreamChunk(reasoning);
          }

          // Handle actual content output
          if (delta?.content) {
            if (inReasoning) {
              inReasoning = false;
              printStreamChunk("\x1b[0m\n"); // Reset formatting, newline
            }
            printStreamChunk(delta.content);
          }
        }

        if (firstChunk) spinner.stop();
        if (inReasoning) printStreamChunk("\x1b[0m\n"); // Close reasoning formatting
        response = this._assembleStreamResponse(chunks);
        if (response.content) printStreamEnd();
        if (response.usage) this.conversation.updateUsage(response.usage);
      } catch (err) {
        spinner.stop();
        printError(`API error: ${err.message}`);
        if (this.verbose) console.error(err.stack);
        return;
      }

      // ── Tool calls ──────────────────────────────────────────────────────
      if (response.tool_calls && response.tool_calls.length > 0) {
        this._toolTurnCount++;

        if (this._toolTurnCount > MAX_TOOL_TURNS) {
          printError(
            `Reached maximum tool-call turns (${MAX_TOOL_TURNS}). Stopping.`
          );
          this.conversation.addAssistantMessage(
            response.content || "(Stopped: maximum tool-call turns reached)"
          );
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

          printToolCall(fnName, args);
          const result = await this.toolExecutor.execute(
            fnName.toLowerCase(),
            args
          );
          printToolResult(result);
          this.conversation.addToolResult(tc.id, String(result));
          await this.log.append({
            role: "tool",
            name: fnName,
            result: String(result),
          });
        }

        continue;
      }

      // ── Plain text response — exit the loop ──────────────────────────────
      this.conversation.addAssistantMessage(response.content || "");
      await this.log.append({
        role: "assistant",
        content: response.content,
      });
      if (response.usage) printTokenUsage(response.usage);
      return;
    }
  }

  // ── Rollback Mode (triple ESC) ─────────────────────────────────────────

  async _enterRollbackMode() {
    const checkpoints = this.rollback.getCheckpoints();
    if (checkpoints.length === 0) {
      printInfo("没有可用的检查点。需要先发送至少一条消息。");
      return;
    }

    this._inRollbackMode = true;
    let selectedIdx = 0;
    let phase = "select"; // "select" or "confirm"
    let confirmIdx = 0;

    const render = () => {
      if (phase === "select") {
        printRollbackUI(checkpoints, selectedIdx);
      } else {
        printRollbackConfirm(checkpoints[selectedIdx], confirmIdx);
      }
    };

    render();

    return new Promise((resolve) => {
      const onKey = (str, key) => {
        if (!key) return;

        if (key.name === "escape") {
          // Exit rollback mode
          cleanup();
          return;
        }

        if (phase === "select") {
          if (key.name === "up" && selectedIdx > 0) {
            selectedIdx--;
            render();
          } else if (key.name === "down" && selectedIdx < checkpoints.length - 1) {
            selectedIdx++;
            render();
          } else if (key.name === "return") {
            phase = "confirm";
            confirmIdx = 0;
            render();
          }
        } else if (phase === "confirm") {
          if (key.name === "up" && confirmIdx > 0) {
            confirmIdx--;
            render();
          } else if (key.name === "down" && confirmIdx < 2) {
            confirmIdx++;
            render();
          } else if (key.name === "return") {
            executeRollback(confirmIdx);
            cleanup();
          }
        }
      };

      const executeRollback = (option) => {
        const cpIndex = checkpoints[selectedIdx].index;

        if (option === 0) {
          // Full rollback
          const result = this.rollback.fullRollback(cpIndex);
          if (result.restored) {
            this.conversation.messages = result.messages;
            printSuccess(
              `完整回滚成功！对话已恢复到检查点 ${cpIndex + 1}。` +
                (result.fileRestored
                  ? " 文件更改已还原。"
                  : " (文件未能还原，请手动检查)")
            );
          } else {
            printError("回滚失败。");
          }
        } else if (option === 1) {
          // Context-only rollback
          const result = this.rollback.contextRollback(cpIndex);
          if (result.restored) {
            this.conversation.messages = result.messages;
            printSuccess(
              `上下文已恢复到检查点 ${cpIndex + 1}。文件保持不变。`
            );
          } else {
            printError("上下文恢复失败。");
          }
        }
        // option === 2 is cancel, do nothing
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKey);
        this._inRollbackMode = false;
        // Restore normal screen
        process.stdout.write("\x1b[2J\x1b[H"); // clear screen
        printInfo("已退出撤回模式。");
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
        printInfo("对话已清除。");
        break;

      case "/config":
        printInfo("当前配置:");
        console.log(JSON.stringify(this.client.config, null, 2));
        break;

      case "/reasoning": {
        const level = parts[1]?.toLowerCase();
        if (!level) {
          printInfo(`当前推理深度: ${this.client.config.reasoning_effort}`);
          printInfo(`可用级别: ${REASONING_LEVELS.join(", ")}`);
          break;
        }
        if (!REASONING_LEVELS.includes(level)) {
          printError(`无效级别 "${level}"。可选: ${REASONING_LEVELS.join(", ")}`);
          break;
        }
        this.client.config.reasoning_effort = level;
        printSuccess(`推理深度已设置为: ${level}`);
        break;
      }

      case "/supercompress":
        this.superCompress = !this.superCompress;
        if (this.superCompress) {
          printInfo(
            "超级压缩: ON — 在 25% 容量时触发极致压缩。" +
              "完整对话记录保存在 .mercury/conversation.jsonl"
          );
        } else {
          printInfo("超级压缩: OFF — 使用普通压缩 (60% 阈值)。");
        }
        break;

      case "/contextsearch":
        this.contextSearchEnabled = !this.contextSearchEnabled;
        if (this.contextSearchEnabled) {
          printInfo(
            "上下文搜索: ON — 模型现在可以使用 ContextSearch 工具在完整对话日志中搜索历史内容。" +
              "注意：此工具会消耗较多 token。"
          );
        } else {
          printInfo("上下文搜索: OFF — ContextSearch 工具已禁用。模型仍可用 Read 直接读取 .mercury/conversation.jsonl。");
        }
        break;

      case "/history":
        await this._handleHistory(parts.slice(1));
        break;

      case "/context":
        printInfo(`上下文使用: ${this.conversation.getUsagePercent()}`);
        printInfo(`消息数量: ${this.conversation.messages.length}`);
        printInfo(`检查点数: ${this.rollback.count}`);
        printInfo(`记忆文件: ${this.memory.filePath}`);
        printInfo(`对话日志: ${this.log.filePath}`);
        printInfo(`超级压缩: ${this.superCompress ? "ON" : "OFF"}`);
        printInfo(`上下文搜索: ${this.contextSearchEnabled ? "ON" : "OFF"}`);
        printInfo(`会话 ID: ${this._sessionId}`);
        break;

      case "/settings":
        await this._handleSettings(parts.slice(1));
        break;

      case "/exit":
        await this._gracefulExit();
        break;

      default:
        printError(`未知命令: ${cmd}。输入 /help 查看可用命令。`);
    }
  }

  // ── History sub-commands ──────────────────────────────────────────────────

  async _handleHistory(args) {
    const subCmd = args[0]?.toLowerCase();

    if (!subCmd || subCmd === "list") {
      // List all sessions
      const sessions = await this.history.list();
      printSessionList(sessions);
      return;
    }

    if (subCmd === "save") {
      const filepath = await this.history.save({
        id: this._sessionId,
        cwd: process.cwd(),
        messages: this.conversation.getMessages(),
        config: this.client.config,
      });
      printSuccess(`会话已保存: ${filepath}`);
      return;
    }

    if (subCmd === "restore") {
      const id = args[1];
      if (!id) {
        printError("请指定会话编号。用法: /history restore <编号>");
        return;
      }
      const session = await this.history.load(id);
      if (!session) {
        printError(`找不到会话: ${id}`);
        return;
      }
      this.conversation.messages = session.messages;
      this._sessionId = session.id;
      printSuccess(
        `已恢复会话 (${session.messageCount} 条消息, ${new Date(session.timestamp).toLocaleString()})`
      );
      return;
    }

    printError(`未知的 history 子命令: ${subCmd}。可用: list, save, restore`);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async _handleSettings(args) {
    const subCmd = args[0]?.toLowerCase();

    if (!subCmd) {
      // Show all current settings
      console.log("");
      console.log(`\x1b[1m\x1b[38;5;87m  ╭─ 设置 (Settings) ─────────────────────────────────────╮\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mmodel          \x1b[0m \x1b[2m${this.client.config.model}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mreasoning      \x1b[0m \x1b[2m${this.client.config.reasoning_effort}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mtemperature    \x1b[0m \x1b[2m${this.client.config.temperature}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mmax_tokens     \x1b[0m \x1b[2m${this.client.config.max_tokens}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mstream         \x1b[0m \x1b[2m${this.client.config.stream}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mdiffusing      \x1b[0m \x1b[2m${this.client.config.diffusing}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mapi_base       \x1b[0m \x1b[2m${this.client.baseURL}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mapi_key        \x1b[0m \x1b[2m${this.client.apiKey ? this.client.apiKey.slice(0, 8) + "..." + this.client.apiKey.slice(-4) : "(not set)"}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32msupercompress  \x1b[0m \x1b[2m${this.superCompress ? "ON" : "OFF"}\x1b[0m`);
      console.log(`\x1b[90m  │\x1b[0m  \x1b[32mcontextsearch  \x1b[0m \x1b[2m${this.contextSearchEnabled ? "ON" : "OFF"}\x1b[0m`);
      console.log(`\x1b[1m\x1b[38;5;87m  ╰──────────────────────────────────────────────────────╯\x1b[0m`);
      console.log("");
      printInfo("用法: /settings <key> <value>");
      printInfo("示例: /settings temperature 0.8");
      printInfo("      /settings api_key sk_xxxx...");
      printInfo("      /settings reasoning high");
      console.log("");
      return;
    }

    const value = args.slice(1).join(" ");
    if (!value) {
      printError(`请提供值。用法: /settings ${subCmd} <value>`);
      return;
    }

    switch (subCmd) {
      case "model":
        this.client.config.model = value;
        printSuccess(`model 已设为: ${value}`);
        break;

      case "reasoning":
        if (!REASONING_LEVELS.includes(value)) {
          printError(`无效级别 "${value}"。可选: ${REASONING_LEVELS.join(", ")}`);
          return;
        }
        this.client.config.reasoning_effort = value;
        printSuccess(`reasoning 已设为: ${value}`);
        break;

      case "temperature": {
        const temp = parseFloat(value);
        if (isNaN(temp) || temp < 0 || temp > 2) {
          printError("temperature 必须是 0-2 之间的数字。");
          return;
        }
        this.client.config.temperature = temp;
        printSuccess(`temperature 已设为: ${temp}`);
        break;
      }

      case "max_tokens": {
        const tokens = parseInt(value, 10);
        if (isNaN(tokens) || tokens < 1 || tokens > 50000) {
          printError("max_tokens 必须是 1-50000 之间的整数。");
          return;
        }
        this.client.config.max_tokens = tokens;
        printSuccess(`max_tokens 已设为: ${tokens}`);
        break;
      }

      case "stream":
        this.client.config.stream = value === "true" || value === "on";
        printSuccess(`stream 已设为: ${this.client.config.stream}`);
        break;

      case "diffusing":
        this.client.config.diffusing = value === "true" || value === "on";
        printSuccess(`diffusing 已设为: ${this.client.config.diffusing}`);
        break;

      case "api_base":
        this.client.baseURL = value;
        printSuccess(`api_base 已设为: ${value}`);
        break;

      case "api_key":
        this.client.apiKey = value;
        printSuccess(`api_key 已更新: ${value.slice(0, 8)}...${value.slice(-4)}`);
        break;

      case "supercompress":
        this.superCompress = value === "true" || value === "on";
        printSuccess(`supercompress 已设为: ${this.superCompress ? "ON" : "OFF"}`);
        break;

      case "contextsearch":
        this.contextSearchEnabled = value === "true" || value === "on";
        printSuccess(`contextsearch 已设为: ${this.contextSearchEnabled ? "ON" : "OFF"}`);
        break;

      default:
        printError(
          `未知设置项: ${subCmd}。可用: model, reasoning, temperature, max_tokens, ` +
          `stream, diffusing, api_base, api_key, supercompress, contextsearch`
        );
    }
  }

  // ── Graceful exit ─────────────────────────────────────────────────────────

  async _gracefulExit() {
    // Auto-save session on exit if there are messages
    if (this.conversation.messages.length > 1) {
      try {
        await this.history.save({
          id: this._sessionId,
          cwd: process.cwd(),
          messages: this.conversation.getMessages(),
          config: this.client.config,
        });
        printInfo("会话已自动保存。");
      } catch {
        // non-critical
      }
    }
    printInfo("再见！");
    process.exit(0);
  }

  // ── Stream assembly ──────────────────────────────────────────────────────

  _assembleStreamResponse(chunks) {
    let content = "";
    let reasoning = "";
    const toolCallMap = {};
    let usage = null;

    for (const chunk of chunks) {
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) content += delta.content;

      // Collect reasoning/thinking content (Mercury-2 chain-of-thought)
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.reasoning) reasoning += delta.reasoning;

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap[idx]) {
            toolCallMap[idx] = {
              id: tc.id || "",
              type: tc.type || "function",
              function: {
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              },
            };
          } else {
            if (tc.id) toolCallMap[idx].id = tc.id;
            if (tc.function?.name)
              toolCallMap[idx].function.name = tc.function.name;
            if (tc.function?.arguments)
              toolCallMap[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    const indices = Object.keys(toolCallMap)
      .map(Number)
      .sort((a, b) => a - b);
    const tool_calls =
      indices.length > 0 ? indices.map((i) => toolCallMap[i]) : null;

    return { content: content || null, reasoning: reasoning || null, tool_calls, usage };
  }
}
