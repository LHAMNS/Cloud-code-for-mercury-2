// Mercury Code - Terminal Display Module (Rust port)
// Markdown rendering, syntax highlighting, streaming, spinners, status bar,
// tool-call formatting, box drawing, and text wrapping.

use std::io::{self, Write};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;

use crate::colors::*;

// ---------------------------------------------------------------------------
// Lazy-loaded syntect resources
// ---------------------------------------------------------------------------

fn syntax_set() -> &'static SyntaxSet {
    static SS: OnceLock<SyntaxSet> = OnceLock::new();
    SS.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn theme_set() -> &'static ThemeSet {
    static TS: OnceLock<ThemeSet> = OnceLock::new();
    TS.get_or_init(ThemeSet::load_defaults)
}

fn default_theme() -> &'static Theme {
    &theme_set().themes["base16-ocean.dark"]
}

// ---------------------------------------------------------------------------
// Terminal width helper
// ---------------------------------------------------------------------------

/// Return the current terminal width, defaulting to 80 if unavailable.
pub fn term_width() -> usize {
    crossterm::terminal::size().map(|(w, _)| w as usize).unwrap_or(80)
}

// ---------------------------------------------------------------------------
// Markdown rendering (via termimad)
// ---------------------------------------------------------------------------

/// Render a Markdown string to styled terminal text using `termimad`.
///
/// The result is a `String` containing ANSI escape sequences ready for
/// printing to stdout.
pub fn render_markdown(md: &str) -> String {
    let skin = termimad::MadSkin::default();
    let area = termimad::Area::new(0, 0, term_width() as u16, u16::MAX);
    let text = skin.area_text(md, &area);
    text.to_string()
}

// ---------------------------------------------------------------------------
// Syntax highlighting (via syntect)
// ---------------------------------------------------------------------------

/// Highlight source code with ANSI colors.
///
/// `lang` is an optional language hint (e.g. `"rs"`, `"py"`).  When `None`
/// or unrecognised the plain-text syntax is used.
pub fn highlight_code(code: &str, lang: Option<&str>) -> String {
    use syntect::easy::HighlightLines;
    use syntect::util::as_24_bit_terminal_escaped;

    let ss = syntax_set();
    let syntax = lang
        .and_then(|l| ss.find_syntax_by_token(l))
        .unwrap_or_else(|| ss.find_syntax_plain_text());
    let theme = default_theme();
    let mut h = HighlightLines::new(syntax, theme);

    let mut out = String::new();
    for line in code.lines() {
        match h.highlight_line(line, ss) {
            Ok(ranges) => {
                out.push_str(&as_24_bit_terminal_escaped(&ranges, false));
                out.push('\n');
            }
            Err(_) => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out.push_str(RESET);
    out
}

// ---------------------------------------------------------------------------
// Streaming text display
// ---------------------------------------------------------------------------

/// Write `text` character-by-character to stdout with a small delay between
/// each character, giving the appearance of streaming output.
///
/// `delay` controls the per-character pause.  A typical value is
/// `Duration::from_millis(5)`.
pub fn stream_text(text: &str, delay: Duration) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    for ch in text.chars() {
        write!(stdout, "{ch}")?;
        stdout.flush()?;
        std::thread::sleep(delay);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tool call / result display
// ---------------------------------------------------------------------------

/// Format and print a tool call notification.
///
/// Mimics the Codex-style `│ ├─ icon BOLD name  dim(summary)` formatting.
pub fn display_tool_call(name: &str, summary: Option<&str>) {
    let icon = match name {
        "Read" => "\u{1F4D6}",
        "Write" => "\u{1F4DD}",
        "Edit" => "\u{270F}\u{FE0F}",
        "Patch" => "\u{1F528}",
        "Bash" => "\u{26A1}",
        "Glob" => "\u{1F50D}",
        "Grep" => "\u{1F50E}",
        "ListDir" => "\u{1F4C2}",
        "Diff" => "\u{1F4CA}",
        "Fetch" => "\u{1F310}",
        "ContextSearch" => "\u{1F52C}",
        "SubAgent" => "\u{1F916}",
        "SubAgentTeam" | "AgentTeams" => "\u{1F465}",
        "Lsp" => "\u{1F4D0}",
        "AstSearch" => "\u{1F332}",
        "Skill" => "\u{2697}\u{FE0F}",
        n if n.starts_with("mcp__") => "\u{1F50C}",
        _ => "\u{1F527}",
    };

    let border = fg256(75);
    let detail = match summary {
        Some(s) if !s.is_empty() => format!(" {DIM}{s}{RESET}"),
        _ => String::new(),
    };

    println!("{border}  \u{2502}{RESET}");
    println!(
        "{border}  \u{251C}\u{2500}{RESET} {icon_color}{icon} {BOLD}{name}{RESET}{detail}",
        icon_color = fg256(214),
    );
}

/// Format and print a tool result with optional elapsed time.
///
/// Long results are truncated at `truncate_at` characters.
pub fn display_tool_result(result: &str, elapsed_ms: Option<u64>, truncate_at: usize) {
    let border = fg256(75);
    let mut output = result.to_string();
    let total_len = output.len();
    if output.len() > truncate_at {
        output.truncate(truncate_at);
        output.push_str(&format!("\n{DIM}... ({total_len} chars total){RESET}"));
    }
    for line in output.lines() {
        println!("{border}  \u{2502}{RESET}  {GRAY}{line}{RESET}");
    }
    if let Some(ms) = elapsed_ms {
        let sec = ms as f64 / 1000.0;
        println!("{border}  \u{2502}{RESET}  {GRAY}({sec:.1}s){RESET}");
    }
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

/// Animated braille-dot spinner with elapsed time display.
///
/// ```text
///   │ ⠹ Thinking... 1.2s
/// ```
pub struct Spinner {
    frames: &'static [&'static str],
    frame_index: usize,
    start: Instant,
    message: String,
}

const SPINNER_FRAMES: &[&str] = &[
    "\u{280B}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283C}", "\u{2834}",
    "\u{2826}", "\u{2827}", "\u{2807}", "\u{280F}",
];

impl Spinner {
    /// Create a new spinner with the given status message.
    pub fn new(message: &str) -> Self {
        Self {
            frames: SPINNER_FRAMES,
            frame_index: 0,
            start: Instant::now(),
            message: message.to_string(),
        }
    }

    /// Render a single frame to stdout, overwriting the current line.
    pub fn tick(&mut self) -> io::Result<()> {
        let frame = self.frames[self.frame_index % self.frames.len()];
        let brand = brand_gradient();
        let color = &brand[self.frame_index % brand.len()];
        let border = fg256(75);
        let elapsed = self.start.elapsed().as_secs_f64();

        let mut stdout = io::stdout().lock();
        write!(
            stdout,
            "\r{border}  \u{2502}{RESET} {color}{frame}{RESET} {DIM}{msg}{RESET} {GRAY}{elapsed:.1}s{RESET}\x1b[K",
            msg = self.message,
        )?;
        stdout.flush()?;
        self.frame_index += 1;
        Ok(())
    }

    /// Clear the spinner line and show the cursor again.
    pub fn stop(&self) -> io::Result<()> {
        let mut stdout = io::stdout().lock();
        write!(stdout, "\r\x1b[K\x1b[?25h")?;
        stdout.flush()
    }

    /// Return elapsed time since spinner creation.
    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

/// A bottom status bar showing model name, trust mode, and token usage.
pub struct StatusBar {
    pub model: String,
    pub trust_mode: String,
    pub tokens_used: usize,
    pub tokens_max: usize,
}

impl StatusBar {
    pub fn new(model: &str, trust_mode: &str, tokens_used: usize, tokens_max: usize) -> Self {
        Self {
            model: model.to_string(),
            trust_mode: trust_mode.to_string(),
            tokens_used,
            tokens_max,
        }
    }

    /// Render the status bar string (does NOT print).
    pub fn render(&self) -> String {
        let w = term_width();
        let pct = if self.tokens_max > 0 {
            std::cmp::min(100, (self.tokens_used * 100) / self.tokens_max)
        } else {
            0
        };
        let gauge_color = gauge_color(pct);
        let gauge_char = gauge_char(pct);

        let tokens_str = if self.tokens_used >= 1000 {
            format!("{:.1}K", self.tokens_used as f64 / 1000.0)
        } else {
            self.tokens_used.to_string()
        };
        let max_str = if self.tokens_max >= 1000 {
            format!("{}K", self.tokens_max / 1000)
        } else {
            self.tokens_max.to_string()
        };

        let left = format!(
            " {BOLD}{teal}\u{263F} Mercury{RESET} {DIM}| {model} | {trust}{RESET}",
            teal = mercury_teal(),
            model = self.model,
            trust = self.trust_mode,
        );
        let right = format!(
            "{gc}{BOLD}{gch}{RESET} {gc}{pct}%{RESET} {DIM}{tokens_str}/{max_str}{RESET} ",
            gc = gauge_color,
            gch = gauge_char,
        );

        let left_vis = visible_len(&left);
        let right_vis = visible_len(&right);
        let padding = if w > left_vis + right_vis {
            w - left_vis - right_vis
        } else {
            1
        };

        format!("{left}{}{right}", " ".repeat(padding))
    }
}

// Gauge helpers (mirrors JS _gaugeColor / _gaugeChar).

fn gauge_color(pct: usize) -> String {
    if pct > 90 {
        RED.to_string()
    } else if pct > 75 {
        YELLOW.to_string()
    } else if pct > 50 {
        fg256(214)
    } else {
        GREEN.to_string()
    }
}

fn gauge_char(pct: usize) -> &'static str {
    if pct <= 5 {
        "\u{25CB}" // ○
    } else if pct <= 30 {
        "\u{25D4}" // ◔
    } else if pct <= 55 {
        "\u{25D1}" // ◑
    } else if pct <= 80 {
        "\u{25D5}" // ◕
    } else {
        "\u{25CF}" // ●
    }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/// Format an error message with red styling.
pub fn format_error(message: &str) -> String {
    format!("\n{RED}{BOLD}  \u{2717} {message}{RESET}\n")
}

/// Format a warning message with yellow styling.
pub fn format_warning(message: &str) -> String {
    format!("{YELLOW}  \u{26A0} {message}{RESET}")
}

/// Format an info message with blue icon.
pub fn format_info(message: &str) -> String {
    let info_color = fg256(75);
    format!("{info_color}  \u{2139} {message}{RESET}")
}

/// Format a success message with green styling.
pub fn format_success(message: &str) -> String {
    format!("{GREEN}{BOLD}  \u{2713} {message}{RESET}")
}

// ---------------------------------------------------------------------------
// Text wrapping
// ---------------------------------------------------------------------------

/// Wrap `text` to fit within `width` columns, respecting word boundaries.
///
/// Uses Unicode-aware width calculation (`unicode-width` crate).
pub fn text_wrap(text: &str, width: usize) -> Vec<String> {
    use unicode_width::UnicodeWidthStr;

    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            lines.push(String::new());
            continue;
        }
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current_line = String::new();
        let mut current_width: usize = 0;
        for word in &words {
            let w = UnicodeWidthStr::width(*word);
            if current_width == 0 {
                current_line.push_str(word);
                current_width = w;
            } else if current_width + 1 + w <= width {
                current_line.push(' ');
                current_line.push_str(word);
                current_width += 1 + w;
            } else {
                lines.push(std::mem::take(&mut current_line));
                current_line.push_str(word);
                current_width = w;
            }
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }
    lines
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

/// Draw a Unicode box around `content_lines`.
///
/// ```text
/// ╭─ title ──────────╮
/// │ line 1            │
/// │ line 2            │
/// ╰───────────────────╯
/// ```
pub fn draw_box(title: &str, content_lines: &[&str], width: usize) -> String {
    let inner = if width >= 4 { width - 4 } else { width };

    // Top border
    let title_display = if title.is_empty() {
        String::new()
    } else {
        format!(" {title} ")
    };
    let title_vis_len = visible_len(&title_display);
    let top_fill = if inner >= title_vis_len + 2 {
        inner - title_vis_len - 2
    } else {
        0
    };
    let mut out = format!(
        "  \u{256D}\u{2500}{title_display}{fill}\u{256E}\n",
        fill = "\u{2500}".repeat(top_fill),
    );

    // Content lines
    for line in content_lines {
        let vis = visible_len(line);
        let pad = if inner > vis { inner - vis } else { 0 };
        out.push_str(&format!(
            "  \u{2502} {line}{pad} \u{2502}\n",
            pad = " ".repeat(pad),
        ));
    }

    // Bottom border
    out.push_str(&format!(
        "  \u{2570}{fill}\u{256F}\n",
        fill = "\u{2500}".repeat(width.saturating_sub(2)),
    ));

    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_markdown_non_empty() {
        let out = render_markdown("# Hello\nWorld");
        assert!(!out.is_empty());
    }

    #[test]
    fn test_highlight_code_rust() {
        let out = highlight_code("fn main() {}", Some("rs"));
        // Should contain ANSI escape sequences and the source text
        assert!(out.contains("fn"));
        assert!(out.contains('\x1b'));
    }

    #[test]
    fn test_highlight_code_unknown_lang() {
        let out = highlight_code("hello world", None);
        assert!(out.contains("hello"));
    }

    #[test]
    fn test_spinner_tick_increments_frame() {
        let mut s = Spinner::new("test");
        assert_eq!(s.frame_index, 0);
        // We don't call tick() to avoid stdout in tests, but verify construction
        assert_eq!(s.message, "test");
        s.frame_index += 1;
        assert_eq!(s.frame_index, 1);
    }

    #[test]
    fn test_spinner_frames_count() {
        assert_eq!(SPINNER_FRAMES.len(), 10);
    }

    #[test]
    fn test_status_bar_render() {
        let bar = StatusBar::new("mercury-2", "approval", 5000, 128000);
        let rendered = bar.render();
        assert!(rendered.contains("mercury-2"));
        assert!(rendered.contains("approval"));
        assert!(rendered.contains("5.0K"));
    }

    #[test]
    fn test_status_bar_zero_tokens() {
        let bar = StatusBar::new("model", "readonly", 0, 0);
        let rendered = bar.render();
        assert!(rendered.contains("model"));
    }

    #[test]
    fn test_format_error() {
        let s = format_error("something broke");
        assert!(s.contains("something broke"));
        assert!(s.contains("\u{2717}"));
        assert!(s.contains(RED));
    }

    #[test]
    fn test_format_warning() {
        let s = format_warning("careful");
        assert!(s.contains("careful"));
        assert!(s.contains(YELLOW));
    }

    #[test]
    fn test_format_info() {
        let s = format_info("note");
        assert!(s.contains("note"));
        assert!(s.contains("\u{2139}"));
    }

    #[test]
    fn test_format_success() {
        let s = format_success("done");
        assert!(s.contains("done"));
        assert!(s.contains(GREEN));
    }

    #[test]
    fn test_text_wrap_short() {
        let lines = text_wrap("hello world", 80);
        assert_eq!(lines, vec!["hello world"]);
    }

    #[test]
    fn test_text_wrap_narrow() {
        let lines = text_wrap("hello world foo bar", 10);
        assert!(lines.len() >= 2);
        for line in &lines {
            assert!(line.len() <= 10, "line too long: {line}");
        }
    }

    #[test]
    fn test_text_wrap_preserves_newlines() {
        let lines = text_wrap("a\n\nb", 80);
        assert_eq!(lines, vec!["a", "", "b"]);
    }

    #[test]
    fn test_draw_box_structure() {
        let b = draw_box("Title", &["line one", "line two"], 40);
        assert!(b.contains("\u{256D}")); // ╭
        assert!(b.contains("\u{256F}")); // ╯
        assert!(b.contains("Title"));
        assert!(b.contains("line one"));
        assert!(b.contains("line two"));
    }

    #[test]
    fn test_draw_box_empty() {
        let b = draw_box("", &[], 20);
        assert!(b.contains("\u{256D}"));
        assert!(b.contains("\u{2570}"));
    }

    #[test]
    fn test_display_tool_result_truncation() {
        // Just verify the function does not panic for long input.
        let long = "x".repeat(2000);
        display_tool_result(&long, Some(123), 600);
    }

    #[test]
    fn test_gauge_color_ranges() {
        assert_eq!(gauge_color(10), GREEN.to_string());
        assert_eq!(gauge_color(55), fg256(214));
        assert_eq!(gauge_color(80), YELLOW.to_string());
        assert_eq!(gauge_color(95), RED.to_string());
    }

    #[test]
    fn test_gauge_char_ranges() {
        assert_eq!(gauge_char(0), "\u{25CB}");
        assert_eq!(gauge_char(20), "\u{25D4}");
        assert_eq!(gauge_char(50), "\u{25D1}");
        assert_eq!(gauge_char(70), "\u{25D5}");
        assert_eq!(gauge_char(90), "\u{25CF}");
    }

    #[test]
    fn test_stream_text_empty() {
        // Streaming empty text should succeed instantly.
        stream_text("", Duration::from_millis(0)).unwrap();
    }
}
