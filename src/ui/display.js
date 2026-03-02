// Mercury Code - Terminal Display Module
// Codex-style terminal UI with agent panel system

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

// Terminal width helper
function getTermWidth() {
  return process.stdout.columns || 80;
}

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
 * Print the welcome banner with gradient ASCII art.
 */
export async function printWelcome() {
  const w = getTermWidth();
  const sep = "─".repeat(Math.min(w - 4, 68));

  console.log("");

  // Animated logo reveal — staggered gradient
  for (let i = 0; i < MERCURY_LOGO.length; i++) {
    const color = BRAND[i % BRAND.length];
    console.log(`${color}${BOLD}${MERCURY_LOGO[i]}${RESET}`);
    await _sleep(40); // Brief delay for visual effect
  }

  console.log("");
  console.log(`${fg256(30)}  ${sep}${RESET}`);
  console.log(
    `${BOLD}${fg256(87)}  Mercury Code${RESET} ${DIM}v${PKG_VERSION}${RESET}  ${GRAY}│${RESET}  ${DIM}Powered by Mercury-2 Diffusion Model${RESET}`
  );
  console.log(
    `${DIM}  Inception Labs${RESET}         ${GRAY}│${RESET}  ${DIM}Type /help for commands, /exit to quit${RESET}`
  );
  console.log(
    `${DIM}  ${GRAY}Shortcuts:${RESET} ${DIM}ESC×3${RESET} ${GRAY}rollback${RESET}  ${DIM}↓${RESET} ${GRAY}agents${RESET}  ${DIM}Ctrl+C${RESET} ${GRAY}interrupt${RESET}`
  );
  console.log(`${fg256(30)}  ${sep}${RESET}`);
  console.log("");
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Print available commands in a styled table.
 */
export function printHelp() {
  console.log("");
  console.log(`${BOLD}${fg256(87)}  ╭─ Commands ─────────────────────────────────────────╮${RESET}`);

  const categories = [
    ["General", [
      ["/help", "Show this help"],
      ["/clear", "Clear conversation"],
      ["/edit", "Open $EDITOR for multiline input"],
      ["/exit", "Exit Mercury Code"],
    ]],
    ["Security & Workspace", [
      ["/trust <mode>", "readonly | approval | open | outside"],
      ["/workspace <path>", "View/change workspace directory"],
    ]],
    ["Model Settings", [
      ["/reasoning <level>", "instant | low | medium | high"],
      ["/settings [key val]", "View/modify any setting"],
      ["/config", "Show raw config (read-only)"],
    ]],
    ["Features", [
      ["/labs [feature]", "Labs mode — toggle experimental features"],
      ["/sandbox [mode]", "on | off | strict | subagents | network"],
      ["/supercompress", "Toggle aggressive compression"],
      ["/contextsearch", "Toggle context search tool"],
      ["/agents [cmd]", "list | create <name> — manage agents"],
    ]],
    ["Session", [
      ["/history [cmd]", "save | restore | list"],
      ["/context", "View context usage & stats"],
      ["/diff [ref]", "Show git diff (default: HEAD)"],
      ["/compact", "Compact/summarize conversation"],
      ["/new", "Start new conversation (saves current)"],
      ["/copy", "Copy last assistant reply to clipboard"],
      ["/init", "Create .mercury.md project config"],
    ]],
  ];

  for (const [category, cmds] of categories) {
    console.log(`  ${GRAY}│${RESET}`);
    console.log(`  ${GRAY}│${RESET} ${BOLD}${fg256(87)}${category}${RESET}`);
    for (const [cmd, desc] of cmds) {
      const cmdPadded = cmd.padEnd(22);
      console.log(`  ${GRAY}│${RESET}   ${GREEN}${cmdPadded}${RESET} ${DIM}${desc}${RESET}`);
    }
  }

  console.log(`  ${GRAY}│${RESET}`);
  console.log(`${BOLD}${fg256(87)}  ╰──────────────────────────────────────────────────╯${RESET}`);
  console.log("");
  console.log(`  ${DIM}Shortcuts:${RESET}`);
  console.log(`    ${YELLOW}ESC×3${RESET}   ${DIM}Enter rollback mode${RESET}`);
  console.log(`    ${YELLOW}\\${RESET}       ${DIM}Open $EDITOR for multiline input${RESET}`);
  console.log(`    ${YELLOW}@file${RESET}   ${DIM}Include file contents in prompt${RESET}`);
  console.log(`    ${YELLOW}Ctrl+C${RESET}  ${DIM}Abort running tool execution${RESET}`);
  console.log(`    ${YELLOW}Ctrl+J${RESET}  ${DIM}Insert newline (multiline input)${RESET}`);
  console.log(`    ${YELLOW}!cmd${RESET}    ${DIM}Execute shell command inline${RESET}`);
  console.log(`    ${YELLOW}Tab${RESET}     ${DIM}Auto-complete slash commands${RESET}`);
  console.log("");
}

// ── Response Framing (Codex-style) ──────────────────────────────────────────

/**
 * Print a header before assistant response starts streaming.
 */
export function printResponseHeader() {
  console.log("");
  console.log(`${fg256(75)}  ┌─ ${BOLD}Mercury${RESET}${fg256(75)} ${"─".repeat(Math.min(getTermWidth() - 16, 60))}${RESET}`);
  console.log(`${fg256(75)}  │${RESET}`);
}

/**
 * Print a footer after assistant response finishes.
 * Optionally includes a right-aligned context gauge.
 * @param {object} [contextInfo] - { usedTokens, maxTokens }
 */
export function printResponseFooter(contextInfo) {
  console.log(`${fg256(75)}  │${RESET}`);

  if (contextInfo && contextInfo.usedTokens !== undefined) {
    const { usedTokens, maxTokens } = contextInfo;
    const pct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
    const color = _gaugeColor(pct);
    const char = _gaugeChar(pct);
    const usedK = usedTokens >= 1000 ? `${(usedTokens / 1000).toFixed(1)}K` : String(usedTokens);
    const maxK = maxTokens >= 1000 ? `${(maxTokens / 1000).toFixed(0)}K` : String(maxTokens);

    // Build mini arc segments
    const segments = 10;
    const filled = Math.round((pct / 100) * segments);
    let arc = "";
    for (let i = 0; i < segments; i++) {
      arc += i < filled ? `${color}━${RESET}` : `${GRAY}━${RESET}`;
    }

    const gauge = `${color}${char}${RESET} ${arc} ${color}${BOLD}${pct}%${RESET} ${DIM}${usedK}/${maxK}${RESET}`;

    // Calculate padding for right-alignment within the footer line
    const footerLine = `  └${"─".repeat(Math.min(getTermWidth() - 4, 68))}`;
    const gaugeVisLen = `${char} ${"━".repeat(segments)} ${pct}% ${usedK}/${maxK}`.length;
    const lineWidth = Math.min(getTermWidth() - 2, 70);
    const gaugePad = Math.max(0, lineWidth - gaugeVisLen - 4);

    console.log(`${fg256(75)}  └${"─".repeat(Math.min(gaugePad, 40))}${RESET} ${gauge} ${fg256(75)}${"─".repeat(Math.max(0, lineWidth - gaugePad - gaugeVisLen - 6))}╯${RESET}`);
  } else {
    console.log(`${fg256(75)}  └${"─".repeat(Math.min(getTermWidth() - 4, 68))}${RESET}`);
  }
}

/**
 * Print a turn separator between conversation turns.
 */
export function printTurnSeparator() {
  console.log("");
}

// ── Tool Call Display (Codex-style) ─────────────────────────────────────────

/**
 * Print a tool call notification with Codex-style formatting.
 */
export function printToolCall(name, args) {
  const icons = {
    Read: "📖", Write: "📝", Edit: "✏️ ", Patch: "🔨", Bash: "⚡",
    Glob: "🔍", Grep: "🔎", ListDir: "📂", Diff: "📊", Fetch: "🌐",
    ContextSearch: "🔬", SubAgent: "🤖", SubAgentTeam: "👥",
  };
  const icon = icons[name] || "🔧";

  const summary = _formatToolArgs(name, args);
  const detail = summary ? ` ${DIM}${summary}${RESET}` : "";

  console.log(`${fg256(75)}  │${RESET}`);
  console.log(`${fg256(75)}  ├─${RESET} ${fg256(214)}${icon} ${BOLD}${name}${RESET}${detail}`);
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
        ? `$ ${args.command.length > 70 ? args.command.slice(0, 70) + "..." : args.command}`
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
        ? args.task.length > 55 ? args.task.slice(0, 55) + "..." : args.task
        : "";
    case "SubAgentTeam":
      return args.tasks ? `${args.tasks.length} agent(s)` : "";
    default:
      return "";
  }
}

/**
 * Print tool result with truncation and Codex-style indentation.
 */
export function printToolResult(result, elapsedMs, truncateAt = 600) {
  let output = String(result);
  if (output.length > truncateAt) {
    output =
      output.slice(0, truncateAt) +
      `\n${DIM}... (${result.length} chars total)${RESET}`;
  }
  const lines = output.split("\n");
  for (const line of lines) {
    console.log(`${fg256(75)}  │${RESET}  ${GRAY}${line}${RESET}`);
  }
  if (elapsedMs !== undefined) {
    const sec = (elapsedMs / 1000).toFixed(1);
    console.log(`${fg256(75)}  │${RESET}  ${GRAY}(${sec}s)${RESET}`);
  }
}

/**
 * Print a warning message with yellow styling.
 */
export function printWarning(message) {
  console.log(`${YELLOW}  ⚠ ${message}${RESET}`);
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
 * Print token usage with a visual bar (compact Codex-style).
 */
export function printTokenUsage(usage) {
  const { prompt_tokens = 0, completion_tokens = 0, total_tokens = 0 } =
    usage || {};

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
    `${fg256(75)}in:${prompt_tokens}${RESET} ` +
    `${fg256(214)}out:${completion_tokens}${RESET}`;

  if (reasoningTokens > 0) {
    line += ` ${fg256(141)}think:${reasoningTokens}${RESET}`;
  }

  line += ` ${DIM}Σ${total_tokens}${RESET}`;
  console.log(line);
}

// ── Context Gauge (circular progress indicator) ──────────────────────────────

// Unicode circle characters for progress stages
const GAUGE_CHARS = ["○", "◔", "◑", "◕", "●"];

/**
 * Get the circular gauge character for a given percentage (0-100).
 */
function _gaugeChar(pct) {
  if (pct <= 5) return GAUGE_CHARS[0];
  if (pct <= 30) return GAUGE_CHARS[1];
  if (pct <= 55) return GAUGE_CHARS[2];
  if (pct <= 80) return GAUGE_CHARS[3];
  return GAUGE_CHARS[4];
}

/**
 * Get the color for a given percentage.
 */
function _gaugeColor(pct) {
  if (pct > 90) return RED;
  if (pct > 75) return YELLOW;
  if (pct > 50) return fg256(214); // orange
  return GREEN;
}

/**
 * Render a compact context gauge string for display.
 * Shows: ◑ 45% 58K/128K
 * @param {number} usedTokens - Current token count
 * @param {number} maxTokens - Maximum context tokens
 * @returns {string} Formatted gauge string
 */
export function renderContextGauge(usedTokens, maxTokens) {
  const pct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  const color = _gaugeColor(pct);
  const char = _gaugeChar(pct);
  const usedK = usedTokens >= 1000 ? `${(usedTokens / 1000).toFixed(0)}K` : String(usedTokens);
  const maxK = maxTokens >= 1000 ? `${(maxTokens / 1000).toFixed(0)}K` : String(maxTokens);

  return `${color}${BOLD}${char}${RESET} ${color}${pct}%${RESET} ${DIM}${usedK}/${maxK}${RESET}`;
}

/**
 * Render a right-aligned context gauge line.
 * Places the gauge at the right edge of the terminal.
 * @param {number} usedTokens - Current token count
 * @param {number} maxTokens - Maximum context tokens
 */
export function printContextGauge(usedTokens, maxTokens) {
  const pct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  const color = _gaugeColor(pct);
  const char = _gaugeChar(pct);
  const usedK = usedTokens >= 1000 ? `${(usedTokens / 1000).toFixed(1)}K` : String(usedTokens);
  const maxK = maxTokens >= 1000 ? `${(maxTokens / 1000).toFixed(0)}K` : String(maxTokens);

  // Build mini progress arc with 8 segments
  const segments = 8;
  const filled = Math.round((pct / 100) * segments);
  let arc = "";
  for (let i = 0; i < segments; i++) {
    if (i < filled) {
      arc += `${color}▮${RESET}`;
    } else {
      arc += `${GRAY}▯${RESET}`;
    }
  }

  // Gauge text
  const gaugeText = `${color}${BOLD}${char}${RESET} ${arc} ${color}${BOLD}${pct}%${RESET} ${DIM}(${usedK} / ${maxK} tokens)${RESET}`;

  // Calculate visible length for right alignment
  const visibleLen = `${char} ${"▮".repeat(filled)}${"▯".repeat(segments - filled)} ${pct}% (${usedK} / ${maxK} tokens)`.length;
  const w = getTermWidth();
  const padLeft = Math.max(0, w - visibleLen - 2);

  console.log(`${" ".repeat(padLeft)}${gaugeText}`);
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
 */
export function printRollbackUI(checkpoints, selectedIndex) {
  process.stdout.write(`${ESC}2J${ESC}H`);

  console.log("");
  console.log(`${BOLD}${fg256(214)}  ╭─ Rollback Mode ────────────────────────────────────╮${RESET}`);
  console.log(`${GRAY}  │ Use ↑↓ to select checkpoint, Enter to confirm, ESC │${RESET}`);
  console.log(`${fg256(214)}  ├───────────────────────────────────────────────────────┤${RESET}`);

  if (checkpoints.length === 0) {
    console.log(`${GRAY}  │   (No checkpoints available)                         │${RESET}`);
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
 */
export function printRollbackConfirm(checkpoint, selectedOption) {
  process.stdout.write(`${ESC}2J${ESC}H`);

  console.log("");
  console.log(`${BOLD}${fg256(214)}  ╭─ Confirm Rollback ─────────────────────────────────╮${RESET}`);
  console.log(`${GRAY}  │ Target: "${checkpoint.userMessage.slice(0, 40)}..."${RESET}`);
  console.log(`${fg256(214)}  ├───────────────────────────────────────────────────────┤${RESET}`);

  const options = [
    ["Full Rollback", "Restore all file changes + conversation to this checkpoint"],
    ["Context Only", "Keep files unchanged, only rollback conversation state"],
    ["Cancel", "Go back, do nothing"],
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
 */
export function printSessionList(sessions) {
  if (sessions.length === 0) {
    printInfo("No saved sessions. Use /history save to save current session.");
    return;
  }

  console.log("");
  console.log(`${BOLD}${fg256(87)}  ╭─ Session History ──────────────────────────────────╮${RESET}`);

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
  console.log(`  ${DIM}Use /history restore <number> to restore a session${RESET}`);
  console.log("");
}

// ── Spinner (with elapsed time) ──────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const spinner = {
  _interval: null,
  _frameIndex: 0,
  _startTime: 0,

  start(text = "Thinking...") {
    if (this._interval) return;
    this._frameIndex = 0;
    this._startTime = Date.now();
    process.stdout.write("\x1b[?25l"); // hide cursor
    this._interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this._frameIndex % SPINNER_FRAMES.length];
      const color = BRAND[this._frameIndex % BRAND.length];
      const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(1);
      process.stdout.write(
        `\r${fg256(75)}  │${RESET} ${color}${frame}${RESET} ${DIM}${text}${RESET} ${GRAY}${elapsed}s${RESET}\x1b[K`
      );
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

// ── Agent Panel Manager ─────────────────────────────────────────────────────
// Shows live windows for each sub-agent during SubAgentTeam execution.
// Each agent gets a bordered panel showing status and latest activity.

const PANEL_SPINNER = ["◐", "◓", "◑", "◒"];

export class AgentPanelManager {
  constructor(count) {
    this.panels = [];
    this._spinnerFrame = 0;
    this._interval = null;
    this._drawn = false;

    for (let i = 0; i < count; i++) {
      this.panels.push({
        task: "",
        status: "waiting",    // waiting | thinking | tool | compress | done | error
        statusText: "Initializing...",
        lastTool: "",
        done: false,
        success: false,
        turns: 0,
        startTime: Date.now(),
      });
    }
  }

  /**
   * Initialize panels with task descriptions and draw them.
   */
  init(tasks) {
    for (let i = 0; i < this.panels.length && i < tasks.length; i++) {
      const task = typeof tasks[i] === "string" ? tasks[i] : tasks[i].task;
      this.panels[i].task = task;
    }

    process.stdout.write("\x1b[?25l"); // hide cursor
    console.log("");
    this._draw();
    this._drawn = true;

    // Animate spinner at 120ms interval
    this._interval = setInterval(() => {
      this._spinnerFrame++;
      if (this._drawn) this._redraw();
    }, 120);
  }

  /**
   * Update a panel's status.
   */
  update(index, event, detail) {
    if (index < 0 || index >= this.panels.length) return;
    const panel = this.panels[index];
    if (panel.done) return;

    switch (event) {
      case "thinking":
        panel.status = "thinking";
        panel.turns++;
        panel.statusText = `Thinking... (Turn ${panel.turns})`;
        break;
      case "tool_call":
        panel.status = "tool";
        panel.statusText = detail || "Executing tool...";
        panel.lastTool = detail || "";
        break;
      case "tool_result":
        panel.statusText = detail || "Processing result...";
        break;
      case "compressing":
        panel.status = "compress";
        panel.statusText = "Compressing context...";
        break;
    }
  }

  /**
   * Mark a panel as finished.
   */
  finish(index, success, summary) {
    if (index < 0 || index >= this.panels.length) return;
    const panel = this.panels[index];
    panel.done = true;
    panel.success = success;
    const elapsed = ((Date.now() - panel.startTime) / 1000).toFixed(1);
    if (success) {
      const chars = summary ? summary.length : 0;
      panel.statusText = `Done (${panel.turns} turns, ${elapsed}s)`;
      panel.lastTool = chars > 0 ? `Result: ${chars} chars` : "";
    } else {
      panel.statusText = `Error (${elapsed}s)`;
      panel.lastTool = summary ? summary.slice(0, 60) : "";
    }
  }

  /**
   * Clean up: stop animation, clear panel area from terminal.
   */
  cleanup() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    if (this._drawn) {
      const totalLines = this._getTotalLines();
      // Move cursor up and clear each line
      process.stdout.write(`\x1b[${totalLines}A`);
      for (let i = 0; i < totalLines; i++) {
        process.stdout.write("\x1b[2K\n");
      }
      // Move back up to where panels started
      process.stdout.write(`\x1b[${totalLines}A`);
      this._drawn = false;
    }

    process.stdout.write("\x1b[?25h"); // show cursor
  }

  // Lines per panel: top border + status + activity + bottom border = 4
  _getTotalLines() {
    return this.panels.length * 4;
  }

  _draw() {
    const w = Math.min(getTermWidth() - 2, 76);
    const output = [];

    for (let i = 0; i < this.panels.length; i++) {
      output.push(...this._renderPanel(i, w));
    }

    process.stdout.write(output.join("\n") + "\n");
  }

  _redraw() {
    const totalLines = this._getTotalLines();
    process.stdout.write(`\x1b[${totalLines}A`);
    this._draw();
  }

  _renderPanel(index, width) {
    const panel = this.panels[index];
    const inner = width - 4; // borders + padding

    // Determine colors
    let borderColor, statusIcon;
    if (panel.done) {
      if (panel.success) {
        borderColor = GREEN;
        statusIcon = `${GREEN}${BOLD}✓${RESET}`;
      } else {
        borderColor = RED;
        statusIcon = `${RED}${BOLD}✗${RESET}`;
      }
    } else {
      borderColor = fg256(75);
      const frame = PANEL_SPINNER[this._spinnerFrame % PANEL_SPINNER.length];
      const color = BRAND[this._spinnerFrame % BRAND.length];
      statusIcon = `${color}${BOLD}${frame}${RESET}`;
    }

    // Header line
    const taskLabel =
      panel.task.length > inner - 14
        ? panel.task.slice(0, inner - 17) + "..."
        : panel.task;
    const headerContent = `Agent ${index + 1}: ${taskLabel}`;
    const headerPad = Math.max(0, width - headerContent.length - 4);
    const header =
      `${borderColor}╭─ ${BOLD}${headerContent}${RESET}${borderColor} ${"─".repeat(headerPad)}╮${RESET}`;

    // Status line
    const statusText =
      panel.statusText.length > inner - 2
        ? panel.statusText.slice(0, inner - 5) + "..."
        : panel.statusText;
    // Calculate visible length (without ANSI codes) for padding
    const statusPad = Math.max(0, inner - _visLen(statusText) - 2);
    const status =
      `${borderColor}│${RESET} ${statusIcon} ${statusText}${" ".repeat(statusPad)}${borderColor}│${RESET}`;

    // Activity line
    const actText = panel.lastTool
      ? panel.lastTool.length > inner - 2
        ? panel.lastTool.slice(0, inner - 5) + "..."
        : panel.lastTool
      : "";
    const actPad = Math.max(0, inner - actText.length);
    const activity =
      `${borderColor}│${RESET}  ${DIM}${actText}${RESET}${" ".repeat(actPad)}${borderColor}│${RESET}`;

    // Footer line
    const footer = `${borderColor}╰${"─".repeat(width - 2)}╯${RESET}`;

    return [header, status, activity, footer];
  }
}

// Estimate visible string length (strip ANSI codes)
function _visLen(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}
