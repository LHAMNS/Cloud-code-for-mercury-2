// Mercury Code - Shared ANSI Color Constants
// Semantic color names for terminal output.
// Used by: repl.js, skills.js, and any module needing colored terminal output.
//
// Eliminates repeated inline `const E = "\x1b[", R = ...` definitions.

export const ESC = "\x1b[";

// Reset & modifiers
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const ITALIC = `${ESC}3m`;

// Standard foreground colors
export const RED = `${ESC}31m`;
export const GREEN = `${ESC}32m`;
export const YELLOW = `${ESC}33m`;
export const BLUE = `${ESC}34m`;
export const MAGENTA = `${ESC}35m`;
export const WHITE = `${ESC}37m`;
export const GRAY = `${ESC}90m`;

// Extended / 256-color
export const CYAN = `${ESC}38;5;87m`;

// Background colors
export const BG_RED = `${ESC}41m`;

// Cursor movement (parameterized — use via template literal)
// e.g. `${ESC}${n}A` to move cursor up n lines
