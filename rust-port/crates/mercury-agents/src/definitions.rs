// Mercury Code - Agent Definitions (Rust port)
// Supports user-defined agents via markdown files with YAML frontmatter
// in .mercury/agents/ (project) or ~/.mercury/agents/ (global).
// Also provides built-in agent types mirroring Claude Code's architecture.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::debug;

// ── Built-in agent types ─────────────────────────────────────────────────────

/// Agent type enumeration for built-in agents.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentType {
    Explore,
    Plan,
    GeneralPurpose,
    Custom(String),
}

impl std::fmt::Display for AgentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentType::Explore => write!(f, "explore"),
            AgentType::Plan => write!(f, "plan"),
            AgentType::GeneralPurpose => write!(f, "general-purpose"),
            AgentType::Custom(name) => write!(f, "{}", name),
        }
    }
}

/// Valid permission modes for agent definitions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Open,
    AiSafetyDecide,
    AcceptEdits,
    Approval,
    DontAsk,
    Readonly,
}

impl PermissionMode {
    /// Parse a permission mode string, returning None for invalid modes.
    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "open" => Some(PermissionMode::Open),
            "aiSafetyDecide" => Some(PermissionMode::AiSafetyDecide),
            "acceptEdits" => Some(PermissionMode::AcceptEdits),
            "approval" => Some(PermissionMode::Approval),
            "dontAsk" => Some(PermissionMode::DontAsk),
            "readonly" => Some(PermissionMode::Readonly),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::Open => "open",
            PermissionMode::AiSafetyDecide => "aiSafetyDecide",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Approval => "approval",
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::Readonly => "readonly",
        }
    }
}

/// A single agent definition (built-in or user-defined).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub system_prompt: Option<String>,
    /// Allowlist of tool names. None means "all tools".
    pub tools: Option<Vec<String>>,
    /// Denylist of tool names.
    pub disallowed_tools: Vec<String>,
    /// Model override. None means inherit from parent.
    pub model: Option<String>,
    pub max_turns: u32,
    pub permission_mode: Option<PermissionMode>,
    pub background: bool,
    /// Isolation mode: "worktree" or None.
    pub isolation: Option<String>,
    pub builtin: bool,
    /// Source file path for custom agents.
    pub source: Option<PathBuf>,
}

impl AgentDefinition {
    /// Create a new agent definition with default values.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: String::new(),
            system_prompt: None,
            tools: None,
            disallowed_tools: Vec::new(),
            model: None,
            max_turns: 30,
            permission_mode: None,
            background: false,
            isolation: None,
            builtin: false,
            source: None,
        }
    }
}

// ── Tool definition representation ───────────────────────────────────────────

/// Minimal tool definition for filtering purposes.
/// Mirrors the shape of tool definitions from mercury-tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The full tool definition as JSON (for API calls).
    #[serde(default)]
    pub schema: serde_json::Value,
}

// ── Tools that sub-agents are never allowed to use ───────────────────────────

/// Tools blocked from sub-agents to prevent recursion and resource exhaustion.
pub static ALWAYS_BLOCKED_TOOLS: &[&str] = &[
    "SubAgent",
    "SubAgentTeam",
    "ContextSearch",
    "AgentTeams",
];

/// Read-only tools for readonly mode enforcement.
pub static READ_TOOLS: &[&str] = &[
    "Read", "Glob", "Grep", "ListDir", "Diff", "Fetch", "AstSearch", "Lsp",
];

// ── Built-in agent definitions ───────────────────────────────────────────────

/// Return the built-in agent definitions.
pub fn builtin_agents() -> HashMap<String, AgentDefinition> {
    let mut agents = HashMap::new();

    agents.insert(
        "explore".to_string(),
        AgentDefinition {
            name: "explore".to_string(),
            description: "Fast agent for exploring codebases. Use for finding files, searching code, \
                or answering questions about the codebase. Specify thoroughness: quick, medium, very thorough."
                .to_string(),
            system_prompt: Some(
                "You are an Explore agent \u{2014} a fast, read-only codebase explorer.\n\n\
                Your job is to quickly find files, search for code patterns, and understand project structure.\n\
                You have READ-ONLY access: Read, Glob, Grep, ListDir, Diff, AstSearch, Lsp.\n\n\
                Be thorough in your search but concise in your response. Return what was found, \
                not lengthy explanations. Include file paths and line numbers.\n"
                    .to_string(),
            ),
            tools: Some(vec![
                "Read".into(), "Glob".into(), "Grep".into(), "ListDir".into(),
                "Diff".into(), "Fetch".into(), "AstSearch".into(), "Lsp".into(),
            ]),
            disallowed_tools: Vec::new(),
            model: None,
            max_turns: 20,
            builtin: true,
            permission_mode: None,
            background: false,
            isolation: None,
            source: None,
        },
    );

    agents.insert(
        "plan".to_string(),
        AgentDefinition {
            name: "plan".to_string(),
            description: "Software architect agent for designing implementation plans. \
                Researches the codebase, identifies critical files, and returns step-by-step plans."
                .to_string(),
            system_prompt: Some(
                "You are a Plan agent \u{2014} a software architect that researches and designs implementation plans.\n\n\
                Your job is to:\n\
                1. Research the codebase to understand existing architecture\n\
                2. Identify critical files and dependencies\n\
                3. Design a step-by-step implementation plan\n\
                4. Consider edge cases and trade-offs\n\n\
                You have READ-ONLY access. Return a clear, actionable plan \u{2014} not code.\n"
                    .to_string(),
            ),
            tools: Some(vec![
                "Read".into(), "Glob".into(), "Grep".into(), "ListDir".into(),
                "Diff".into(), "AstSearch".into(), "Lsp".into(),
            ]),
            disallowed_tools: Vec::new(),
            model: None,
            max_turns: 25,
            builtin: true,
            permission_mode: None,
            background: false,
            isolation: None,
            source: None,
        },
    );

    agents.insert(
        "general-purpose".to_string(),
        AgentDefinition {
            name: "general-purpose".to_string(),
            description: "General-purpose agent for researching complex questions, searching for code, \
                and executing multi-step tasks. Has full tool access."
                .to_string(),
            system_prompt: Some(
                "You are a general-purpose sub-agent. Complete the assigned task autonomously.\n\
                You have access to all tools including Read, Write, Edit, Bash, Glob, Grep.\n\
                Be thorough and return exactly what was requested.\n"
                    .to_string(),
            ),
            tools: None, // all tools (minus SubAgent/SubAgentTeam/ContextSearch)
            disallowed_tools: Vec::new(),
            model: None,
            max_turns: 30,
            builtin: true,
            permission_mode: None,
            background: false,
            isolation: None,
            source: None,
        },
    );

    agents
}

// ── YAML frontmatter parser (lightweight, zero-dep) ──────────────────────────

/// Parsed frontmatter from a markdown agent definition file.
#[derive(Debug, Default)]
struct Frontmatter {
    fields: HashMap<String, FrontmatterValue>,
}

#[derive(Debug, Clone)]
enum FrontmatterValue {
    String(String),
    Bool(bool),
    Int(i64),
    Array(Vec<String>),
}

impl FrontmatterValue {
    fn as_str(&self) -> Option<&str> {
        match self {
            FrontmatterValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            FrontmatterValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn as_int(&self) -> Option<i64> {
        match self {
            FrontmatterValue::Int(i) => Some(*i),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[String]> {
        match self {
            FrontmatterValue::Array(a) => Some(a.as_slice()),
            _ => None,
        }
    }
}

/// Parse simple YAML frontmatter from a markdown string.
/// Supports: strings, numbers, booleans, arrays (single-line [...] or multi-line - items).
fn parse_frontmatter(content: &str) -> (Frontmatter, String) {
    // Match ---\n...\n---\n
    let Some(rest) = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n")) else {
        return (Frontmatter::default(), content.to_string());
    };

    let Some(end_idx) = rest.find("\n---\n").or_else(|| rest.find("\n---\r\n")) else {
        return (Frontmatter::default(), content.to_string());
    };

    let yaml_str = &rest[..end_idx];
    let body_start = end_idx + if rest[end_idx..].starts_with("\n---\r\n") { 6 } else { 5 };
    let body = &rest[body_start..];

    let mut fm = Frontmatter {
        fields: HashMap::new(),
    };

    let lines: Vec<&str> = yaml_str.lines().collect();
    let mut current_key: Option<String> = None;
    let mut current_array: Option<Vec<String>> = None;

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Array item (- value)
        if trimmed.starts_with("- ") {
            if let (Some(ref key), Some(ref mut arr)) = (&current_key, &mut current_array) {
                let val = trimmed[2..].trim();
                let val = strip_quotes(val);
                arr.push(val.to_string());
                fm.fields.insert(
                    key.clone(),
                    FrontmatterValue::Array(arr.clone()),
                );
                continue;
            }
        }

        // Key: value
        if let Some(colon_pos) = trimmed.find(':') {
            let key_part = &trimmed[..colon_pos];
            // Validate key is word characters and hyphens
            if key_part.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') && !key_part.is_empty() {
                let val_part = trimmed[colon_pos + 1..].trim();

                // Inline array: [a, b, c]
                if val_part.starts_with('[') && val_part.ends_with(']') {
                    let inner = &val_part[1..val_part.len() - 1];
                    let items: Vec<String> = inner
                        .split(',')
                        .map(|s| strip_quotes(s.trim()).to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    fm.fields
                        .insert(key_part.to_string(), FrontmatterValue::Array(items));
                    current_key = None;
                    current_array = None;
                    continue;
                }

                // Empty value (start of multi-line array)
                if val_part.is_empty() {
                    current_key = Some(key_part.to_string());
                    current_array = Some(Vec::new());
                    fm.fields.insert(
                        key_part.to_string(),
                        FrontmatterValue::Array(Vec::new()),
                    );
                    continue;
                }

                // Boolean
                if val_part == "true" {
                    fm.fields
                        .insert(key_part.to_string(), FrontmatterValue::Bool(true));
                } else if val_part == "false" {
                    fm.fields
                        .insert(key_part.to_string(), FrontmatterValue::Bool(false));
                }
                // Number
                else if val_part.chars().all(|c| c.is_ascii_digit()) && !val_part.is_empty() {
                    if let Ok(n) = val_part.parse::<i64>() {
                        fm.fields
                            .insert(key_part.to_string(), FrontmatterValue::Int(n));
                    } else {
                        fm.fields.insert(
                            key_part.to_string(),
                            FrontmatterValue::String(val_part.to_string()),
                        );
                    }
                }
                // String (strip quotes)
                else {
                    let val = strip_quotes(val_part);
                    fm.fields.insert(
                        key_part.to_string(),
                        FrontmatterValue::String(val.to_string()),
                    );
                }

                current_key = None;
                current_array = None;
            }
        }
    }

    (fm, body.to_string())
}

/// Strip surrounding single or double quotes from a string.
fn strip_quotes(s: &str) -> &str {
    if (s.starts_with('\'') && s.ends_with('\'')) || (s.starts_with('"') && s.ends_with('"')) {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

// ── Agent definition loading ─────────────────────────────────────────────────

/// Sanitize an agent name: only allow alphanumeric, underscores, and hyphens.
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Load a single agent definition from a markdown file's content.
pub fn load_agent_from_markdown(content: &str, file_path: &Path) -> AgentDefinition {
    let (fm, body) = parse_frontmatter(content);

    let name = fm
        .fields
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| sanitize_name(s))
        .unwrap_or_else(|| {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| sanitize_name(s))
                .unwrap_or_else(|| "unnamed".to_string())
        });

    let description = fm
        .fields
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Custom agent: {}", name));

    let tools = fm
        .fields
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|a| a.to_vec());

    let disallowed_tools = fm
        .fields
        .get("disallowedTools")
        .and_then(|v| v.as_array())
        .map(|a| a.to_vec())
        .unwrap_or_default();

    let model = fm
        .fields
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let max_turns = fm
        .fields
        .get("maxTurns")
        .and_then(|v| v.as_int())
        .unwrap_or(30) as u32;

    let permission_mode = fm
        .fields
        .get("permissionMode")
        .and_then(|v| v.as_str())
        .and_then(PermissionMode::from_str_opt);

    let background = fm
        .fields
        .get("background")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let isolation = fm
        .fields
        .get("isolation")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let system_prompt = {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };

    AgentDefinition {
        name,
        description,
        system_prompt,
        tools,
        disallowed_tools,
        model,
        max_turns,
        permission_mode,
        background,
        isolation,
        builtin: false,
        source: Some(file_path.to_path_buf()),
    }
}

/// Discover all user-defined agent definitions from project and global dirs.
/// Project agents override global agents with the same name.
/// Built-in agents cannot be overridden.
pub async fn discover_agents(workspace: &Path) -> HashMap<String, AgentDefinition> {
    let mut agents = builtin_agents();

    // Save builtin names to protect them from override
    let builtin_names: HashSet<String> = agents.keys().cloned().collect();

    // Load global agents from ~/.mercury/agents/
    if let Some(home) = dirs::home_dir() {
        let global_dir = home.join(".mercury").join("agents");
        load_agents_from_dir(&global_dir, &mut agents).await;
    }

    // Load project agents from .mercury/agents/ (overrides global)
    let project_dir = workspace.join(".mercury").join("agents");
    load_agents_from_dir(&project_dir, &mut agents).await;

    // Protect built-in agent names from being overridden
    let builtins = builtin_agents();
    for name in &builtin_names {
        if let Some(def) = builtins.get(name) {
            agents.insert(name.clone(), def.clone());
        }
    }

    agents
}

/// Load agent .md files from a directory into the agents map.
async fn load_agents_from_dir(dir_path: &Path, agents: &mut HashMap<String, AgentDefinition>) {
    let entries = match tokio::fs::read_dir(dir_path).await {
        Ok(entries) => entries,
        Err(_) => return, // dir doesn't exist, OK
    };

    let mut entries = entries;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        match tokio::fs::read_to_string(&path).await {
            Ok(content) => {
                let def = load_agent_from_markdown(&content, &path);
                agents.insert(def.name.clone(), def);
            }
            Err(e) => {
                debug!("Failed to read agent file {:?}: {}", path, e);
            }
        }
    }
}

/// Resolve which tools an agent is allowed to use.
/// Returns the filtered list of tool definitions.
///
/// # Arguments
/// * `agent_def` - Agent definition
/// * `all_tools` - All available tool definitions
/// * `trust_mode` - Current trust mode (e.g., "readonly", "approval", "open")
pub fn resolve_agent_tools(
    agent_def: &AgentDefinition,
    all_tools: &[ToolDefinition],
    trust_mode: &str,
) -> Vec<ToolDefinition> {
    let blocked: HashSet<&str> = ALWAYS_BLOCKED_TOOLS.iter().copied().collect();

    // Start with all tools minus recursion-blockers
    let mut tools: Vec<ToolDefinition> = all_tools
        .iter()
        .filter(|t| !blocked.contains(t.name.as_str()))
        .cloned()
        .collect();

    // Apply allowlist if specified
    if let Some(ref allow_list) = agent_def.tools {
        let allow_set: HashSet<&str> = allow_list.iter().map(|s| s.as_str()).collect();
        tools.retain(|t| allow_set.contains(t.name.as_str()));
    }

    // Apply denylist
    if !agent_def.disallowed_tools.is_empty() {
        let deny_set: HashSet<&str> =
            agent_def.disallowed_tools.iter().map(|s| s.as_str()).collect();
        tools.retain(|t| !deny_set.contains(t.name.as_str()));
    }

    // Enforce readonly mode
    if trust_mode == "readonly" {
        let read_set: HashSet<&str> = READ_TOOLS.iter().copied().collect();
        tools.retain(|t| read_set.contains(t.name.as_str()));
    }

    tools
}

/// Find the best matching agent for a task description.
/// Uses keyword matching against agent descriptions.
pub fn match_agent_for_task(
    agents: &HashMap<String, AgentDefinition>,
    task: &str,
) -> Option<AgentDefinition> {
    let lower = task.to_lowercase();

    // Heuristic keyword matching for explore
    let explore_pattern = regex::Regex::new(
        r"\b(explore|search|find|locate|look\s+for|grep|glob)\b",
    )
    .ok();
    if let Some(ref pat) = explore_pattern {
        if pat.is_match(&lower) {
            if let Some(explore) = agents.get("explore") {
                return Some(explore.clone());
            }
        }
    }

    // Heuristic keyword matching for plan
    let plan_pattern =
        regex::Regex::new(r"\b(plan|design|architect|strategy|approach)\b").ok();
    if let Some(ref pat) = plan_pattern {
        if pat.is_match(&lower) {
            if let Some(plan) = agents.get("plan") {
                return Some(plan.clone());
            }
        }
    }

    // Check custom agents by description keywords
    let stop_words: HashSet<&str> = [
        "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "is", "it", "this",
        "that", "with",
    ]
    .into_iter()
    .collect();

    for def in agents.values() {
        if def.builtin {
            continue;
        }
        let desc_words: Vec<&str> = def.description.to_lowercase().split_whitespace().collect();
        // We need owned strings for comparison since desc_words borrows a temporary
        let desc_lower = def.description.to_lowercase();
        let desc_words: Vec<&str> = desc_lower.split_whitespace().collect();
        let task_words: Vec<&str> = lower
            .split_whitespace()
            .filter(|w| w.len() > 2 && !stop_words.contains(w))
            .collect();
        let overlap = task_words
            .iter()
            .filter(|w| desc_words.contains(w))
            .count();
        if overlap >= 4 {
            return Some(def.clone());
        }
    }

    // Default to general-purpose
    agents.get("general-purpose").cloned()
}

/// Format agent definitions for display.
pub fn format_agent_list(agents: &HashMap<String, AgentDefinition>) -> String {
    let mut lines = vec![format!("Available agents ({}):\n", agents.len())];

    let mut builtins: Vec<&AgentDefinition> = Vec::new();
    let mut custom: Vec<&AgentDefinition> = Vec::new();
    for def in agents.values() {
        if def.builtin {
            builtins.push(def);
        } else {
            custom.push(def);
        }
    }

    // Sort for deterministic output
    builtins.sort_by(|a, b| a.name.cmp(&b.name));
    custom.sort_by(|a, b| a.name.cmp(&b.name));

    if !builtins.is_empty() {
        lines.push("  Built-in:".to_string());
        for def in &builtins {
            let tools = def
                .tools
                .as_ref()
                .map(|t| t.join(", "))
                .unwrap_or_else(|| "all".to_string());
            let model = def
                .model
                .as_deref()
                .unwrap_or("inherit");
            lines.push(format!(
                "    {:<20} model: {:<10} tools: {}",
                def.name, model, tools
            ));
            lines.push(format!("    {:<20} {}", "", def.description));
        }
    }

    if !custom.is_empty() {
        lines.push(String::new());
        lines.push("  Custom:".to_string());
        for def in &custom {
            let tools = def
                .tools
                .as_ref()
                .map(|t| t.join(", "))
                .unwrap_or_else(|| "all".to_string());
            let model = def
                .model
                .as_deref()
                .unwrap_or("inherit");
            lines.push(format!(
                "    {:<20} model: {:<10} tools: {}",
                def.name, model, tools
            ));
            lines.push(format!("    {:<20} {}", "", def.description));
            if let Some(ref source) = def.source {
                lines.push(format!("    {:<20} source: {}", "", source.display()));
            }
        }
    }

    lines.join("\n")
}

/// Scaffold a new agent markdown file in the project's .mercury/agents/ directory.
/// Returns the path to the created file.
pub async fn scaffold_agent(
    workspace: &Path,
    name: &str,
    description: Option<&str>,
) -> anyhow::Result<PathBuf> {
    let agent_dir = workspace.join(".mercury").join("agents");
    tokio::fs::create_dir_all(&agent_dir).await?;

    let file_path = agent_dir.join(format!("{}.md", sanitize_name(name)));

    let desc = description.unwrap_or("Describe when to use this agent");
    let content = format!(
        "---\n\
         name: {name}\n\
         description: {desc}\n\
         tools: [Read, Write, Edit, Bash, Glob, Grep, ListDir, Diff]\n\
         maxTurns: 30\n\
         ---\n\
         \n\
         You are a custom sub-agent named \"{name}\".\n\
         \n\
         Your job is to complete the assigned task autonomously.\n\
         Be thorough but concise. Return relevant findings or results.\n",
    );

    tokio::fs::write(&file_path, content).await?;
    Ok(file_path)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_agents() {
        let agents = builtin_agents();
        assert!(agents.contains_key("explore"));
        assert!(agents.contains_key("plan"));
        assert!(agents.contains_key("general-purpose"));
        assert_eq!(agents.len(), 3);

        let explore = &agents["explore"];
        assert!(explore.builtin);
        assert_eq!(explore.max_turns, 20);
        assert!(explore.tools.is_some());
    }

    #[test]
    fn test_parse_frontmatter_basic() {
        let content = "---\nname: test-agent\ndescription: A test agent\nmaxTurns: 15\n---\nSystem prompt here.\n";
        let (fm, body) = parse_frontmatter(content);
        assert_eq!(fm.fields.get("name").unwrap().as_str(), Some("test-agent"));
        assert_eq!(
            fm.fields.get("description").unwrap().as_str(),
            Some("A test agent")
        );
        assert_eq!(fm.fields.get("maxTurns").unwrap().as_int(), Some(15));
        assert_eq!(body.trim(), "System prompt here.");
    }

    #[test]
    fn test_parse_frontmatter_inline_array() {
        let content = "---\ntools: [Read, Write, Edit]\n---\nBody\n";
        let (fm, _body) = parse_frontmatter(content);
        let tools = fm.fields.get("tools").unwrap().as_array().unwrap();
        assert_eq!(tools, &["Read", "Write", "Edit"]);
    }

    #[test]
    fn test_parse_frontmatter_multiline_array() {
        let content = "---\ntools:\n- Read\n- Write\n- Edit\n---\nBody\n";
        let (fm, _body) = parse_frontmatter(content);
        let tools = fm.fields.get("tools").unwrap().as_array().unwrap();
        assert_eq!(tools, &["Read", "Write", "Edit"]);
    }

    #[test]
    fn test_parse_frontmatter_booleans() {
        let content = "---\nbackground: true\nisolation: false\n---\n\n";
        let (fm, _body) = parse_frontmatter(content);
        assert_eq!(fm.fields.get("background").unwrap().as_bool(), Some(true));
        assert_eq!(fm.fields.get("isolation").unwrap().as_bool(), Some(false));
    }

    #[test]
    fn test_parse_frontmatter_no_frontmatter() {
        let content = "Just a regular markdown file.";
        let (fm, body) = parse_frontmatter(content);
        assert!(fm.fields.is_empty());
        assert_eq!(body, content);
    }

    #[test]
    fn test_load_agent_from_markdown() {
        let content = "---\nname: my-agent\ndescription: Custom helper\ntools: [Read, Grep]\nmaxTurns: 10\nbackground: true\n---\nYou are my-agent.\n";
        let path = PathBuf::from("/test/agents/my-agent.md");
        let def = load_agent_from_markdown(content, &path);
        assert_eq!(def.name, "my-agent");
        assert_eq!(def.description, "Custom helper");
        assert_eq!(def.tools.as_ref().unwrap(), &["Read", "Grep"]);
        assert_eq!(def.max_turns, 10);
        assert!(def.background);
        assert!(!def.builtin);
        assert_eq!(def.system_prompt.as_deref(), Some("You are my-agent."));
    }

    #[test]
    fn test_load_agent_name_sanitization() {
        let content = "---\nname: ../evil/path\n---\n\n";
        let path = PathBuf::from("/test/agents/evil.md");
        let def = load_agent_from_markdown(content, &path);
        assert_eq!(def.name, "__evil_path"); // sanitized
    }

    #[test]
    fn test_sanitize_name() {
        assert_eq!(sanitize_name("good-name_123"), "good-name_123");
        assert_eq!(sanitize_name("../evil/path"), "__evil_path");
        assert_eq!(sanitize_name("spaces here"), "spaces_here");
    }

    #[test]
    fn test_resolve_agent_tools_basic() {
        let all_tools = vec![
            ToolDefinition { name: "Read".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Write".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Grep".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "SubAgent".into(), description: String::new(), schema: serde_json::Value::Null },
        ];

        let def = AgentDefinition::new("test");
        let resolved = resolve_agent_tools(&def, &all_tools, "open");
        assert_eq!(resolved.len(), 3); // SubAgent blocked
        assert!(resolved.iter().all(|t| t.name != "SubAgent"));
    }

    #[test]
    fn test_resolve_agent_tools_allowlist() {
        let all_tools = vec![
            ToolDefinition { name: "Read".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Write".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Grep".into(), description: String::new(), schema: serde_json::Value::Null },
        ];

        let mut def = AgentDefinition::new("test");
        def.tools = Some(vec!["Read".into(), "Grep".into()]);
        let resolved = resolve_agent_tools(&def, &all_tools, "open");
        assert_eq!(resolved.len(), 2);
        let names: Vec<&str> = resolved.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"Read"));
        assert!(names.contains(&"Grep"));
    }

    #[test]
    fn test_resolve_agent_tools_denylist() {
        let all_tools = vec![
            ToolDefinition { name: "Read".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Write".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Grep".into(), description: String::new(), schema: serde_json::Value::Null },
        ];

        let mut def = AgentDefinition::new("test");
        def.disallowed_tools = vec!["Write".into()];
        let resolved = resolve_agent_tools(&def, &all_tools, "open");
        assert_eq!(resolved.len(), 2);
        assert!(resolved.iter().all(|t| t.name != "Write"));
    }

    #[test]
    fn test_resolve_agent_tools_readonly() {
        let all_tools = vec![
            ToolDefinition { name: "Read".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Write".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Bash".into(), description: String::new(), schema: serde_json::Value::Null },
            ToolDefinition { name: "Grep".into(), description: String::new(), schema: serde_json::Value::Null },
        ];

        let def = AgentDefinition::new("test");
        let resolved = resolve_agent_tools(&def, &all_tools, "readonly");
        let names: Vec<&str> = resolved.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"Read"));
        assert!(names.contains(&"Grep"));
        assert!(!names.contains(&"Write"));
        assert!(!names.contains(&"Bash"));
    }

    #[test]
    fn test_match_agent_explore() {
        let agents = builtin_agents();
        let result = match_agent_for_task(&agents, "explore the codebase for config files");
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "explore");
    }

    #[test]
    fn test_match_agent_plan() {
        let agents = builtin_agents();
        let result = match_agent_for_task(&agents, "plan the implementation of a new feature");
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "plan");
    }

    #[test]
    fn test_match_agent_default() {
        let agents = builtin_agents();
        let result = match_agent_for_task(&agents, "do something random");
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "general-purpose");
    }

    #[test]
    fn test_format_agent_list() {
        let agents = builtin_agents();
        let output = format_agent_list(&agents);
        assert!(output.contains("Available agents (3):"));
        assert!(output.contains("Built-in:"));
        assert!(output.contains("explore"));
        assert!(output.contains("plan"));
        assert!(output.contains("general-purpose"));
    }

    #[test]
    fn test_permission_mode_roundtrip() {
        let modes = ["open", "aiSafetyDecide", "acceptEdits", "approval", "dontAsk", "readonly"];
        for mode_str in &modes {
            let mode = PermissionMode::from_str_opt(mode_str).unwrap();
            assert_eq!(mode.as_str(), *mode_str);
        }
        assert!(PermissionMode::from_str_opt("invalid").is_none());
    }
}
