// Mercury Code - Shared ANSI Color Constants (Rust port)
// Semantic color names for terminal output.
// Used by display, autocomplete, agent_tabs, and any module needing colored terminal output.

use crossterm::style::{Attribute, Color, SetAttribute, SetForegroundColor, SetBackgroundColor, ResetColor};
use std::fmt;

// ---------------------------------------------------------------------------
// ANSI escape prefix (for raw escape sequences where crossterm is overkill)
// ---------------------------------------------------------------------------
pub const ESC: &str = "\x1b[";

// ---------------------------------------------------------------------------
// Reset & modifiers (raw ANSI strings for fast inline use)
// ---------------------------------------------------------------------------
pub const RESET: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";
pub const DIM: &str = "\x1b[2m";
pub const ITALIC: &str = "\x1b[3m";
pub const UNDERLINE: &str = "\x1b[4m";
pub const STRIKETHROUGH: &str = "\x1b[9m";

// ---------------------------------------------------------------------------
// Standard foreground colors
// ---------------------------------------------------------------------------
pub const RED: &str = "\x1b[31m";
pub const GREEN: &str = "\x1b[32m";
pub const YELLOW: &str = "\x1b[33m";
pub const BLUE: &str = "\x1b[34m";
pub const MAGENTA: &str = "\x1b[35m";
pub const CYAN_STD: &str = "\x1b[36m";
pub const WHITE: &str = "\x1b[37m";
pub const GRAY: &str = "\x1b[90m";

// Extended / 256-color cyan (matches JS CYAN = \x1b[38;5;87m)
pub const CYAN: &str = "\x1b[38;5;87m";

// ---------------------------------------------------------------------------
// Background colors
// ---------------------------------------------------------------------------
pub const BG_RED: &str = "\x1b[41m";

// ---------------------------------------------------------------------------
// Helper functions for 256-color and true-color sequences
// ---------------------------------------------------------------------------

/// Generate a 256-color foreground escape sequence.
#[inline]
pub fn fg256(n: u8) -> String {
    format!("\x1b[38;5;{}m", n)
}

/// Generate a 256-color background escape sequence.
#[inline]
pub fn bg256(n: u8) -> String {
    format!("\x1b[48;5;{}m", n)
}

/// Generate a 24-bit true-color (RGB) foreground escape sequence.
#[inline]
pub fn rgb(r: u8, g: u8, b: u8) -> String {
    format!("\x1b[38;2;{};{};{}m", r, g, b)
}

/// Generate a 24-bit true-color (RGB) background escape sequence.
#[inline]
pub fn bg_rgb(r: u8, g: u8, b: u8) -> String {
    format!("\x1b[48;2;{};{};{}m", r, g, b)
}

// ---------------------------------------------------------------------------
// Mercury brand palette (true-color)
// ---------------------------------------------------------------------------

/// Silver - the mercury metal
pub fn mercury_silver() -> String { rgb(192, 203, 215) }
/// Deep blue - Mercury's night sky
pub fn mercury_blue() -> String { rgb(86, 156, 214) }
/// Teal - core accent
pub fn mercury_teal() -> String { rgb(78, 201, 176) }
/// Light cyan - highlights
pub fn mercury_cyan() -> String { rgb(156, 220, 254) }
/// Warm amber - accent
pub fn mercury_amber() -> String { rgb(206, 145, 120) }

// ---------------------------------------------------------------------------
// Mercury brand gradient colors (teal -> cyan -> white) as 256-color
// ---------------------------------------------------------------------------

/// Brand gradient array (6 colors: teal -> cyan -> white).
pub fn brand_gradient() -> [String; 6] {
    [
        fg256(30),
        fg256(37),
        fg256(44),
        fg256(51),
        fg256(87),
        fg256(123),
    ]
}

// ---------------------------------------------------------------------------
// Style - a small helper for combining styles
// ---------------------------------------------------------------------------

/// A terminal style consisting of optional foreground color, attributes, and reset.
#[derive(Debug, Clone)]
pub struct Style {
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            fg: None,
            bg: None,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
        }
    }
}

impl Style {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn fg(mut self, color: &str) -> Self {
        self.fg = Some(color.to_string());
        self
    }

    pub fn bg(mut self, color: &str) -> Self {
        self.bg = Some(color.to_string());
        self
    }

    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }

    pub fn dim(mut self) -> Self {
        self.dim = true;
        self
    }

    pub fn italic(mut self) -> Self {
        self.italic = true;
        self
    }

    pub fn underline(mut self) -> Self {
        self.underline = true;
        self
    }

    /// Apply this style to a string, returning the styled string with a RESET at the end.
    pub fn paint(&self, text: &str) -> String {
        let mut prefix = String::new();
        if let Some(ref fg) = self.fg {
            prefix.push_str(fg);
        }
        if let Some(ref bg) = self.bg {
            prefix.push_str(bg);
        }
        if self.bold {
            prefix.push_str(BOLD);
        }
        if self.dim {
            prefix.push_str(DIM);
        }
        if self.italic {
            prefix.push_str(ITALIC);
        }
        if self.underline {
            prefix.push_str(UNDERLINE);
        }
        format!("{}{}{}", prefix, text, RESET)
    }
}

// ---------------------------------------------------------------------------
// Utility: strip ANSI escape sequences from a string
// ---------------------------------------------------------------------------

/// Strip all ANSI escape sequences, returning visible characters only.
pub fn strip_ansi(s: &str) -> String {
    // Matches ESC [ ... m  (SGR sequences) and ESC [ ... (other CSI)
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Skip the escape sequence
            if let Some(&'[') = chars.peek() {
                chars.next(); // consume '['
                // Consume until we see a letter (the final byte of a CSI sequence)
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c.is_ascii_alphabetic() || c == 'm' {
                        break;
                    }
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/// Compute the visible length of a string (stripping ANSI codes).
pub fn visible_len(s: &str) -> usize {
    strip_ansi(s).chars().count()
}

// ---------------------------------------------------------------------------
// Theme support
// ---------------------------------------------------------------------------

/// Color theme for the terminal UI.
#[derive(Debug, Clone)]
pub struct Theme {
    pub accent: String,
    pub secondary: String,
    pub muted: String,
    pub error: String,
    pub warning: String,
    pub success: String,
    pub info: String,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            accent: mercury_teal(),
            secondary: mercury_blue(),
            muted: GRAY.to_string(),
            error: RED.to_string(),
            warning: YELLOW.to_string(),
            success: GREEN.to_string(),
            info: fg256(75),
        }
    }
}

impl Theme {
    /// The default Mercury theme.
    pub fn mercury() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fg256() {
        assert_eq!(fg256(87), "\x1b[38;5;87m");
    }

    #[test]
    fn test_bg256() {
        assert_eq!(bg256(236), "\x1b[48;5;236m");
    }

    #[test]
    fn test_rgb() {
        assert_eq!(rgb(78, 201, 176), "\x1b[38;2;78;201;176m");
    }

    #[test]
    fn test_strip_ansi() {
        let styled = format!("{}hello{}", BOLD, RESET);
        assert_eq!(strip_ansi(&styled), "hello");
    }

    #[test]
    fn test_visible_len() {
        let styled = format!("{}{}hello{}", RED, BOLD, RESET);
        assert_eq!(visible_len(&styled), 5);
    }

    #[test]
    fn test_style_paint() {
        let s = Style::new().fg(RED).bold().paint("error");
        assert!(s.starts_with("\x1b[31m\x1b[1m"));
        assert!(s.ends_with(RESET));
        assert!(s.contains("error"));
    }

    #[test]
    fn test_brand_gradient_length() {
        assert_eq!(brand_gradient().len(), 6);
    }
}
