// Mercury Code - REPL (Read-Eval-Print Loop)
// Handles user input, sends messages to Mercury-2, processes tool calls,
// and displays results.

import readline from "node:readline";
import { MercuryClient } from "./client.js";
import { Conversation } from "./conversation.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { REASONING_LEVELS } from "./config.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { ToolExecutor } from "./tools/executor.js";
import { MemoryManager, ConversationLog } from "./memory.js";
import {
  printWelcome,
  printHelp,
  printToolCall,
  printToolResult,
  printError,
  printInfo,
  printTokenUsage,
  printStreamChunk,
  printStreamEnd,
  spinner,
} from "./ui/display.js";

// Maximum number of agentic tool-call turns before forcing a stop
const MAX_TOOL_TURNS = 100;

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
    this.verbose = options.verbose || false;
    this._rl = null;
    this._toolTurnCount = 0;
  }

  // ── Interactive mode ─────────────────────────────────────────────────────

  async start() {
    // Load persistent memory into conversation
    await this.conversation.loadMemory(this.memory);

    printWelcome();

    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[32m\u276F \x1b[0m",
    });

    this._rl.on("line", async (line) => {
      await this._handleInput(line);
    });

    this._rl.on("close", () => {
      printInfo("Goodbye!");
      process.exit(0);
    });

    this._rl.prompt();
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

    this.conversation.addUserMessage(trimmed);
    await this.log.append({ role: "user", content: trimmed });
    this._toolTurnCount = 0; // Reset turn counter for new user message

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
    // Smart context compression before sending
    await this.conversation.compress(this.client, this.memory, (msg) =>
      printInfo(msg)
    );

    spinner.start("Thinking...");

    try {
      const chunks = [];
      let firstChunk = true;

      for await (const chunk of this.client.chatCompletionStream(
        this.conversation.getMessages(),
        { tools: TOOL_DEFINITIONS }
      )) {
        if (firstChunk) {
          spinner.stop();
          firstChunk = false;
        }
        chunks.push(chunk);

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) printStreamChunk(delta.content);
      }

      if (firstChunk) spinner.stop();

      const response = this._assembleStreamResponse(chunks);

      if (response.content) printStreamEnd();

      if (response.usage) this.conversation.updateUsage(response.usage);

      // ── Tool calls ──────────────────────────────────────────────────────
      if (response.tool_calls && response.tool_calls.length > 0) {
        this._toolTurnCount++;

        // Guard against infinite tool-call loops
        if (this._toolTurnCount > MAX_TOOL_TURNS) {
          printError(
            `Reached maximum tool-call turns (${MAX_TOOL_TURNS}). Stopping to prevent infinite loop.`
          );
          this.conversation.addAssistantMessage(
            response.content ||
              "(Stopped: maximum tool-call turns reached)"
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
            result_preview: String(result).slice(0, 500),
          });
        }

        await this._sendAndProcess();
        return;
      }

      // ── Plain text response ──────────────────────────────────────────────
      this.conversation.addAssistantMessage(response.content || "");
      await this.log.append({
        role: "assistant",
        content: response.content,
      });
      if (response.usage) printTokenUsage(response.usage);
    } catch (err) {
      spinner.stop();
      printError(`API error: ${err.message}`);
      if (this.verbose) console.error(err.stack);
    }
  }

  // ── Slash commands ───────────────────────────────────────────────────────

  async _handleCommand(cmd) {
    const parts = cmd.toLowerCase().split(/\s+/);
    const command = parts[0];
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
        printInfo("Current configuration:");
        console.log(JSON.stringify(this.client.config, null, 2));
        break;
      case "/reasoning": {
        const level = parts[1];
        if (!level) {
          printInfo(
            `Current reasoning effort: ${this.client.config.reasoning_effort}`
          );
          printInfo(`Available levels: ${REASONING_LEVELS.join(", ")}`);
          printInfo(`Usage: /reasoning <level>`);
          break;
        }
        if (!REASONING_LEVELS.includes(level)) {
          printError(
            `Invalid level "${level}". Choose from: ${REASONING_LEVELS.join(", ")}`
          );
          break;
        }
        this.client.config.reasoning_effort = level;
        printInfo(`Reasoning effort set to: ${level}`);
        break;
      }
      case "/context":
        printInfo(`Context usage: ${this.conversation.getUsagePercent()}`);
        printInfo(`Messages: ${this.conversation.messages.length}`);
        printInfo(`Memory file: ${this.memory.filePath}`);
        printInfo(`Conversation log: ${this.log.filePath}`);
        break;
      case "/exit":
        printInfo("Goodbye!");
        process.exit(0);
        break;
      default:
        printError(
          `Unknown command: ${cmd}. Type /help for available commands.`
        );
    }
  }

  // ── Stream assembly ──────────────────────────────────────────────────────

  _assembleStreamResponse(chunks) {
    let content = "";
    const toolCallMap = {};
    let usage = null;

    for (const chunk of chunks) {
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) content += delta.content;

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

    return { content: content || null, tool_calls, usage };
  }
}
