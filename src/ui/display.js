// Terminal display/rendering module for Mercury Code CLI
// Uses only Node.js built-in modules with ANSI escape codes for colors

// ── Color Constants ──────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const WHITE = "\x1b[37m";

// ── Display Functions ────────────────────────────────────────────────────────

/**
 * Print a welcome banner in cyan followed by a usage hint.
 */
export function printWelcome() {
  console.log(
    `${CYAN}${BOLD}` +
      `\n╔══════════════════════════════════════╗` +
      `\n║         Mercury Code v1.0.0          ║` +
      `\n║   Powered by Mercury-2 Diffusion     ║` +
      `\n╚══════════════════════════════════════╝${RESET}\n`
  );
  console.log(
    `${WHITE}Type your message to get started. Use /help for commands.${RESET}\n`
  );
}

/**
 * Print the list of available slash commands.
 */
export function printHelp() {
  console.log(`\n${CYAN}${BOLD}Available Commands:${RESET}`);
  console.log(`  ${GREEN}/help${RESET}        - Show this help message`);
  console.log(`  ${GREEN}/clear${RESET}       - Clear conversation`);
  console.log(`  ${GREEN}/config${RESET}      - Show current config`);
  console.log(`  ${GREEN}/exit${RESET} or ${DIM}Ctrl+C${RESET} - Exit\n`);
}

/**
 * Print assistant response text in white.
 * @param {string} text
 */
export function printAssistantText(text) {
  console.log(`\n${WHITE}${text}${RESET}\n`);
}

/**
 * Print a tool call notification in yellow.
 * @param {string} name  - tool name
 * @param {object} args  - tool arguments
 */
export function printToolCall(name, args) {
  const argsStr = JSON.stringify(args, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
  console.log(`\n${YELLOW}${BOLD}\u26A1 Tool: ${name}${RESET} ${YELLOW}${argsStr}${RESET}`);
}

/**
 * Print a tool result in dim/gray, truncating if it exceeds the limit.
 * @param {string} result
 * @param {number} [truncateAt=500]
 */
export function printToolResult(result, truncateAt = 500) {
  let output = String(result);
  if (output.length > truncateAt) {
    output = output.slice(0, truncateAt) + `... (truncated, ${result.length} chars total)`;
  }
  console.log(`${DIM}${output}${RESET}\n`);
}

/**
 * Print an error message in red with a cross prefix.
 * @param {string} message
 */
export function printError(message) {
  console.error(`${RED}${BOLD}\u2717 ${message}${RESET}`);
}

/**
 * Print an informational message in blue with an info prefix.
 * @param {string} message
 */
export function printInfo(message) {
  console.log(`${BLUE}\u2139 ${message}${RESET}`);
}

/**
 * Print token usage statistics in dim text.
 * @param {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} usage
 */
export function printTokenUsage(usage) {
  const { prompt_tokens = 0, completion_tokens = 0, total_tokens = 0 } = usage || {};
  console.log(
    `${DIM}Tokens — prompt: ${prompt_tokens}, completion: ${completion_tokens}, total: ${total_tokens}${RESET}`
  );
}

/**
 * Write a text chunk to stdout without a trailing newline (for streaming).
 * @param {string} text
 */
export function printStreamChunk(text) {
  process.stdout.write(text);
}

/**
 * Write a newline to stdout after a stream completes.
 */
export function printStreamEnd() {
  process.stdout.write("\n");
}

// ── Spinner ──────────────────────────────────────────────────────────────────

/**
 * A simple animated terminal spinner.
 *
 *   spinner.start("Loading...");
 *   // ... async work ...
 *   spinner.stop();
 */
export const spinner = {
  _interval: null,
  _frameIndex: 0,
  _frames: ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"],

  /**
   * Start the spinner with an optional status message.
   * @param {string} [text=""]
   */
  start(text = "") {
    if (this._interval) {
      return; // already running
    }
    this._frameIndex = 0;
    process.stdout.write("\x1b[?25l"); // hide cursor
    this._interval = setInterval(() => {
      const frame = this._frames[this._frameIndex % this._frames.length];
      process.stdout.write(`\r${CYAN}${frame}${RESET} ${text}`);
      this._frameIndex++;
    }, 80);
  },

  /**
   * Stop the spinner and clear the line.
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    process.stdout.write("\r\x1b[K"); // clear the line
    process.stdout.write("\x1b[?25h"); // show cursor
  },
};
