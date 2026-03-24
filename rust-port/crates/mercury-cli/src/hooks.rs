// Mercury Code - Hooks System
// Hooks allow users to run custom logic at key lifecycle points.
// Ported from: src/hooks.js

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::utils::{debug_log, sanitize_env};

// ── Hook Event Types ──────────────────────────────────────────────────────────

/// All supported hook event types.
pub const HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "TeammateIdle",
    "TaskCompleted",
    "WorktreeCreate",
    "WorktreeRemove",
    "PreCompact",
    "SessionStart",
    "SessionEnd",
    "Notification",
];

/// Valid hook result actions.
const VALID_ACTIONS: &[&str] = &["allow", "deny", "ask", "modify", "continue"];

/// Write-capable tools (project hooks cannot modify input for these).
const WRITE_TOOLS: &[&str] = &["Bash", "Write", "Edit", "Patch", "Fetch"];

// ── Types ────────────────────────────────────────────────────────────────────

/// A registered hook handler.
#[derive(Debug, Clone)]
pub struct HookHandler {
    pub id: String,
    pub event: String,
    pub handler_type: HookHandlerType,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub prompt: Option<String>,
    pub matcher: Option<String>,
    pub timeout_ms: u64,
    pub source: HookSource,
    pub is_project_hook: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HookHandlerType {
    Command,
    Prompt,
    Function,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HookSource {
    Global,
    Project,
    Internal,
}

/// Result from firing a hook event.
#[derive(Debug, Clone, Default)]
pub struct HookFireResult {
    pub action: String,
    pub updated_input: Option<serde_json::Value>,
    pub message: Option<String>,
    pub results: Vec<HookHandlerResult>,
}

/// Result from a single handler execution.
#[derive(Debug, Clone)]
pub struct HookHandlerResult {
    pub handler_id: String,
    pub action: String,
    pub updated_input: Option<serde_json::Value>,
    pub message: Option<String>,
    pub error: Option<String>,
}

/// Context passed to hook handlers.
#[derive(Debug, Clone, Default, Serialize)]
pub struct HookContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "agentName")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "isError")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "tokenCount")]
    pub token_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "compactionCount")]
    pub compaction_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "worktreePath")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "hadChanges")]
    pub had_changes: Option<bool>,
}

/// Hook configuration file format.
#[derive(Debug, Deserialize)]
struct HooksConfig {
    hooks: Option<HashMap<String, Vec<HookConfigEntry>>>,
}

#[derive(Debug, Deserialize)]
struct HookConfigEntry {
    id: Option<String>,
    #[serde(rename = "type")]
    handler_type: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    prompt: Option<String>,
    matcher: Option<String>,
    timeout: Option<u64>,
}

// ── HooksManager ─────────────────────────────────────────────────────────────

pub struct HooksManager {
    pub workspace: PathBuf,
    pub allow_project_hooks: bool,
    handlers: HashMap<String, Vec<HookHandler>>,
    loaded: bool,
    on_info: Option<Box<dyn Fn(&str) + Send + Sync>>,
}

impl HooksManager {
    pub fn new(workspace: &Path, allow_project_hooks: bool) -> Self {
        let mut handlers = HashMap::new();
        for event in HOOK_EVENTS {
            handlers.insert(event.to_string(), Vec::new());
        }
        Self {
            workspace: workspace.to_path_buf(),
            allow_project_hooks,
            handlers,
            loaded: false,
            on_info: None,
        }
    }

    pub fn set_on_info<F: Fn(&str) + Send + Sync + 'static>(&mut self, f: F) {
        self.on_info = Some(Box::new(f));
    }

    /// Load hooks from project and global config files.
    pub async fn load(&mut self) {
        // Preserve internal handlers
        let mut preserved: HashMap<String, Vec<HookHandler>> = HashMap::new();
        for event in HOOK_EVENTS {
            let handlers = self.handlers.get(*event).cloned().unwrap_or_default();
            preserved.insert(
                event.to_string(),
                handlers
                    .into_iter()
                    .filter(|h| h.source == HookSource::Internal)
                    .collect(),
            );
        }

        // Reset handlers
        self.handlers.clear();
        for event in HOOK_EVENTS {
            self.handlers.insert(
                event.to_string(),
                preserved.get(*event).cloned().unwrap_or_default(),
            );
        }

        // 1. Load global hooks: ~/.mercury/hooks.json
        let global_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".mercury")
            .join("hooks.json");
        self.load_from_file(&global_path, HookSource::Global).await;

        // 2. Load project hooks only when explicitly enabled
        if self.allow_project_hooks {
            let project_path = self.workspace.join(".mercury").join("hooks.json");
            self.load_from_file(&project_path, HookSource::Project)
                .await;
        }

        self.loaded = true;
    }

    async fn load_from_file(&mut self, file_path: &Path, source: HookSource) {
        let data = match tokio::fs::read_to_string(file_path).await {
            Ok(d) => d,
            Err(_) => return,
        };

        let config: HooksConfig = match serde_json::from_str(&data) {
            Ok(c) => c,
            Err(e) => {
                debug_log("HooksManager.load_from_file.parse", &e);
                return;
            }
        };

        let hooks = match config.hooks {
            Some(h) => h,
            None => return,
        };

        const MAX_HOOK_TIMEOUT: u64 = 30_000;

        for (event, entries) in hooks {
            if !self.handlers.contains_key(&event) {
                if let Some(ref on_info) = self.on_info {
                    on_info(&format!(
                        "[Hooks] Warning: unknown event \"{}\" in {} — skipped",
                        event,
                        file_path.display()
                    ));
                }
                continue;
            }

            for entry in entries {
                let handler = HookHandler {
                    id: entry.id.unwrap_or_else(|| {
                        format!(
                            "{:?}-{}-{}",
                            source,
                            event,
                            chrono::Utc::now().timestamp_millis()
                        )
                    }),
                    event: event.clone(),
                    handler_type: match entry.handler_type.as_deref() {
                        Some("prompt") => HookHandlerType::Prompt,
                        Some("function") => HookHandlerType::Function,
                        _ => HookHandlerType::Command,
                    },
                    command: entry.command,
                    args: entry.args,
                    prompt: entry.prompt,
                    matcher: entry.matcher,
                    timeout_ms: entry.timeout.unwrap_or(10_000).min(MAX_HOOK_TIMEOUT),
                    source: source.clone(),
                    is_project_hook: source == HookSource::Project,
                };

                // Project hooks shadow global hooks with same ID
                if source == HookSource::Project {
                    if let Some(handlers) = self.handlers.get_mut(&event) {
                        handlers.retain(|h| h.id != handler.id || h.source == HookSource::Internal);
                    }
                }

                if let Some(handlers) = self.handlers.get_mut(&event) {
                    handlers.push(handler);
                }
            }
        }
    }

    pub fn set_workspace(&mut self, workspace: &Path) {
        if workspace != self.workspace {
            self.workspace = workspace.to_path_buf();
            self.loaded = false;
        }
    }

    pub async fn ensure_loaded(&mut self) {
        if !self.loaded {
            self.load().await;
        }
    }

    /// Register a hook handler programmatically (for internal use).
    pub fn register(&mut self, event: &str, handler: HookHandler) {
        if let Some(handlers) = self.handlers.get_mut(event) {
            handlers.push(handler);
        }
    }

    /// Unregister a hook handler by ID.
    pub fn unregister(&mut self, event: &str, id: &str) {
        if let Some(handlers) = self.handlers.get_mut(event) {
            handlers.retain(|h| h.id != id);
        }
    }

    /// Check if any handlers are registered for an event.
    pub fn has_handlers(&self, event: &str) -> bool {
        self.handlers
            .get(event)
            .map_or(false, |h| !h.is_empty())
    }

    /// Fire a hook event. Runs all matching handlers sequentially.
    pub async fn fire(&mut self, event: &str, context: &HookContext) -> HookFireResult {
        self.ensure_loaded().await;

        let handlers = match self.handlers.get(event) {
            Some(h) if !h.is_empty() => h.clone(),
            _ => {
                return HookFireResult {
                    action: "continue".to_string(),
                    ..Default::default()
                }
            }
        };

        // Filter handlers by matcher
        let matching: Vec<_> = handlers
            .iter()
            .filter(|h| {
                if let Some(ref matcher) = h.matcher {
                    if let Some(ref tool_name) = context.tool_name {
                        match_tool(matcher, tool_name)
                    } else {
                        true
                    }
                } else {
                    true
                }
            })
            .collect();

        if matching.is_empty() {
            return HookFireResult {
                action: "continue".to_string(),
                ..Default::default()
            };
        }

        let mut results = Vec::new();

        for handler in matching {
            match self.execute_handler(handler, event, context) {
                Ok(result) => {
                    let action = result.action.clone();
                    results.push(result);

                    // For PreToolUse, short-circuit on allow/deny/modify
                    if event == "PreToolUse" && action != "continue" {
                        return HookFireResult {
                            action,
                            updated_input: results.last().and_then(|r| r.updated_input.clone()),
                            message: results.last().and_then(|r| r.message.clone()),
                            results,
                        };
                    }
                }
                Err(e) => {
                    results.push(HookHandlerResult {
                        handler_id: handler.id.clone(),
                        action: "continue".to_string(),
                        updated_input: None,
                        message: None,
                        error: Some(e),
                    });
                }
            }
        }

        HookFireResult {
            action: "continue".to_string(),
            updated_input: None,
            message: None,
            results,
        }
    }

    fn execute_handler(
        &self,
        handler: &HookHandler,
        event: &str,
        context: &HookContext,
    ) -> Result<HookHandlerResult, String> {
        match handler.handler_type {
            HookHandlerType::Command => self.execute_command(handler, event, context),
            HookHandlerType::Prompt => Ok(HookHandlerResult {
                handler_id: handler.id.clone(),
                action: "continue".to_string(),
                updated_input: None,
                message: handler.prompt.clone(),
                error: None,
            }),
            HookHandlerType::Function => Ok(HookHandlerResult {
                handler_id: handler.id.clone(),
                action: "continue".to_string(),
                updated_input: None,
                message: None,
                error: None,
            }),
        }
    }

    fn execute_command(
        &self,
        handler: &HookHandler,
        event: &str,
        context: &HookContext,
    ) -> Result<HookHandlerResult, String> {
        let command = handler
            .command
            .as_ref()
            .ok_or("No command specified")?;

        let payload = serde_json::json!({
            "event": event,
            "toolName": context.tool_name,
            "toolInput": context.tool_input,
            "agentId": context.agent_id,
            "taskId": context.task_id,
            "result": context.result,
            "workspace": self.workspace.to_string_lossy(),
        });

        let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

        let (cmd_owned, args) = if let Some(ref explicit_args) = handler.args {
            (command.to_string(), explicit_args.clone())
        } else {
            let parts = split_command(command);
            if parts.is_empty() {
                return Err("Empty command".to_string());
            }
            (parts[0].clone(), parts[1..].to_vec())
        };

        let mut env_vars = sanitize_env();
        env_vars.insert("MERCURY_HOOK_EVENT".to_string(), event.to_string());

        let output = Command::new(&cmd_owned)
            .args(&args)
            .current_dir(&self.workspace)
            .envs(&env_vars)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(ref mut stdin) = child.stdin {
                    let _ = stdin.write_all(payload_str.as_bytes());
                }
                child.wait_with_output()
            })
            .map_err(|e| e.to_string())?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // Try to parse JSON response
        match serde_json::from_str::<serde_json::Value>(&stdout) {
            Ok(result) => {
                let mut action = result
                    .get("action")
                    .and_then(|a| a.as_str())
                    .unwrap_or("continue")
                    .to_string();

                if !VALID_ACTIONS.contains(&action.as_str()) {
                    action = "continue".to_string();
                }

                // Project hooks cannot bypass permissions via "allow"
                if handler.is_project_hook && action == "allow" {
                    action = "continue".to_string();
                }

                // Project hooks cannot modify input for write-capable tools
                if handler.is_project_hook
                    && action == "modify"
                    && context
                        .tool_name
                        .as_ref()
                        .map_or(false, |tn| {
                            WRITE_TOOLS.contains(&tn.as_str())
                                || tn.starts_with("mcp__")
                        })
                {
                    action = "continue".to_string();
                }

                let updated_input = if action == "modify" {
                    result.get("updatedInput").cloned()
                } else {
                    None
                };

                Ok(HookHandlerResult {
                    handler_id: handler.id.clone(),
                    action,
                    updated_input,
                    message: result
                        .get("message")
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string()),
                    error: None,
                })
            }
            Err(_) => Ok(HookHandlerResult {
                handler_id: handler.id.clone(),
                action: "continue".to_string(),
                updated_input: None,
                message: None,
                error: None,
            }),
        }
    }

    // ── Convenience fire methods ──

    pub async fn fire_pre_tool_use(
        &mut self,
        tool_name: &str,
        tool_input: &serde_json::Value,
    ) -> HookFireResult {
        self.fire(
            "PreToolUse",
            &HookContext {
                tool_name: Some(tool_name.to_string()),
                tool_input: Some(tool_input.clone()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn fire_post_tool_use(
        &mut self,
        tool_name: &str,
        tool_input: &serde_json::Value,
        result: &str,
    ) -> HookFireResult {
        self.fire(
            "PostToolUse",
            &HookContext {
                tool_name: Some(tool_name.to_string()),
                tool_input: Some(tool_input.clone()),
                result: Some(result.to_string()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn fire_session_start(&mut self, workspace: &str) -> HookFireResult {
        self.fire(
            "SessionStart",
            &HookContext {
                workspace: Some(workspace.to_string()),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn fire_session_end(&mut self) -> HookFireResult {
        self.fire("SessionEnd", &HookContext::default()).await
    }

    pub async fn fire_pre_compact(
        &mut self,
        token_count: u64,
        compaction_count: u32,
    ) -> HookFireResult {
        self.fire(
            "PreCompact",
            &HookContext {
                token_count: Some(token_count),
                compaction_count: Some(compaction_count),
                ..Default::default()
            },
        )
        .await
    }
}

/// Split a command string respecting single/double quotes.
fn split_command(cmd: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;

    for ch in cmd.chars() {
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch.is_whitespace() && !in_single && !in_double {
            if !current.is_empty() {
                parts.push(current.clone());
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    if parts.is_empty() {
        vec![cmd.to_string()]
    } else {
        parts
    }
}

/// Check if a matcher pattern matches a tool name.
fn match_tool(matcher: &str, tool_name: &str) -> bool {
    if matcher == "*" {
        return true;
    }
    if matcher == tool_name {
        return true;
    }
    // Tool(specifier) pattern
    if let Some(paren_idx) = matcher.find('(') {
        let match_tool_name = &matcher[..paren_idx];
        return match_tool_name == tool_name;
    }
    false
}

/// Create a new HooksManager.
pub fn get_hooks_manager(workspace: &Path, allow_project_hooks: bool) -> HooksManager {
    HooksManager::new(workspace, allow_project_hooks)
}

/// Initialize hooks (load config files).
pub async fn init_hooks(workspace: &Path, allow_project_hooks: bool) -> HooksManager {
    let mut hooks = get_hooks_manager(workspace, allow_project_hooks);
    hooks.load().await;
    hooks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_command_simple() {
        let parts = split_command("echo hello world");
        assert_eq!(parts, vec!["echo", "hello", "world"]);
    }

    #[test]
    fn test_split_command_quoted() {
        let parts = split_command(r#"echo "hello world" arg2"#);
        assert_eq!(parts, vec!["echo", "hello world", "arg2"]);
    }

    #[test]
    fn test_match_tool_exact() {
        assert!(match_tool("Bash", "Bash"));
        assert!(!match_tool("Bash", "Read"));
    }

    #[test]
    fn test_match_tool_wildcard() {
        assert!(match_tool("*", "Bash"));
        assert!(match_tool("*", "Read"));
    }

    #[test]
    fn test_match_tool_specifier() {
        assert!(match_tool("Bash(git *)", "Bash"));
        assert!(!match_tool("Bash(git *)", "Read"));
    }

    #[tokio::test]
    async fn test_hooks_manager_new() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut hm = HooksManager::new(tmp.path(), false);
        hm.load().await;
        assert!(!hm.has_handlers("PreToolUse"));
    }
}
