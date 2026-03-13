// Mercury Code - Terminal Display Module
// Mercury-themed terminal UI with agent panel system
// ☿ Mercury — Silver, blue-teal, cyan palette

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { ESC, RESET, BOLD, DIM, ITALIC, RED, GREEN, YELLOW, BLUE, MAGENTA, WHITE, GRAY } from "../utils/colors.js";

// Re-export autocomplete widget for use by REPL
export { AutocompleteWidget } from "./autocomplete.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8")
).version;

// ── ANSI Escape Codes (extended, not covered by shared colors.js) ────────────

const UNDERLINE = `${ESC}4m`;

// Standard cyan (differs from the 256-color CYAN in colors.js)
const CYAN = `${ESC}36m`;

// True color (24-bit RGB) Mercury palette
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
const MERCURY_SILVER = rgb(192, 203, 215);   // Silver — the mercury metal
const MERCURY_BLUE = rgb(86, 156, 214);      // Deep blue — Mercury's night sky
const MERCURY_TEAL = rgb(78, 201, 176);      // Teal — core accent
const MERCURY_CYAN = rgb(156, 220, 254);     // Light cyan — highlights
const MERCURY_AMBER = rgb(206, 145, 120);    // Warm amber — accent

// 256-color palette for gradients
const fg256 = (n) => `${ESC}38;5;${n}m`;
const bg256 = (n) => `${ESC}48;5;${n}m`;

// Mercury brand gradient colors (teal → cyan → white)
const BRAND = [fg256(30), fg256(37), fg256(44), fg256(51), fg256(87), fg256(123)];

// Terminal width helper
function getTermWidth() {
  return process.stdout.columns || 80;
}

// ── Mercury Planet Art with Starfield ─────────────────────────────────────────
// Realistic Mercury colors: gray-brown rocky surface with impact craters
// Stars twinkle in deep space. Planet "appears" with an animation.

// True-color planet surface palette (realistic Mercury: gray/brown/tan rock)
const P_BRIGHT = rgb(195, 185, 170);   // Sunlit highlands
const P_LIGHT  = rgb(170, 162, 148);   // Light terrain
const P_MID    = rgb(145, 138, 125);   // Mid-tone surface
const P_DARK   = rgb(115, 108, 98);    // Shadowed terrain
const P_SHADOW = rgb(80, 75, 68);      // Deep shadow
const P_CRATER = rgb(100, 95, 85);     // Crater interior
const P_RIM    = rgb(165, 155, 140);   // Crater rim (bright)
const P_EDGE   = rgb(60, 56, 50);      // Terminator / limb darkening

// Space and stars
const STAR_DIM    = rgb(90, 95, 120);    // Faint distant stars
const STAR_MED    = rgb(160, 165, 195);  // Medium stars
const STAR_BRIGHT = rgb(230, 235, 255);  // Bright stars
const STAR_WARM   = rgb(255, 220, 180);  // Warm-tinted star
const SPACE_FG    = rgb(15, 18, 30);     // Deep space

// The Mercury scene — large planet filling the frame, with MERCURY text
// overlaid ON TOP of the planet. Stars scattered across the deep space background.
// The text appears to float in front of the planet surface.
const MERCURY_SCENE = [
  " .    ·     ✦   .  ·    ✧       ✦    .  ·    *    .   ✦    ·     .   ",
  "   ✧     .       ·    ✦     .       ·    ✦   .    ·       ✧    .     ",
  "  .  ·  ✦           ▄▄▄▓████████████▓▄▄▄          ✦  .  ·    ✧  .   ",
  "    .        ▄▄▓█████▓▒░░░░░░░░░░░░░░▒▓█████▓▄▄        ·      .     ",
  " ·  ✦    ▄▓███▒░░░░░░▒▓▒░░░░░░░░░░▓▒░░░░░░▒███▓▄   ✦     ·    ✧   ",
  "  .    ▄██▓░░░░░▒▓███▓░░░░░▒▓▓▒░░░░░▓███▓▒░░░░░▓██▄   .    ✦  .    ",
  "  ·  ▄██▒░░░▒▓██▓░░░░░░░░░░░░░░░░░░░░░░░▓██▓▒░░░▒██▄  ·     .     ",
  " . ▄██░░░▒███▒░░░░ ███╗   ███╗ ███████╗ ░░░▒███▒░░░██▄ .  ✦   ·   ",
  "  ▄██░░░▓██▒░░░░░░ ████╗ ████║ ██╔════╝ ░░░░▒██▓░░░░██▄     .     ",
  " ███░░░██▓░░░░░▒▓░ ██╔████╔██║ █████╗   ░▒░░░░▓██░░░███  ✦   ·    ",
  " ███░░░░░░░░░▒██▒░ ██║╚██╔╝██║ ██╔══╝   ░▒██░░░░░░░░███     .     ",
  " ███░░▒▓░░░░██▓░░░ ██║ ╚═╝ ██║ ███████╗ ░░░▓██░░░░▓▒░███  ·   ✧  ",
  " ███░░██▓░░░░░░░░░ ╚═╝     ╚═╝ ╚══════╝ ░░░░░░░▓██░░███     .     ",
  "  ▀██░░▒██▓░░░░░░ ██████╗  ██████╗  ██████╗ ░░░▓██▒░░██▀  ✦   ·   ",
  "  . ▀██░░░▒██▒░░░ ██╔════╝██╔═══██╗██╔══██╗ ░▒██▒░░░██▀ .   ✧     ",
  "   · ▀██▒░░░▓██░░ ██║     ██║   ██║██║  ██║ ░██▓░░░▒██▀  ·    .   ",
  "   .  ▀██▓░░░░▒█░ ╚██████╗╚██████╔╝██████╔╝ ░█▒░░░▓██▀  .  ✦      ",
  "  ·  ✦  ▀███▓░░░░ .╚═════╝ ╚═════╝ ╚═════╝. ░░░▓███▀ ✦  ·    .   ",
  "    .      ▀▓████▓▒░░░░░░░░░░░░░░░░░░░░▒▓████▓▀      .   ✧    ·   ",
  "  ·  ✧  .     ▀▀▓█████▓▓▒░░░░░░░░▒▓▓█████▓▀▀    .  ✦  ·     .     ",
  "    .   ✦    ·       ▀▀▀▓████████████▓▀▀▀      ·       ✦    .  ✧   ",
  "   ✧     .       ·    ✦     .       ·    ✦   .    ·       ✧    .     ",
  " .    ·     ✦   .  ·    ✧       ✦    .  ·    *    .   ✦    ·     .   ",
];

// Compact version for narrow terminals
const MERCURY_COMPACT = [
  "     ·  ✦  .  ·  ✦  ·  .  ✦  ·    ",
  " ✦  .  ▄▓██████████▓▄  .  ✦  ·   ",
  "·  . ▄██▒░░░░░░░░░░▒██▄ .  ✦     ",
  " ✦  ██░░ ╔╦╗╔═╗╦═╗ ░░██  .  ·   ",
  " .  ██░░ ║║║║╣ ╠╦╝ ░░░██ ·  ✦   ",
  "·   ██░░ ╩ ╩╚═╝╩╚═ ░░░██  .  ·  ",
  " ✦   ██▒░░░░░░░░░░░▒██  ✦ .  ·  ",
  "·  .  ▀██▒░░░░░░░▒██▀  .  ·  ✦  ",
  " ✦   .  ▀▓████████▓▀  ·  .  ✦   ",
  "     ·  ✦  .  ·  ✦  ·  .  ✦  ·   ",
];

// Block letter characters used in MERCURY CODE text (box drawing + block chars)
const TEXT_CHARS = new Set("╗╔║╚╝╠╣╩╦╬═─".split(""));

/**
 * Colorize a Mercury scene character with realistic planet/space colors.
 * Block text characters (MERCURY CODE) get bright cyan glow to stand out.
 * Planet surface uses realistic gray/brown Mercury tones.
 */
function _colorizeChar(ch, colInLine) {
  switch (ch) {
    // Stars
    case "✦": return `${STAR_BRIGHT}${BOLD}✦${RESET}`;
    case "✧": return `${STAR_WARM}✧${RESET}`;
    case "*": return `${STAR_MED}*${RESET}`;
    case "·": return `${STAR_DIM}·${RESET}`;
    case ".": return `${rgb(45, 48, 65)}.${RESET}`;
    // Planet surface — brightness depends on block character
    case "█": return `${P_BRIGHT}█${RESET}`;
    case "▓": return `${P_LIGHT}▓${RESET}`;
    case "▒": return `${P_MID}▒${RESET}`;
    case "░": return `${P_DARK}░${RESET}`;
    // Planet edge/transition chars
    case "▄": return `${P_EDGE}▄${RESET}`;
    case "▀": return `${P_EDGE}▀${RESET}`;
    // Space
    case " ": return " ";
    default:
      // Block text characters (MERCURY CODE) — bright cyan glow
      if (TEXT_CHARS.has(ch)) {
        return `${MERCURY_CYAN}${BOLD}${ch}${RESET}`;
      }
      return `${P_SHADOW}${ch}${RESET}`;
  }
}

/**
 * Colorize an entire scene line.
 */
function _colorizeSceneLine(line) {
  let result = "";
  let col = 0;
  for (const ch of line) {
    result += _colorizeChar(ch, col++);
  }
  return result;
}

// Platform detection for display
function getPlatformInfo() {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "macOS (Apple Silicon)" : "macOS (Intel)";
  if (p === "win32") return `Windows (${a})`;
  return `Linux (${a})`;
}

// Classic text logo — MERCURY CODE on a starfield background
// Each row is: [starfield_bg, text_overlay]
// Stars use ·✦✧.* characters, text uses block letters
const MERCURY_TEXT_SCENE = [
  " .    ·     ✦   .  ·    ✧       ✦    .  ·    *    .   ✦    ·     .   ",
  "   ✧     .       ·    ✦     .       ·    ✦   .    ·       ✧    .     ",
  " ·  ✦ ███╗   ███╗ ███████╗ ██████╗   ██████╗ ██╗   ██╗ ██████╗  ██╗   ██╗",
  "  .   ████╗ ████║ ██╔════╝ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ╚██╗ ██╔╝",
  " ✧  · ██╔████╔██║ █████╗   ██████╔╝ ██║  ✦   ██║   ██║ ██████╔╝  ╚████╔╝ ",
  "  ✦   ██║╚██╔╝██║ ██╔══╝   ██╔══██╗ ██║      ██║   ██║ ██╔══██╗   ╚██╔╝  ",
  "    . ██║ ╚═╝ ██║ ███████╗ ██║  ██║ ╚██████╗ ╚██████╔╝ ██║  ██║    ██║   ",
  " ·  ✧ ╚═╝     ╚═╝ ╚══════╝ ╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═╝  ╚═╝    ╚═╝   ",
  "    .      ·   ✦     .  ·     ✧   .    ✦  ·     .    ✧   ✦  .  ·     ",
  " ✦    ·  ██████╗  ██████╗  ██████╗  ███████╗ ✧     .   ·     ✦   .   ",
  "  .  ·  ██╔════╝ ██╔═══██╗██╔══██╗ ██╔════╝   ✦  .     ·    ✧    ·  ",
  " ✧  ✦   ██║      ██║   ██║██║  ██║ █████╗  .       ·    ✦     .     ",
  "  ·   .  ██║  ✧   ██║   ██║██║  ██║ ██╔══╝    ·  ✦   .    ·    ✧    ",
  " .  ✦    ╚██████╗ ╚██████╔╝██████╔╝ ███████╗    .     ✦  ·     .    ",
  "   ·   ✧  ╚═════╝  ╚═════╝ ╚═════╝  ╚══════╝  ·    ✧     .   ✦  ·  ",
  "   ✧     .       ·    ✦     .       ·    ✦   .    ·       ✧    .     ",
  " .    ·     ✦   .  ·    ✧       ✦    .  ·    *    .   ✦    ·     .   ",
];

// Shooting star frames — a meteor streaks across the starfield
const SHOOTING_STAR_FRAMES = [
  { row: 0, cols: [65, 64, 63], ch: "━─·" },
  { row: 1, cols: [60, 59, 58], ch: "━─·" },
  { row: 1, cols: [55, 54, 53], ch: "━─·" },
];

// ── Display Functions ────────────────────────────────────────────────────────

/**
 * Print the welcome banner.
 * @param {object} [options]
 * @param {boolean} [options.showPlanet=false] - Show Mercury planet scene (true = planet, false = classic text logo)
 */
export async function printWelcome(options = {}) {
  const showPlanet = options.showPlanet === true;
  const w = getTermWidth();
  const sep = "─".repeat(Math.min(w - 4, 68));

  if (showPlanet) {
    await _printPlanetWelcome(w, sep);
  } else {
    await _printClassicWelcome(w, sep);
  }
}

/**
 * Planet mode: Mercury planet with starfield, animated emergence.
 */
async function _printPlanetWelcome(w, sep) {
  const useCompact = w < 76;
  const scene = useCompact ? MERCURY_COMPACT : MERCURY_SCENE;
  const totalLines = scene.length;

  // Hide cursor during animation
  process.stdout.write("\x1b[?25l");
  console.log("");

  // ── Phase 1: Stars fade in (quick twinkle) ──
  const starFrame = scene.map((line) =>
    [...line].map((ch) => {
      if ("█▓▒░▄▀".includes(ch)) return " ";
      if (TEXT_CHARS.has(ch)) return " ";
      return ch;
    }).join("")
  );

  for (let i = 0; i < totalLines; i++) {
    console.log(`  ${_colorizeSceneLine(starFrame[i])}`);
  }
  await _sleep(200);

  // ── Phase 2: Planet emerges from center outward ──
  const centerRow = Math.floor(totalLines / 2);

  for (let radius = 0; radius <= centerRow; radius++) {
    const rowsToReveal = new Set();
    for (let i = 0; i < totalLines; i++) {
      if (Math.abs(i - centerRow) <= radius) rowsToReveal.add(i);
    }

    process.stdout.write(`\x1b[${totalLines}A`);
    for (let i = 0; i < totalLines; i++) {
      const line = rowsToReveal.has(i) ? scene[i] : starFrame[i];
      process.stdout.write(`  ${_colorizeSceneLine(line)}\x1b[K\n`);
    }
    await _sleep(45);
  }

  await _sleep(120);
  _printTitleBar(sep);
  process.stdout.write("\x1b[?25h");
}

/**
 * Classic mode: MERCURY CODE text on starfield, with shooting star & gradient reveal.
 */
async function _printClassicWelcome(w, sep) {
  const useCompact = w < 72;
  process.stdout.write("\x1b[?25l");
  console.log("");

  if (useCompact) {
    // Simple compact header for narrow terminals
    console.log(`${BOLD}${MERCURY_CYAN}  ☿ M E R C U R Y   C O D E${RESET}`);
    console.log("");
    _printTitleBar(sep);
    process.stdout.write("\x1b[?25h");
    return;
  }

  const scene = MERCURY_TEXT_SCENE;
  const totalLines = scene.length;

  // ── Phase 1: Stars appear first (text hidden) ──
  const starOnly = scene.map((line) =>
    [...line].map((ch) => {
      if (TEXT_CHARS.has(ch) || "█".includes(ch)) return " ";
      return ch;
    }).join("")
  );

  for (let i = 0; i < totalLines; i++) {
    console.log(`  ${_colorizeSceneLine(starOnly[i])}`);
  }
  await _sleep(250);

  // ── Phase 2: Shooting star animation (streaks across top rows) ──
  const meteorLine = " .    ·     ✦   .  ·    ✧       ✦    .  ·    *    .   ✦    ·     .   ";
  for (const frame of SHOOTING_STAR_FRAMES) {
    const starChars = [...meteorLine];
    for (let j = 0; j < frame.cols.length && j < frame.ch.length; j++) {
      const col = frame.cols[j];
      if (col >= 0 && col < starChars.length) {
        starChars[col] = frame.ch[j];
      }
    }
    const meteorStr = starChars.join("");
    // Overwrite just the target row
    process.stdout.write(`\x1b[${totalLines - frame.row}A`);
    process.stdout.write(`  ${_colorizeMeteorLine(meteorStr)}\x1b[K`);
    process.stdout.write(`\x1b[${totalLines - frame.row}B\r`);
    await _sleep(60);
  }

  await _sleep(100);

  // ── Phase 3: Text reveals line by line with gradient colors ──
  for (let i = 0; i < totalLines; i++) {
    const hasText = scene[i].match(/[█╗╔║╚╝╠╣╩╦╬═]/);
    if (hasText) {
      // Move to this line and overwrite with full colored version
      process.stdout.write(`\x1b[${totalLines - i}A`);
      // Color the text characters with gradient, stars stay dim
      const colored = _colorizeTextSceneLine(scene[i], i);
      process.stdout.write(`  ${colored}\x1b[K`);
      process.stdout.write(`\x1b[${totalLines - i}B\r`);
      await _sleep(35);
    }
  }

  await _sleep(100);
  _printTitleBar(sep);
  process.stdout.write("\x1b[?25h");
}

/**
 * Colorize a scene line where MERCURY CODE text gets a gradient teal-cyan glow
 * and stars stay their dim space colors.
 */
function _colorizeTextSceneLine(line, rowIdx) {
  // Pick a gradient color based on row index
  const textColor = BRAND[rowIdx % BRAND.length];
  let result = "";
  for (const ch of line) {
    if (TEXT_CHARS.has(ch) || "█".includes(ch)) {
      result += `${textColor}${BOLD}${ch}${RESET}`;
    } else {
      result += _colorizeChar(ch, 0);
    }
  }
  return result;
}

/**
 * Colorize a meteor line — the shooting star chars (━─) get bright white glow.
 */
function _colorizeMeteorLine(line) {
  let result = "";
  for (const ch of line) {
    if (ch === "━") {
      result += `${STAR_BRIGHT}${BOLD}━${RESET}`;
    } else if (ch === "─") {
      result += `${STAR_MED}─${RESET}`;
    } else {
      result += _colorizeChar(ch, 0);
    }
  }
  return result;
}

/**
 * Print the shared title/info bar below the logo/planet.
 */
function _printTitleBar(sep) {
  console.log("");
  console.log(`${MERCURY_TEAL}  ${sep}${RESET}`);
  console.log(
    `${BOLD}${MERCURY_CYAN}  ☿ Mercury Code${RESET} ${DIM}v${PKG_VERSION}${RESET}  ${GRAY}│${RESET}  ${DIM}Powered by Mercury-2 Diffusion Model${RESET}`
  );
  console.log(
    `${DIM}  Inception Labs${RESET}         ${GRAY}│${RESET}  ${DIM}${getPlatformInfo()} • Node ${process.versions.node}${RESET}`
  );
  console.log(
    `${DIM}  ${GRAY}Start with a request, or open ${RESET}${MERCURY_CYAN}/help${RESET}${DIM}${GRAY} for commands.${RESET}`
  );
  console.log(
    `${DIM}  ${GRAY}Shortcuts:${RESET} ${DIM}ESC×3${RESET} ${GRAY}rollback${RESET}  ${DIM}Ctrl+J${RESET} ${GRAY}multiline${RESET}  ${DIM}Ctrl+C${RESET} ${GRAY}interrupt${RESET}  ${DIM}Tab${RESET} ${GRAY}complete${RESET}`
  );
  console.log(`${MERCURY_TEAL}  ${sep}${RESET}`);
  console.log("");
}

/**
 * Print Plan mode banner (shown when --plan or /trust plan is active).
 */
export function printPlanModeBanner() {
  const w = getTermWidth();
  const inner = Math.min(w - 4, 68);
  console.log("");
  console.log(`${BOLD}${MERCURY_AMBER}  ╭─ Plan Mode ${"─".repeat(Math.max(0, inner - 13))}╮${RESET}`);
  console.log(`${GRAY}  │${RESET}  ${MERCURY_AMBER}☿${RESET} ${BOLD}Read-only analysis mode${RESET}`);
  console.log(`${GRAY}  │${RESET}  ${DIM}Mercury will create a plan file for your review.${RESET}`);
  console.log(`${GRAY}  │${RESET}  ${DIM}No files will be modified. Use /trust approval to switch.${RESET}`);
  console.log(`${BOLD}${MERCURY_AMBER}  ╰${"─".repeat(inner)}╯${RESET}`);
  console.log("");
}

/**
 * Print MCP server connection status.
 * @param {Array<{name: string, ready: boolean, tools: number, transport: string}>} servers
 */
export function printMcpStatus(servers) {
  if (!servers || servers.length === 0) return;

  const w = getTermWidth();
  const inner = Math.min(w - 4, 68);
  console.log(`${BOLD}${fg256(87)}  ╭─ MCP Servers ${"─".repeat(Math.max(0, inner - 15))}╮${RESET}`);
  for (const s of servers) {
    const icon = s.ready ? `${GREEN}●${RESET}` : `${RED}○${RESET}`;
    const toolCount = s.ready ? `${DIM}${s.tools} tool${s.tools !== 1 ? "s" : ""}${RESET}` : `${RED}not connected${RESET}`;
    console.log(`${GRAY}  │${RESET}  ${icon} ${BOLD}${s.name}${RESET} ${GRAY}(${s.transport})${RESET}  ${toolCount}`);
  }
  console.log(`${BOLD}${fg256(87)}  ╰${"─".repeat(inner)}╯${RESET}`);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Easter Egg: MERCURY COLD ─────────────────────────────────────────────────
// Triggered by double-tap Enter on empty prompt → editable logo → type "cold"
// 谐音梗 (homophone pun): "code" → "cold" — Mercury's night side is −180 °C!

const ICE_BLUE     = rgb(140, 200, 255);
const ICE_BRIGHT   = rgb(200, 235, 255);
const ICE_WHITE    = rgb(230, 245, 255);
const FROST_DIM    = rgb(80, 130, 180);

/**
 * Show the editable logo prompt with a blinking cursor on "CODE".
 * Returns a readline interface for capturing the user's replacement text.
 */
export function printEditableLogo() {
  const w = getTermWidth();
  const E = "\x1b[";

  console.log("");
  console.log(`${MERCURY_TEAL}  ╭─ Logo Edit Mode ─────────────────────────────────────╮${RESET}`);
  console.log(`${GRAY}  │${RESET}  ${DIM}The logo text is now editable. Type a replacement.${RESET}`);
  console.log(`${GRAY}  │${RESET}  ${MERCURY_CYAN}${BOLD}  ☿ MERCURY ${RESET}${ICE_BLUE}${BOLD}▊${RESET}${DIM} ← type here${RESET}`);
  console.log(`${MERCURY_TEAL}  ╰─────────────────────────────────────────────────────╯${RESET}`);
  console.log("");
}

/**
 * Play the MERCURY COLD easter egg animation.
 * Shows the text freezing over with ice crystals and a fun message.
 */
export async function playMercuryColdEasterEgg() {
  process.stdout.write("\x1b[?25l"); // hide cursor
  console.log("");

  // Phase 1: "MERCURY COLD" title with frost effect
  const coldText = [
    " ███╗   ███╗ ███████╗ ██████╗   ██████╗ ██╗   ██╗ ██████╗  ██╗   ██╗",
    " ████╗ ████║ ██╔════╝ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ╚██╗ ██╔╝",
    " ██╔████╔██║ █████╗   ██████╔╝ ██║      ██║   ██║ ██████╔╝  ╚████╔╝ ",
    " ██║╚██╔╝██║ ██╔══╝   ██╔══██╗ ██║      ██║   ██║ ██╔══██╗   ╚██╔╝  ",
    " ██║ ╚═╝ ██║ ███████╗ ██║  ██║ ╚██████╗ ╚██████╔╝ ██║  ██║    ██║   ",
    " ╚═╝     ╚═╝ ╚══════╝ ╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═╝  ╚═╝    ╚═╝   ",
    "",
    "  ██████╗  ██████╗  ██╗     ██████╗ ",
    " ██╔════╝ ██╔═══██╗ ██║     ██╔══██╗",
    " ██║      ██║   ██║ ██║     ██║  ██║",
    " ██║      ██║   ██║ ██║     ██║  ██║",
    " ╚██████╗ ╚██████╔╝ ███████╗██████╔╝",
    "  ╚═════╝  ╚═════╝  ╚══════╝╚═════╝ ",
  ];

  // Frost/ice particle characters
  const frostChars = ["❄", "❅", "❆", "·", "✧", "°", "∗"];
  const snowflakePositions = [];
  for (let i = 0; i < 30; i++) {
    snowflakePositions.push({
      x: Math.floor(Math.random() * 72),
      y: Math.floor(Math.random() * coldText.length),
      ch: frostChars[Math.floor(Math.random() * frostChars.length)],
    });
  }

  // Phase 1: frost particles appear
  const frostFrame = Array(coldText.length).fill("").map(() =>
    " ".repeat(72).split("")
  );
  for (const s of snowflakePositions) {
    if (s.y < frostFrame.length && s.x < 72) {
      frostFrame[s.y][s.x] = s.ch;
    }
  }
  for (let i = 0; i < frostFrame.length; i++) {
    const line = frostFrame[i].map(ch => {
      if (ch === " ") return " ";
      return `${FROST_DIM}${ch}${RESET}`;
    }).join("");
    console.log(`  ${line}`);
  }
  await _sleep(300);

  // Phase 2: text fades in with icy gradient (line by line)
  const iceGradient = [ICE_BRIGHT, ICE_BLUE, ICE_WHITE, ICE_BLUE, ICE_BRIGHT, FROST_DIM];

  process.stdout.write(`\x1b[${coldText.length}A`);
  for (let i = 0; i < coldText.length; i++) {
    const color = iceGradient[i % iceGradient.length];
    let line = "";
    for (const ch of coldText[i]) {
      if (TEXT_CHARS.has(ch) || "█".includes(ch)) {
        line += `${color}${BOLD}${ch}${RESET}`;
      } else if (ch === " ") {
        // Check if frost particle at this position
        const frostChar = frostFrame[i]?.[line.replace(/\x1b\[[0-9;]*m/g, "").length];
        if (frostChar && frostChar !== " ") {
          line += `${FROST_DIM}${frostChar}${RESET}`;
        } else {
          line += " ";
        }
      } else {
        line += `${FROST_DIM}${ch}${RESET}`;
      }
    }
    process.stdout.write(`  ${line}\x1b[K\n`);
    await _sleep(50);
  }

  await _sleep(200);

  // Phase 3: Fun message
  console.log("");
  console.log(`${ICE_BLUE}  ❄ ─────────────────────────────────────────────── ❄${RESET}`);
  console.log("");
  console.log(`${ICE_WHITE}${BOLD}    Brrr! 🥶 Mercury's night side: −180 °C${RESET}`);
  console.log(`${FROST_DIM}    The closest planet to the Sun is also one of${RESET}`);
  console.log(`${FROST_DIM}    the coldest places in the solar system!${RESET}`);
  console.log("");
  console.log(`${ICE_BLUE}${BOLD}    ☿ Mercury isn't just code — it's COLD. ❄️${RESET}`);
  console.log("");
  console.log(`${ICE_BLUE}  ❄ ─────────────────────────────────────────────── ❄${RESET}`);
  console.log("");
  await _sleep(800);
  console.log(`${DIM}  ${GRAY}(Easter egg found! You discovered Mercury's secret.)${RESET}`);
  console.log("");

  process.stdout.write("\x1b[?25h"); // show cursor
}

/**
 * Print available commands in a styled table.
 */
export function printHelp() {
  console.log("");
  console.log(`${BOLD}${fg256(87)}  ╭─ Commands ─────────────────────────────────────────╮${RESET}`);
  console.log(`  ${GRAY}│${RESET}  ${DIM}Quick flow:${RESET} ${GREEN}ask a task${RESET} ${GRAY}→${RESET} ${GREEN}/status${RESET} ${GRAY}→${RESET} ${GREEN}/history save${RESET}`);

  const categories = [
    ["Start Here", [
      ["/help", "Show this help"],
      ["/status", "Show current session status"],
      ["/workspace <path>", "View or switch workspace"],
      ["/trust <mode>", "Switch safety/approval mode"],
      ["/clear", "Clear conversation"],
      ["/edit", "Open $EDITOR for multiline input"],
      ["/exit", "Exit Mercury Code"],
    ]],
    ["Safety & Workspace", [
      ["/sandbox [mode]", "on | off | strict | subagents | network"],
      ["/login <key>", "Set API key"],
      ["/logout", "Clear API key"],
      ["/undo", "Undo last action (revert messages)"],
    ]],
    ["Model Settings", [
      ["/model [name]", "View/change model"],
      ["/reasoning <level>", "instant | low | medium | high"],
      ["/settings [key val]", "View/modify any setting"],
      ["/config", "Show raw config (read-only)"],
    ]],
    ["Features", [
      ["/labs [feature]", "Labs mode — toggle experimental features"],
      ["/supercompress", "Toggle aggressive compression"],
      ["/contextsearch", "Toggle context search tool"],
      ["/agents [cmd]", "list | create <name> — manage agents"],
      ["/mcp [cmd]", "status | reload — manage MCP servers"],
      ["/skills", "List available skills"],
    ]],
    ["Session", [
      ["/export [file]", "Export conversation to file (.md/.json/.txt/.html)"],
      ["/history [cmd]", "save | restore | list"],
      ["/context", "View context usage & stats"],
      ["/cost", "Show token usage & cost estimate"],
      ["/status", "Show current session status"],
      ["/memory [cmd]", "show | add <text> | clear | edit"],
      ["/verbose", "Toggle verbose/debug logging"],
      ["/diff [ref]", "Show git diff (default: HEAD)"],
      ["/compact", "Compact/summarize conversation"],
      ["/new", "Start new conversation (saves current)"],
      ["/copy", "Copy last assistant reply to clipboard"],
      ["/init", "Create .mercury.md project config"],
      ["/doctor", "Diagnose environment issues"],
      ["/bug", "Report a bug"],
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
    AgentTeams: "👥", Lsp: "📐", AstSearch: "🌲", Skill: "⚗️",
  };
  // MCP tools get a special plug icon
  const icon = name.startsWith("mcp__") ? "🔌" : (icons[name] || "🔧");

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
    case "Skill":
      return args.skill ? `/${args.skill}${args.args ? " " + args.args.slice(0, 30) : ""}` : "";
    default:
      // MCP tools: show server + tool name
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        return parts.length >= 3 ? `${parts[1]}/${parts.slice(2).join("__")}` : name;
      }
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

// ── LaTeX → Unicode mapping ───────────────────────────────────────────────────
const LATEX_UNICODE = {
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
  '\\epsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ',
  '\\iota': 'ι', '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ',
  '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\rho': 'ρ',
  '\\sigma': 'σ', '\\tau': 'τ', '\\upsilon': 'υ', '\\phi': 'φ',
  '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
  '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
  '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Phi': 'Φ',
  '\\Psi': 'Ψ', '\\Omega': 'Ω',
  '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇',
  '\\sum': '∑', '\\prod': '∏', '\\int': '∫',
  '\\sqrt': '√', '\\pm': '±', '\\mp': '∓',
  '\\times': '×', '\\div': '÷', '\\cdot': '·',
  '\\leq': '≤', '\\geq': '≥', '\\neq': '≠',
  '\\approx': '≈', '\\equiv': '≡',
  '\\subset': '⊂', '\\supset': '⊃', '\\subseteq': '⊆', '\\supseteq': '⊇',
  '\\cup': '∪', '\\cap': '∩', '\\in': '∈', '\\notin': '∉',
  '\\forall': '∀', '\\exists': '∃',
  '\\rightarrow': '→', '\\leftarrow': '←',
  '\\Rightarrow': '⇒', '\\Leftarrow': '⇐',
  '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔',
  '\\to': '→', '\\gets': '←',
  '\\ldots': '…', '\\cdots': '⋯',
  '\\langle': '⟨', '\\rangle': '⟩',
  '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉',
  '\\left': '', '\\right': '', '\\quad': '  ', '\\qquad': '    ',
  '\\text': '', '\\mathrm': '', '\\mathbf': '',
};
const LATEX_SORTED = Object.entries(LATEX_UNICODE).sort((a, b) => b[0].length - a[0].length);
const SUPERSCRIPT_MAP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUBSCRIPT_MAP = '₀₁₂₃₄₅₆₇₈₉';
// Extended super/subscript maps for alphabetic characters
const SUPERSCRIPT_ALPHA = {
  a:'ᵃ',b:'ᵇ',c:'ᶜ',d:'ᵈ',e:'ᵉ',f:'ᶠ',g:'ᵍ',h:'ʰ',i:'ⁱ',j:'ʲ',
  k:'ᵏ',l:'ˡ',m:'ᵐ',n:'ⁿ',o:'ᵒ',p:'ᵖ',r:'ʳ',s:'ˢ',t:'ᵗ',u:'ᵘ',
  v:'ᵛ',w:'ʷ',x:'ˣ',y:'ʸ',z:'ᶻ',T:'ᵀ','+':'⁺','-':'⁻','=':'⁼',
};
const SUBSCRIPT_ALPHA = {
  a:'ₐ',e:'ₑ',h:'ₕ',i:'ᵢ',j:'ⱼ',k:'ₖ',l:'ₗ',m:'ₘ',n:'ₙ',
  o:'ₒ',p:'ₚ',r:'ᵣ',s:'ₛ',t:'ₜ',u:'ᵤ',v:'ᵥ',x:'ₓ','+':'₊','-':'₋',
};

/**
 * Terminal Markdown Renderer
 * Renders Markdown + LaTeX as ANSI-styled terminal output during streaming.
 * Buffers text line-by-line: complete lines are formatted, partial lines
 * stream raw until a newline arrives.
 */
export class TerminalMarkdownRenderer {
  constructor() {
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeBlockLang = '';
    this.inMathBlock = false;
    this.inTable = false;
    this.tableRows = [];
  }

  /** Feed a streaming chunk into the renderer. */
  write(chunk) {
    this.buffer += chunk;
    let nlIdx;
    while ((nlIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      this._renderLine(line);
    }
  }

  /** Flush any remaining buffered text. */
  flush() {
    if (this.buffer) {
      this._renderLine(this.buffer);
      this.buffer = '';
    }
    if (this.inCodeBlock) {
      const w = Math.min(getTermWidth() - 4, 56);
      process.stdout.write(`  ${DIM}╰${'─'.repeat(w)}╯${RESET}\n`);
      this.inCodeBlock = false;
    }
    if (this.inMathBlock) {
      process.stdout.write(`  ${DIM}╰─ math ${'─'.repeat(43)}╯${RESET}\n`);
      this.inMathBlock = false;
    }
    this._flushTable();
  }

  _renderLine(line) {
    // ── Code block fence ──
    if (line.startsWith('```')) {
      this._flushTable();
      if (this.inCodeBlock) {
        const w = Math.min(getTermWidth() - 4, 56);
        process.stdout.write(`  ${DIM}╰${'─'.repeat(w)}╯${RESET}\n`);
        this.inCodeBlock = false;
      } else {
        this.codeBlockLang = line.slice(3).trim();
        const label = this.codeBlockLang ? ` ${this.codeBlockLang} ` : '';
        const w = Math.min(getTermWidth() - 4, 56);
        const fill = Math.max(0, w - label.length - 2);
        process.stdout.write(`  ${DIM}╭──${label}${'─'.repeat(fill)}╮${RESET}\n`);
        this.inCodeBlock = true;
      }
      return;
    }

    if (this.inCodeBlock) {
      process.stdout.write(`  ${DIM}│${RESET} ${line}\n`);
      return;
    }

    // ── LaTeX display math $$...$$ block ──
    if (line.trim() === '$$') {
      this._flushTable();
      if (this.inMathBlock) {
        process.stdout.write(`  ${DIM}╰─ math ${'─'.repeat(43)}╯${RESET}\n`);
        this.inMathBlock = false;
      } else {
        process.stdout.write(`  ${DIM}╭─ math ${'─'.repeat(43)}╮${RESET}\n`);
        this.inMathBlock = true;
      }
      return;
    }

    if (this.inMathBlock) {
      const rendered = this._renderLatex(line);
      process.stdout.write(`  ${DIM}│${RESET} ${MERCURY_CYAN}${rendered}${RESET}\n`);
      return;
    }

    // ── Inline $$ on single line ──
    const inlineDisplayMatch = line.match(/^\$\$(.+)\$\$$/);
    if (inlineDisplayMatch) {
      this._flushTable();
      const rendered = this._renderLatex(inlineDisplayMatch[1]);
      process.stdout.write(`  ${DIM}╭─ math ${'─'.repeat(43)}╮${RESET}\n`);
      process.stdout.write(`  ${DIM}│${RESET} ${MERCURY_CYAN}${rendered}${RESET}\n`);
      process.stdout.write(`  ${DIM}╰─ math ${'─'.repeat(43)}╯${RESET}\n`);
      return;
    }

    // ── \\[...\\] display math ──
    const bracketMathMatch = line.match(/^\\\[(.+)\\\]$/);
    if (bracketMathMatch) {
      this._flushTable();
      const rendered = this._renderLatex(bracketMathMatch[1]);
      process.stdout.write(`  ${DIM}╭─ math ${'─'.repeat(43)}╮${RESET}\n`);
      process.stdout.write(`  ${DIM}│${RESET} ${MERCURY_CYAN}${rendered}${RESET}\n`);
      process.stdout.write(`  ${DIM}╰─ math ${'─'.repeat(43)}╯${RESET}\n`);
      return;
    }

    // ── Table rows ──
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      this.tableRows.push(line.trim());
      this.inTable = true;
      return;
    }
    if (this.inTable) {
      this._flushTable();
    }

    // ── Heading ──
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = this._renderInline(headingMatch[2]);
      const colors = [MERCURY_TEAL, MERCURY_BLUE, MERCURY_CYAN, MERCURY_SILVER, MERCURY_AMBER, GRAY];
      const color = colors[level - 1] || CYAN;
      if (level <= 2) {
        process.stdout.write(`\n${BOLD}${color}${text}${RESET}\n`);
      } else {
        process.stdout.write(`${BOLD}${color}${text}${RESET}\n`);
      }
      return;
    }

    // ── Horizontal rule ──
    if (/^[-*_]{3,}\s*$/.test(line)) {
      const w = Math.min(getTermWidth() - 4, 60);
      process.stdout.write(`${DIM}${'─'.repeat(w)}${RESET}\n`);
      return;
    }

    // ── Blockquote ──
    if (line.startsWith('> ')) {
      const text = this._renderInline(line.slice(2));
      process.stdout.write(`  ${MERCURY_BLUE}│${RESET} ${ITALIC}${text}${RESET}\n`);
      return;
    }

    // ── Unordered list ──
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const text = this._renderInline(ulMatch[2]);
      process.stdout.write(`${indent}  ${MERCURY_TEAL}•${RESET} ${text}\n`);
      return;
    }

    // ── Ordered list ──
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      const indent = olMatch[1];
      const num = olMatch[2];
      const text = this._renderInline(olMatch[3]);
      process.stdout.write(`${indent}  ${MERCURY_TEAL}${num}.${RESET} ${text}\n`);
      return;
    }

    // ── Empty line ──
    if (!line.trim()) {
      process.stdout.write('\n');
      return;
    }

    // ── Regular text ──
    process.stdout.write(this._renderInline(line) + '\n');
  }

  _renderInline(text) {
    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
    text = text.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);
    // Italic: *text*
    text = text.replace(/(?<![*\\])\*([^*]+?)\*/g, `${ITALIC}$1${RESET}`);
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, `${bg256(236)}${MERCURY_CYAN} $1 ${RESET}`);
    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}${MERCURY_BLUE}$1${RESET}${DIM} ($2)${RESET}`);
    // Strikethrough: ~~text~~
    text = text.replace(/~~(.+?)~~/g, `${DIM}\x1b[9m$1${RESET}`);
    // Inline LaTeX: $formula$ (skip currency like $5)
    text = text.replace(/(?<![\\$])\$([^\$\n]+?)\$/g, (match, f) => {
      if (/^\d+([.,]\d+)?$/.test(f.trim())) return match;
      return `${MERCURY_CYAN}${this._renderLatex(f)}${RESET}`;
    });
    // Inline LaTeX: \(formula\)
    text = text.replace(/\\\((.+?)\\\)/g, (_, f) => `${MERCURY_CYAN}${this._renderLatex(f)}${RESET}`);
    return text;
  }

  _renderLatex(formula) {
    let result = formula;

    // Handle structural commands with nested brace support
    result = this._processLatexCommands(result);

    // Replace known symbols (longest first to avoid partial matches)
    for (const [tex, uni] of LATEX_SORTED) {
      result = result.split(tex).join(uni);
    }

    // Superscripts: ^{...} or ^x
    result = result.replace(/\^{([^}]+)}/g, (_, sup) =>
      [...sup].map(c => {
        const i = '0123456789'.indexOf(c);
        return i >= 0 ? SUPERSCRIPT_MAP[i] : (SUPERSCRIPT_ALPHA[c] || c);
      }).join('')
    );
    result = result.replace(/\^([0-9a-zA-Z])/g, (_, c) => {
      const i = '0123456789'.indexOf(c);
      return i >= 0 ? SUPERSCRIPT_MAP[i] : (SUPERSCRIPT_ALPHA[c] || c);
    });
    // Subscripts: _{...} or _x
    result = result.replace(/_{([^}]+)}/g, (_, sub) =>
      [...sub].map(c => {
        const i = '0123456789'.indexOf(c);
        return i >= 0 ? SUBSCRIPT_MAP[i] : (SUBSCRIPT_ALPHA[c] || c);
      }).join('')
    );
    result = result.replace(/_([0-9a-zA-Z])/g, (_, c) => {
      const i = '0123456789'.indexOf(c);
      return i >= 0 ? SUBSCRIPT_MAP[i] : (SUBSCRIPT_ALPHA[c] || c);
    });
    // Clean remaining braces
    result = result.replace(/[{}]/g, '');
    return result;
  }

  /**
   * Extract matched brace group starting at pos. Returns [content, endPos].
   * Handles nested braces correctly.
   */
  static _matchBraces(str, pos) {
    if (pos >= str.length || str[pos] !== '{') return [null, pos];
    let depth = 0;
    let start = pos + 1;
    for (let i = pos; i < str.length; i++) {
      if (str[i] === '{') depth++;
      else if (str[i] === '}') {
        depth--;
        if (depth === 0) return [str.slice(start, i), i + 1];
      }
    }
    return [str.slice(start), str.length]; // unclosed brace
  }

  /**
   * Process LaTeX structural commands (\frac, \sqrt, \text, etc.)
   * with proper nested brace handling.
   */
  _processLatexCommands(text) {
    let result = '';
    let i = 0;

    while (i < text.length) {
      if (text[i] === '\\') {
        // Extract command name
        let cmd = '';
        let j = i + 1;
        while (j < text.length && /[a-zA-Z]/.test(text[j])) {
          cmd += text[j];
          j++;
        }

        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
          const [num, afterNum] = TerminalMarkdownRenderer._matchBraces(text, j);
          if (num !== null) {
            const [den, afterDen] = TerminalMarkdownRenderer._matchBraces(text, afterNum);
            if (den !== null) {
              result += `(${this._processLatexCommands(num)})/(${this._processLatexCommands(den)})`;
              i = afterDen;
              continue;
            }
          }
        } else if (cmd === 'sqrt') {
          // Check for optional [n] argument
          let nthRoot = '';
          let k = j;
          if (k < text.length && text[k] === '[') {
            const closeBracket = text.indexOf(']', k);
            if (closeBracket !== -1) {
              nthRoot = text.slice(k + 1, closeBracket);
              k = closeBracket + 1;
            }
          }
          const [arg, afterArg] = TerminalMarkdownRenderer._matchBraces(text, k);
          if (arg !== null) {
            const inner = this._processLatexCommands(arg);
            if (nthRoot) {
              const sup = [...nthRoot].map(c => {
                const idx = '0123456789'.indexOf(c);
                return idx >= 0 ? SUPERSCRIPT_MAP[idx] : c;
              }).join('');
              result += `${sup}√(${inner})`;
            } else {
              result += `√(${inner})`;
            }
            i = afterArg;
            continue;
          }
        } else if (['text','mathrm','mathit','mathbf','mathbb','mathcal','operatorname','textbf','mathsf'].includes(cmd)) {
          const [arg, afterArg] = TerminalMarkdownRenderer._matchBraces(text, j);
          if (arg !== null) {
            result += this._processLatexCommands(arg);
            i = afterArg;
            continue;
          }
        }
      }

      result += text[i];
      i++;
    }

    return result;
  }

  _flushTable() {
    if (!this.inTable || this.tableRows.length === 0) {
      this.inTable = false;
      return;
    }

    // Parse table rows
    const rows = this.tableRows.map(row =>
      row.slice(1, -1).split('|').map(cell => cell.trim())
    );

    // Find separator row (---) and remove it
    const dataRows = rows.filter(row => !row.every(cell => /^[-:]+$/.test(cell)));

    if (dataRows.length === 0) {
      this.tableRows = [];
      this.inTable = false;
      return;
    }

    // Calculate column widths
    const colCount = Math.max(...dataRows.map(r => r.length));
    const widths = Array.from({ length: colCount }, (_, col) =>
      Math.max(...dataRows.map(r => (r[col] || '').length), 3)
    );

    // Render table with box drawing
    const topBorder = `  ${DIM}┌${ widths.map(w => '─'.repeat(w + 2)).join('┬') }┐${RESET}`;
    const midBorder = `  ${DIM}├${ widths.map(w => '─'.repeat(w + 2)).join('┼') }┤${RESET}`;
    const botBorder = `  ${DIM}└${ widths.map(w => '─'.repeat(w + 2)).join('┴') }┘${RESET}`;

    process.stdout.write(topBorder + '\n');
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const cells = widths.map((w, col) => {
        const cell = row[col] || '';
        const padded = cell.padEnd(w);
        return i === 0 ? `${BOLD}${MERCURY_TEAL}${padded}${RESET}` : this._renderInline(padded);
      });
      process.stdout.write(`  ${DIM}│${RESET} ${cells.join(` ${DIM}│${RESET} `)} ${DIM}│${RESET}\n`);
      if (i === 0 && dataRows.length > 1) {
        process.stdout.write(midBorder + '\n');
      }
    }
    process.stdout.write(botBorder + '\n');

    this.tableRows = [];
    this.inTable = false;
  }
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
    console.log(`  ${GRAY}│${RESET}     ${GRAY}${s.cwd || "(unknown workspace)"}${RESET}`);
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
