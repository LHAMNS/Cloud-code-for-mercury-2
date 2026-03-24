// Mercury Code - Agent Tab System (Rust port)
// Shows running sub-agents as navigable tabs with real-time status.
// Mirrors src/ui/agent-tabs.js (AgentTabBar).

use std::time::Instant;

use crate::colors::*;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_SPINNER: &[&str] = &["\u{25D0}", "\u{25D3}", "\u{25D1}", "\u{25D2}"]; // ◐ ◓ ◑ ◒

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

/// Status of an agent tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Waiting,
    Thinking,
    Tool,
    Compress,
    Done,
    Error,
}

impl AgentStatus {
    /// Return a short label for the status.
    pub fn label(&self) -> &'static str {
        match self {
            AgentStatus::Waiting   => "waiting",
            AgentStatus::Thinking  => "thinking",
            AgentStatus::Tool      => "tool",
            AgentStatus::Compress  => "compress",
            AgentStatus::Done      => "done",
            AgentStatus::Error     => "error",
        }
    }
}

/// Represents a single agent tab.
#[derive(Debug, Clone)]
pub struct Tab {
    /// Unique identifier for this tab.
    pub id: usize,
    /// Human-readable name / task description.
    pub name: String,
    /// Current status.
    pub status: AgentStatus,
    /// Agent type label (e.g. "SubAgent", "SearchAgent").
    pub agent_type: String,
    /// Detailed status text shown in the detail panel.
    pub status_text: String,
    /// Recent activity lines (max 8).
    pub activity: Vec<String>,
    /// Whether the detail panel is expanded.
    pub open: bool,
    /// Whether the agent has finished.
    pub done: bool,
    /// Whether the agent finished successfully.
    pub success: bool,
    /// Number of conversation turns.
    pub turns: usize,
    /// Number of tool calls made.
    pub tool_count: usize,
    /// When the agent was created.
    pub start_time: Instant,
}

impl Tab {
    /// Create a new tab with the given `id` and task description.
    pub fn new(id: usize, name: &str, agent_type: &str) -> Self {
        Self {
            id,
            name: name.to_string(),
            status: AgentStatus::Waiting,
            agent_type: agent_type.to_string(),
            status_text: "Initializing...".to_string(),
            activity: Vec::new(),
            open: false,
            done: false,
            success: false,
            turns: 0,
            tool_count: 0,
            start_time: Instant::now(),
        }
    }

    /// Elapsed seconds since this tab was created.
    pub fn elapsed_secs(&self) -> f64 {
        self.start_time.elapsed().as_secs_f64()
    }
}

// ---------------------------------------------------------------------------
// AgentTabManager
// ---------------------------------------------------------------------------

/// Manages a collection of agent tabs with selection and rendering.
pub struct AgentTabManager {
    tabs: Vec<Tab>,
    next_id: usize,
    selected_index: usize,
    focused: bool,
    spinner_frame: usize,
}

impl AgentTabManager {
    /// Create an empty tab manager.
    pub fn new() -> Self {
        Self {
            tabs: Vec::new(),
            next_id: 0,
            selected_index: 0,
            focused: false,
            spinner_frame: 0,
        }
    }

    /// Add a new agent tab.  Returns the tab index.
    pub fn add_tab(&mut self, name: &str, agent_type: &str) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        self.tabs.push(Tab::new(id, name, agent_type));
        self.tabs.len() - 1
    }

    /// Remove the tab at `index`.  Adjusts selected index as needed.
    pub fn remove_tab(&mut self, index: usize) -> Option<Tab> {
        if index >= self.tabs.len() {
            return None;
        }
        let removed = self.tabs.remove(index);
        if self.selected_index >= self.tabs.len() && !self.tabs.is_empty() {
            self.selected_index = self.tabs.len() - 1;
        }
        Some(removed)
    }

    /// Switch the active selection to `index`.
    pub fn switch_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            self.selected_index = index;
        }
    }

    /// Get a reference to the currently selected tab, if any.
    pub fn get_active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.selected_index)
    }

    /// Get a mutable reference to the tab at `index`.
    pub fn get_tab_mut(&mut self, index: usize) -> Option<&mut Tab> {
        self.tabs.get_mut(index)
    }

    /// Number of tabs.
    pub fn len(&self) -> usize {
        self.tabs.len()
    }

    /// Whether the tab list is empty.
    pub fn is_empty(&self) -> bool {
        self.tabs.is_empty()
    }

    /// Whether all agents are done.
    pub fn all_done(&self) -> bool {
        !self.tabs.is_empty() && self.tabs.iter().all(|t| t.done)
    }

    /// Whether the tab bar is currently focused for keyboard navigation.
    pub fn is_focused(&self) -> bool {
        self.focused
    }

    /// Set focus state.
    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
    }

    /// Advance the spinner animation by one frame.
    pub fn tick_spinner(&mut self) {
        self.spinner_frame = self.spinner_frame.wrapping_add(1);
    }

    /// Navigate selection left (wrapping).
    pub fn select_prev(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        self.selected_index = if self.selected_index == 0 {
            self.tabs.len() - 1
        } else {
            self.selected_index - 1
        };
    }

    /// Navigate selection right (wrapping).
    pub fn select_next(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        self.selected_index = (self.selected_index + 1) % self.tabs.len();
    }

    /// Toggle the open/closed state of the currently selected tab.
    pub fn toggle_selected(&mut self) {
        if let Some(tab) = self.tabs.get_mut(self.selected_index) {
            tab.open = !tab.open;
        }
    }

    // -- Event handlers (mirrors JS update / finish) ---------------------------

    /// Update a tab's status from an event.
    pub fn update(&mut self, index: usize, event: &str, detail: Option<&str>) {
        let tab = match self.tabs.get_mut(index) {
            Some(t) if !t.done => t,
            _ => return,
        };

        match event {
            "thinking" => {
                tab.status = AgentStatus::Thinking;
                tab.turns += 1;
                tab.status_text = format!("Thinking... (Turn {})", tab.turns);
            }
            "tool_call" => {
                tab.status = AgentStatus::Tool;
                tab.tool_count += 1;
                let d = detail.unwrap_or("tool");
                tab.status_text = detail.unwrap_or("Running tool...").to_string();
                tab.activity.push(format!("\u{251C}\u{2500} {d}"));
                if tab.activity.len() > 8 {
                    tab.activity.remove(0);
                }
            }
            "tool_result" => {
                tab.status_text = detail.unwrap_or("Processing...").to_string();
            }
            "compressing" => {
                tab.status = AgentStatus::Compress;
                tab.status_text = "Compressing context...".to_string();
                tab.activity.push("\u{251C}\u{2500} Context compression".to_string());
                if tab.activity.len() > 8 {
                    tab.activity.remove(0);
                }
            }
            _ => {}
        }
    }

    /// Mark a tab as finished.
    pub fn finish(&mut self, index: usize, success: bool, summary: Option<&str>) {
        let tab = match self.tabs.get_mut(index) {
            Some(t) => t,
            None => return,
        };
        tab.done = true;
        tab.success = success;
        tab.status = if success { AgentStatus::Done } else { AgentStatus::Error };
        let elapsed = format!("{:.1}", tab.elapsed_secs());

        if success {
            tab.status_text = format!(
                "Done ({} turns, {} tools, {}s)",
                tab.turns, tab.tool_count, elapsed,
            );
            tab.activity.push(format!(
                "\u{2514}\u{2500} {GREEN}\u{2713}{RESET} Completed in {elapsed}s"
            ));
        } else {
            tab.status_text = format!("Error ({elapsed}s)");
            let msg = summary.unwrap_or("Failed");
            let msg = if msg.len() > 60 { &msg[..60] } else { msg };
            tab.activity.push(format!(
                "\u{2514}\u{2500} {RED}\u{2717}{RESET} {msg}"
            ));
        }
    }

    // -- Rendering -------------------------------------------------------------

    /// Render the complete tab bar output as a vector of ANSI-styled lines.
    pub fn render_tab_bar(&self) -> Vec<String> {
        if self.tabs.is_empty() {
            return Vec::new();
        }

        let brand = brand_gradient();
        let mut lines = Vec::new();

        // Hint line
        if !self.focused && !self.all_done() {
            lines.push(format!("{GRAY}  Press \u{2193} to navigate agents{RESET}"));
        } else if self.focused {
            let c = &fg256(87);
            lines.push(format!(
                "{c}  \u{2190}/\u{2192} switch  Enter open/close  \u{2191}/Esc exit{RESET}"
            ));
        }

        // Tab bar line
        let tabs_str: Vec<String> = self.tabs.iter().enumerate()
            .map(|(i, _)| self.render_single_tab(i, &brand))
            .collect();

        let label = if self.focused {
            format!("{}{BOLD}  Agents{RESET} ", fg256(87))
        } else {
            format!("{GRAY}  Agents{RESET} ")
        };
        lines.push(format!("{label}{}", tabs_str.join(" ")));

        // Expanded detail panels
        let w = std::cmp::min(
            crossterm::terminal::size().map(|(w, _)| w as usize).unwrap_or(80).saturating_sub(2),
            80,
        );
        for (i, tab) in self.tabs.iter().enumerate() {
            if tab.open {
                lines.extend(self.render_detail(i, w, &brand));
            }
        }

        lines
    }

    /// Render a single tab chip, e.g. `[▸1: ◐ Search codebase...]`.
    fn render_single_tab(&self, index: usize, brand: &[String; 6]) -> String {
        let tab = &self.tabs[index];
        let is_selected = self.focused && index == self.selected_index;
        let num = index + 1;

        // Status icon
        let icon = if tab.done {
            if tab.success {
                format!("{GREEN}\u{2713}{RESET}")
            } else {
                format!("{RED}\u{2717}{RESET}")
            }
        } else {
            let frame = TAB_SPINNER[self.spinner_frame % TAB_SPINNER.len()];
            let color = &brand[self.spinner_frame % brand.len()];
            format!("{color}{frame}{RESET}")
        };

        // Short label (max 20 chars)
        let label = if tab.name.len() > 20 {
            format!("{}...", &tab.name[..17])
        } else {
            tab.name.clone()
        };

        let expand = if tab.open { "\u{25BE}" } else { "\u{25B8}" };

        if is_selected {
            format!("{}{BOLD}[{expand}{num}: {icon} {label}]{RESET}", fg256(87))
        } else {
            format!("{GRAY}[{expand}{num}: {icon} {label}]{RESET}")
        }
    }

    /// Render the expanded detail panel for a tab.
    fn render_detail(&self, index: usize, width: usize, brand: &[String; 6]) -> Vec<String> {
        let tab = &self.tabs[index];
        let inner = width.saturating_sub(6);
        let mut lines = Vec::new();

        // Border color
        let bc = if tab.done {
            if tab.success { GREEN.to_string() } else { RED.to_string() }
        } else {
            fg256(75)
        };

        // Title
        let title = if tab.name.len() > inner.saturating_sub(14) {
            format!("{}...", &tab.name[..inner.saturating_sub(17).min(tab.name.len())])
        } else {
            tab.name.clone()
        };
        let pad = inner.saturating_sub(title.len() + 10);
        lines.push(format!(
            "{bc}  \u{256D}\u{2500} Agent {}: {BOLD}{title}{RESET}{bc} {}\u{256E}{RESET}",
            index + 1,
            "\u{2500}".repeat(pad),
        ));

        // Status + elapsed
        let elapsed = format!("{:.1}", tab.elapsed_secs());
        let status_icon = if tab.done {
            if tab.success {
                format!("{GREEN}\u{2713}{RESET}")
            } else {
                format!("{RED}\u{2717}{RESET}")
            }
        } else {
            let frame = TAB_SPINNER[self.spinner_frame % TAB_SPINNER.len()];
            let color = &brand[self.spinner_frame % brand.len()];
            format!("{color}{frame}{RESET}")
        };
        lines.push(format!(
            "{bc}  \u{2502}{RESET} {status_icon} {} {GRAY}({elapsed}s){RESET}",
            tab.status_text,
        ));

        // Stats
        lines.push(format!(
            "{bc}  \u{2502}{RESET} {DIM}Turns: {}  Tools: {}{RESET}",
            tab.turns, tab.tool_count,
        ));

        // Activity log (last 5)
        let recent: Vec<&String> = tab.activity.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect();
        for act in recent {
            let truncated = if act.len() > inner {
                format!("{}...", &act[..inner.saturating_sub(3)])
            } else {
                act.clone()
            };
            lines.push(format!(
                "{bc}  \u{2502}{RESET}   {DIM}{truncated}{RESET}"
            ));
        }

        // Footer
        lines.push(format!(
            "{bc}  \u{2570}{}\u{256F}{RESET}",
            "\u{2500}".repeat(width.saturating_sub(4)),
        ));

        lines
    }

    /// Render a final compact summary of all agent results (non-interactive).
    pub fn render_summary(&self) -> Vec<String> {
        let term_w = crossterm::terminal::size()
            .map(|(w, _)| w as usize)
            .unwrap_or(80);
        let border_color = fg256(75);
        let dash_len = std::cmp::min(term_w.saturating_sub(28), 50);

        let mut lines = Vec::new();
        lines.push(String::new());
        lines.push(format!(
            "{border_color}  \u{250C}\u{2500} {BOLD}Sub-Agent Results{RESET}{border_color} {}{RESET}",
            "\u{2500}".repeat(dash_len),
        ));

        for (i, tab) in self.tabs.iter().enumerate() {
            let icon = if tab.done {
                if tab.success {
                    format!("{GREEN}\u{2713}{RESET}")
                } else {
                    format!("{RED}\u{2717}{RESET}")
                }
            } else {
                format!("{YELLOW}?{RESET}")
            };

            let elapsed = format!("{:.1}", tab.elapsed_secs());
            let label = if tab.name.len() > 45 {
                format!("{}...", &tab.name[..42])
            } else {
                tab.name.clone()
            };

            lines.push(format!(
                "{border_color}  \u{2502}{RESET} {icon} {BOLD}{}.{RESET} {label} {GRAY}({elapsed}s, {}t){RESET}",
                i + 1,
                tab.turns,
            ));
        }

        let footer_len = std::cmp::min(term_w.saturating_sub(4), 68);
        lines.push(format!(
            "{border_color}  \u{2514}{}{RESET}",
            "\u{2500}".repeat(footer_len),
        ));

        lines
    }
}

impl Default for AgentTabManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Status indicator helpers
// ---------------------------------------------------------------------------

/// Return a status indicator string with icon and color for the given status.
pub fn status_indicator(status: AgentStatus, spinner_frame: usize) -> String {
    let brand = brand_gradient();
    match status {
        AgentStatus::Done => format!("{GREEN}\u{2713}{RESET}"),
        AgentStatus::Error => format!("{RED}\u{2717}{RESET}"),
        AgentStatus::Waiting => format!("{GRAY}\u{25CB}{RESET}"),
        AgentStatus::Thinking => {
            let color = &brand[spinner_frame % brand.len()];
            let frame = TAB_SPINNER[spinner_frame % TAB_SPINNER.len()];
            format!("{color}{frame}{RESET}")
        }
        AgentStatus::Tool => {
            let color = &fg256(214);
            format!("{color}\u{26A1}{RESET}")
        }
        AgentStatus::Compress => {
            format!("{YELLOW}\u{25D1}{RESET}")
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_get_tab() {
        let mut mgr = AgentTabManager::new();
        let idx = mgr.add_tab("Search codebase", "SubAgent");
        assert_eq!(idx, 0);
        assert_eq!(mgr.len(), 1);

        let tab = mgr.get_active_tab().unwrap();
        assert_eq!(tab.name, "Search codebase");
        assert_eq!(tab.agent_type, "SubAgent");
        assert_eq!(tab.status, AgentStatus::Waiting);
    }

    #[test]
    fn test_add_multiple_tabs() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task A", "Agent");
        mgr.add_tab("Task B", "Agent");
        mgr.add_tab("Task C", "Agent");
        assert_eq!(mgr.len(), 3);
    }

    #[test]
    fn test_remove_tab() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("A", "Agent");
        mgr.add_tab("B", "Agent");
        let removed = mgr.remove_tab(0).unwrap();
        assert_eq!(removed.name, "A");
        assert_eq!(mgr.len(), 1);
        assert_eq!(mgr.get_active_tab().unwrap().name, "B");
    }

    #[test]
    fn test_remove_nonexistent() {
        let mut mgr = AgentTabManager::new();
        assert!(mgr.remove_tab(5).is_none());
    }

    #[test]
    fn test_switch_tab() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("A", "Agent");
        mgr.add_tab("B", "Agent");
        mgr.switch_tab(1);
        assert_eq!(mgr.get_active_tab().unwrap().name, "B");
    }

    #[test]
    fn test_switch_out_of_bounds() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("A", "Agent");
        mgr.switch_tab(99); // should not panic
        assert_eq!(mgr.get_active_tab().unwrap().name, "A");
    }

    #[test]
    fn test_select_prev_next() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("A", "Agent");
        mgr.add_tab("B", "Agent");
        mgr.add_tab("C", "Agent");

        mgr.select_next();
        assert_eq!(mgr.get_active_tab().unwrap().name, "B");
        mgr.select_next();
        assert_eq!(mgr.get_active_tab().unwrap().name, "C");
        mgr.select_next(); // wraps
        assert_eq!(mgr.get_active_tab().unwrap().name, "A");

        mgr.select_prev(); // wraps
        assert_eq!(mgr.get_active_tab().unwrap().name, "C");
    }

    #[test]
    fn test_update_thinking() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        mgr.update(0, "thinking", None);
        let tab = mgr.get_active_tab().unwrap();
        assert_eq!(tab.status, AgentStatus::Thinking);
        assert_eq!(tab.turns, 1);
    }

    #[test]
    fn test_update_tool_call() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        mgr.update(0, "tool_call", Some("Read file.rs"));
        let tab = mgr.get_active_tab().unwrap();
        assert_eq!(tab.status, AgentStatus::Tool);
        assert_eq!(tab.tool_count, 1);
        assert!(!tab.activity.is_empty());
    }

    #[test]
    fn test_finish_success() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        mgr.update(0, "thinking", None);
        mgr.finish(0, true, None);
        let tab = mgr.get_active_tab().unwrap();
        assert!(tab.done);
        assert!(tab.success);
        assert_eq!(tab.status, AgentStatus::Done);
    }

    #[test]
    fn test_finish_error() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        mgr.finish(0, false, Some("Network error"));
        let tab = mgr.get_active_tab().unwrap();
        assert!(tab.done);
        assert!(!tab.success);
        assert_eq!(tab.status, AgentStatus::Error);
    }

    #[test]
    fn test_all_done() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("A", "Agent");
        mgr.add_tab("B", "Agent");
        assert!(!mgr.all_done());
        mgr.finish(0, true, None);
        assert!(!mgr.all_done());
        mgr.finish(1, true, None);
        assert!(mgr.all_done());
    }

    #[test]
    fn test_all_done_empty() {
        let mgr = AgentTabManager::new();
        assert!(!mgr.all_done()); // empty is not "all done"
    }

    #[test]
    fn test_render_tab_bar_empty() {
        let mgr = AgentTabManager::new();
        assert!(mgr.render_tab_bar().is_empty());
    }

    #[test]
    fn test_render_tab_bar_with_tabs() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Search bugs", "SubAgent");
        mgr.add_tab("Audit code", "SubAgent");
        let lines = mgr.render_tab_bar();
        assert!(lines.len() >= 2); // hint + tab bar at minimum
        // Tab bar should contain "Agents"
        assert!(lines.iter().any(|l| l.contains("Agents")));
    }

    #[test]
    fn test_render_tab_bar_with_open_detail() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Search bugs", "SubAgent");
        mgr.get_tab_mut(0).unwrap().open = true;
        let lines = mgr.render_tab_bar();
        // Should include detail panel lines (╭ ... ╯)
        assert!(lines.iter().any(|l| l.contains("\u{256D}"))); // ╭
    }

    #[test]
    fn test_render_summary() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task A", "Agent");
        mgr.add_tab("Task B", "Agent");
        mgr.finish(0, true, None);
        mgr.finish(1, false, Some("Failed"));
        let lines = mgr.render_summary();
        assert!(lines.iter().any(|l| l.contains("Sub-Agent Results")));
        assert!(lines.iter().any(|l| l.contains("Task A")));
        assert!(lines.iter().any(|l| l.contains("Task B")));
    }

    #[test]
    fn test_toggle_selected() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        assert!(!mgr.get_active_tab().unwrap().open);
        mgr.toggle_selected();
        assert!(mgr.get_active_tab().unwrap().open);
        mgr.toggle_selected();
        assert!(!mgr.get_active_tab().unwrap().open);
    }

    #[test]
    fn test_status_indicator_done() {
        let s = status_indicator(AgentStatus::Done, 0);
        assert!(s.contains("\u{2713}")); // ✓
    }

    #[test]
    fn test_status_indicator_error() {
        let s = status_indicator(AgentStatus::Error, 0);
        assert!(s.contains("\u{2717}")); // ✗
    }

    #[test]
    fn test_status_indicator_thinking() {
        let s = status_indicator(AgentStatus::Thinking, 0);
        // Should contain one of the spinner frames
        assert!(s.contains('\u{25D0}') || s.contains('\u{25D3}'));
    }

    #[test]
    fn test_agent_status_label() {
        assert_eq!(AgentStatus::Waiting.label(), "waiting");
        assert_eq!(AgentStatus::Done.label(), "done");
        assert_eq!(AgentStatus::Error.label(), "error");
    }

    #[test]
    fn test_tab_elapsed() {
        let tab = Tab::new(0, "test", "Agent");
        // elapsed should be very small (< 1 second)
        assert!(tab.elapsed_secs() < 1.0);
    }

    #[test]
    fn test_focus_state() {
        let mut mgr = AgentTabManager::new();
        assert!(!mgr.is_focused());
        mgr.set_focused(true);
        assert!(mgr.is_focused());
    }

    #[test]
    fn test_activity_capped_at_8() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        for i in 0..12 {
            mgr.update(0, "tool_call", Some(&format!("tool_{i}")));
        }
        let tab = mgr.get_active_tab().unwrap();
        assert!(tab.activity.len() <= 8);
    }

    #[test]
    fn test_update_after_done_is_noop() {
        let mut mgr = AgentTabManager::new();
        mgr.add_tab("Task", "Agent");
        mgr.finish(0, true, None);
        mgr.update(0, "thinking", None);
        // Turns should still be 0 since update was after finish
        assert_eq!(mgr.get_active_tab().unwrap().turns, 0);
    }
}
