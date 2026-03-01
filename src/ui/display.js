// Mercury Code - Terminal Display Module
// Beautiful ANSI-styled terminal UI with 256-color support

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8")
).version;

// ── ANSI Escape Codes ────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;

// Standard colors
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;

// 256-color palette for gradients
const fg256 = (n) => `${ESC}38;5;${n}m`;
const bg256 = (n) => `${ESC}48;5;${n}m`;

// Mercury brand gradient colors (teal → cyan → white)
const BRAND = [fg256(30), fg256(37), fg256(44), fg256(51), fg256(87), fg256(123)];

// ── ASCII Art Logo ───────────────────────────────────────────────────────────

const MERCURY_LOGO = [
  "  ███╗   ███╗ ███████╗ ██████╗   ██████╗ ██╗   ██╗ ██████╗  ██╗   ██╗",
  "  ████╗ ████║ ██╔════╝ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ╚██╗ ██╔╝",
  "  ██╔████╔██║ █████╗   ██████╔╝ ██║      ██║   ██║ ██████╔╝  ╚████╔╝ ",
  "  ██║╚██╔╝██║ ██╔══╝   ██╔══██╗ ██║      ██║   ██║ ██╔══██╗   ╚██╔╝  ",
  "  ██║ ╚═╝ ██║ ███████╗ ██║  ██║ ╚██████╗ ╚██████╔╝ ██║  ██║    ██║   ",
  "  ╚═╝     ╚═╝ ╚══════╝ ╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═╝  ╚═╝    ╚═╝   ",
];

// ── Display Functions ────────────────────────────────────────────────────────

/**
 * Print the beautiful welcome banner with gradient ASCII art.
 */
export function printWelcome() {
  console.log("");

  // Print logo with gradient coloring
  for (let i = 0; i < MERCURY_LOGO.length; i++) {
    const color = BRAND[i % BRAND.length];
    console.log(`${color}${BOLD}${MERCURY_LOGO[i]}${RESET}`);
  }

  console.log("");
  console.log(
    `${GRAY}  ─────────────────────────────────────────────────────────────────${RESET}`
  );
  console.log(
    `${BOLD}${fg256(87)}  Mercury Code${RESET} ${DIM}v${PKG_VERSION}${RESET}  ${GRAY}│${RESET}  ${DIM}Powered by Mercury-2 Diffusion Model${RESET}`
  );
  console.log(
    `${DIM}  Inception Labs${RESET}         ${GRAY}│${RESET}  ${DIM}Type /help for commands, /exit to quit${RESET}`
  );
  console.log(
    `${GRAY}  ─────────────────────────────────────────────────────────────────${RESET}`
  );
  console.log("");
}

/**
 * Print available commands in a styled table.
 */
export function printHelp() {
  const SEP = `${GRAY}│${RESET}`;
  console.log("");
  console.log(`${BOLD}${fg256(87)}  ╭─ Commands ─────────────────────────────────────────╮${RESET}`);

  const cmds = [
    ["/help", "显示帮助信息"],
    ["/clear", "清除对话历史"],
    ["/reasoning <level>", "设置推理深度 (instant/low/medium/high)"],
    ["/supercompress", "切换超级压缩模式 (on/off)"],
    ["/contextsearch", "切换上下文搜索工具 (默认关闭，消耗token)"],
    ["/history", "查看/恢复历史会话"],
    ["/history save", "保存当前会话"],
    ["/history restore <n>", "恢复第 n 个会话"],
    ["/context", "查看上下文使用情况"],
    ["/settings", "查看/修改设置 (API密钥、模型参数等)"],
    ["/config", "显示当前配置 (只读)"],
    ["/exit", "退出 Mercury Code"],
  ];

  for (const [cmd, desc] of cmds) {
    const cmdPadded = cmd.padEnd(24);
    console.log(`  ${GRAY}│${RESET} ${GREEN}${cmdPadded}${RESET} ${DIM}${desc}${RESET}`);
  }

  console.log(`${BOLD}${fg256(87)}  ╰──────────────────────────────────────────────────╯${RESET}`);
  console.log("");
  console.log(`  ${DIM}快捷键: ${YELLOW}ESC×3${RESET} ${DIM}进入撤回模式 (回滚到之前的任意时间点)${RESET}`);
  console.log(`  ${DIM}        ${YELLOW}Ctrl+C${RESET} ${DIM}中断当前操作${RESET}`);
  console.log("");
}

/**
 * Print a tool call notification with styled formatting.
 */
export function printToolCall(name, args) {
  // Tool icon based on type
  const icons = {
    Read: "📖", Write: "📝", Edit: "✏️ ", Patch: "🔨", Bash: "⚡",
    Glob: "🔍", Grep: "🔎", ListDir: "📂", Diff: "📊", Fetch: "🌐",
    ContextSearch: "🔬", SubAgent: "🤖", SubAgentTeam: "👥",
  };
  const icon = icons[name] || "🔧";

  console.log("");
  console.log(`${fg256(214)}${BOLD}  ${icon} ${name}${RESET}`);

  // Show key args in a compact format
  const summary = _formatToolArgs(name, args);
  if (summary) {
    console.log(`${GRAY}     ${summary}${RESET}`);
  }
}

/**
 * Format tool arguments for compact display.
 */
function _formatToolArgs(name, args) {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return args.file_path ? `→ ${basename(args.file_path)}` : "";
    case "Bash":
      return args.command
        ? `$ ${args.command.length > 80 ? args.command.slice(0, 80) + "..." : args.command}`
        : "";
    case "Glob":
      return args.pattern ? `pattern: ${args.pattern}` : "";
    case "Grep":
      return args.pattern ? `/${args.pattern}/` : "";
    case "Fetch":
      return args.url ? `→ ${args.url}` : "";
    case "Patch":
      return args.file_path ? `→ ${basename(args.file_path)} (${args.edits?.length || 0} edits)` : "";
    case "Diff":
      if (args.file_a && args.file_b) return `${basename(args.file_a)} ↔ ${basename(args.file_b)}`;
      if (args.git_ref) return `ref: ${args.git_ref}`;
      return args.file_a ? `→ ${basename(args.file_a)}` : "uncommitted changes";
    case "ListDir":
      return args.path || "";
    case "ContextSearch":
      return args.query
        ? `query: ${args.query.length > 50 ? args.query.slice(0, 50) + "..." : args.query}${args.scope ? ` (${args.scope})` : ""}`
        : "";
    case "SubAgent":
      return args.task
        ? args.task.length > 60 ? args.task.slice(0, 60) + "..." : args.task
        : "";
    default:
      return "";
  }
}

/**
 * Print tool result with truncation and styling.
 */
export function printToolResult(result, truncateAt = 600) {
  let output = String(result);
  if (output.length > truncateAt) {
    output =
      output.slice(0, truncateAt) +
      `\n${DIM}... (${result.length} chars total)${RESET}`;
  }
  // Indent result lines slightly
  const lines = output.split("\n");
  for (const line of lines) {
    console.log(`${GRAY}     ${line}${RESET}`);
  }
  console.log("");
}

/**
 * Print an error message with red styling.
 */
export function printError(message) {
  console.error(`\n${RED}${BOLD}  ✗ ${message}${RESET}\n`);
}

/**
 * Print an info message with blue icon.
 */
export function printInfo(message) {
  console.log(`${fg256(75)}  ℹ ${message}${RESET}`);
}

/**
 * Print a success message with green styling.
 */
export function printSuccess(message) {
  console.log(`${GREEN}${BOLD}  ✓ ${message}${RESET}`);
}

/**
 * Print token usage with a visual bar.
 */
export function printTokenUsage(usage) {
  const { prompt_tokens = 0, completion_tokens = 0, total_tokens = 0 } =
    usage || {};

  // Extract reasoning token breakdown if available
  const details = usage?.completion_tokens_details || {};
  const reasoningTokens = details.reasoning_tokens || 0;

  // Mini bar showing prompt vs completion ratio
  const barWidth = 20;
  const total = prompt_tokens + completion_tokens || 1;
  const promptBar = Math.round((prompt_tokens / total) * barWidth);
  const compBar = barWidth - promptBar;

  const bar =
    `${fg256(75)}${"█".repeat(promptBar)}${RESET}` +
    `${fg256(214)}${"█".repeat(compBar)}${RESET}`;

  let line =
    `${DIM}  tokens ${bar} ` +
    `${fg256(75)}prompt:${prompt_tokens}${RESET} ` +
    `${fg256(214)}completion:${completion_tokens}${RESET}`;

  if (reasoningTokens > 0) {
    line += ` ${fg256(141)}reasoning:${reasoningTokens}${RESET}`;
  }

  line += ` ${DIM}total:${total_tokens}${RESET}`;
  console.log(line);
}

/**
 * Write a text chunk to stdout without newline (for streaming).
 */
export function printStreamChunk(text) {
  process.stdout.write(text);
}

/**
 * Write a newline after stream completes.
 */
export function printStreamEnd() {
  process.stdout.write("\n");
}

/**
 * Print the rollback mode UI.
 * @param {Array<{index, date, userMessage}>} checkpoints
 * @param {number} selectedIndex - currently highlighted index
 */
export function printRollbackUI(checkpoints, selectedIndex) {
  // Clear screen and draw rollback interface
  process.stdout.write(`${ESC}2J${ESC}H`); // clear screen

  console.log("");
  console.log(`${BOLD}${fg256(214)}  ╭─ 撤回模式 (Rollback) ──────────────────────────────╮${RESET}`);
  console.log(`${GRAY}  │ 使用 ↑↓ 选择时间点，Enter 确认，ESC 取消           │${RESET}`);
  console.log(`${fg256(214)}  ├───────────────────────────────────────────────────────┤${RESET}`);

  if (checkpoints.length === 0) {
    console.log(`${GRAY}  │   (没有可用的检查点)                                  │${RESET}`);
  } else {
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? `${BOLD}${fg256(87)} ▸ ` : `${GRAY}   `;
      const msg =
        cp.userMessage.length > 45
          ? cp.userMessage.slice(0, 45) + "..."
          : cp.userMessage.padEnd(48);
      const time = `${DIM}${cp.date}${RESET}`;

      console.log(`  │${prefix}${i + 1}. ${msg}${RESET} ${time}  │`);
    }
  }

  console.log(`${fg256(214)}  ╰───────────────────────────────────────────────────────╯${RESET}`);
  console.log("");
}

/**
 * Print rollback confirmation options.
 * @param {object} checkpoint - Selected checkpoint
 * @param {number} selectedOption - 0 = full, 1 = context-only, 2 = cancel
 */
export function printRollbackConfirm(checkpoint, selectedOption) {
  process.stdout.write(`${ESC}2J${ESC}H`);

  console.log("");
  console.log(`${BOLD}${fg256(214)}  ╭─ 确认撤回 ──────────────────────────────────────────╮${RESET}`);
  console.log(`${GRAY}  │ 目标: "${checkpoint.userMessage.slice(0, 40)}..."${RESET}`);
  console.log(`${fg256(214)}  ├───────────────────────────────────────────────────────┤${RESET}`);

  const options = [
    ["完整回滚", "恢复所有文件更改 + 对话上下文到该时间点"],
    ["仅恢复上下文", "保留文件不变，只回滚对话上下文和模型状态"],
    ["取消", "返回，不做任何操作"],
  ];

  for (let i = 0; i < options.length; i++) {
    const [label, desc] = options[i];
    const isSelected = i === selectedOption;
    const prefix = isSelected ? `${BOLD}${fg256(87)} ▸ ` : `${GRAY}   `;
    console.log(`  │${prefix}${label}${RESET}`);
    console.log(`  │${GRAY}     ${desc}${RESET}`);
  }

  console.log(`${fg256(214)}  ╰───────────────────────────────────────────────────────╯${RESET}`);
  console.log("");
}

/**
 * Print session history list.
 * @param {Array} sessions
 */
export function printSessionList(sessions) {
  if (sessions.length === 0) {
    printInfo("没有保存的会话记录。使用 /history save 保存当前会话。");
    return;
  }

  console.log("");
  console.log(`${BOLD}${fg256(87)}  ╭─ 历史会话 ──────────────────────────────────────────╮${RESET}`);

  for (let i = 0; i < Math.min(sessions.length, 20); i++) {
    const s = sessions[i];
    const date = new Date(s.timestamp).toLocaleString();
    const msgs = `${s.messageCount} msgs`;
    const summary =
      s.summary.length > 40 ? s.summary.slice(0, 40) + "..." : s.summary;

    console.log(
      `  ${GRAY}│${RESET} ${fg256(87)}${String(i + 1).padStart(2)}.${RESET} ` +
        `${DIM}${date}${RESET} ${GRAY}(${msgs})${RESET}`
    );
    console.log(`  ${GRAY}│${RESET}     ${DIM}${summary}${RESET}`);
  }

  console.log(`${BOLD}${fg256(87)}  ╰──────────────────────────────────────────────────────╯${RESET}`);
  console.log("");
  console.log(`  ${DIM}使用 /history restore <编号> 恢复会话${RESET}`);
  console.log("");
}

// ── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const spinner = {
  _interval: null,
  _frameIndex: 0,

  start(text = "Thinking...") {
    if (this._interval) return;
    this._frameIndex = 0;
    process.stdout.write("\x1b[?25l"); // hide cursor
    this._interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this._frameIndex % SPINNER_FRAMES.length];
      // Gradient spinner color
      const color = BRAND[this._frameIndex % BRAND.length];
      process.stdout.write(`\r${color}${frame}${RESET} ${DIM}${text}${RESET}`);
      this._frameIndex++;
    }, 80);
  },

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    process.stdout.write("\r\x1b[K\x1b[?25h");
  },
};
