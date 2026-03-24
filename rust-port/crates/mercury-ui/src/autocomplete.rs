// Mercury Code - Autocomplete Module (Rust port)
// Provides command, parameter, file-path, model, and provider completions
// for the Mercury REPL.  Mirrors src/ui/autocomplete.js.

use std::collections::HashMap;
use std::path::Path;

// ---------------------------------------------------------------------------
// Command parameter definitions
// ---------------------------------------------------------------------------

/// Parameter definition for a slash command.
#[derive(Debug, Clone)]
pub struct ParamDef {
    /// Allowed parameter values.
    pub params: Vec<&'static str>,
    /// Human-readable descriptions keyed by parameter value.
    pub descriptions: HashMap<&'static str, &'static str>,
}

/// Build the full map of commands → parameter definitions.
fn command_params() -> HashMap<&'static str, ParamDef> {
    let mut m = HashMap::new();

    m.insert("trust", ParamDef {
        params: vec![
            "readonly", "approval", "acceptedits", "open",
            "dontask", "aisafetydecide", "plan", "outside",
        ],
        descriptions: HashMap::from([
            ("readonly",       "Read-only mode (no file writes)"),
            ("approval",       "Ask before each action"),
            ("acceptedits",    "Auto-accept file edits"),
            ("open",           "Allow all actions"),
            ("dontask",        "Skip all confirmations"),
            ("aisafetydecide", "AI judges safety of actions"),
            ("plan",           "Read-only analysis mode"),
            ("outside",        "Toggle outside-workspace access"),
        ]),
    });

    m.insert("reasoning", ParamDef {
        params: vec!["instant", "low", "medium", "high"],
        descriptions: HashMap::from([
            ("instant", "Fastest, no reasoning chain"),
            ("low",     "Light reasoning"),
            ("medium",  "Balanced (default)"),
            ("high",    "Deep reasoning, slower"),
        ]),
    });

    m.insert("sandbox", ParamDef {
        params: vec!["on", "off", "strict", "status"],
        descriptions: HashMap::from([
            ("on",     "Enable sandbox (default)"),
            ("off",    "Disable sandbox"),
            ("strict", "Strict sandbox mode"),
            ("status", "Show sandbox status"),
        ]),
    });

    m.insert("history", ParamDef {
        params: vec!["list", "save", "load", "delete", "export"],
        descriptions: HashMap::from([
            ("list",   "List saved sessions"),
            ("save",   "Save current session"),
            ("load",   "Load a saved session"),
            ("delete", "Delete a saved session"),
            ("export", "Export session to file"),
        ]),
    });

    m.insert("memory", ParamDef {
        params: vec!["show", "add", "clear", "search"],
        descriptions: HashMap::from([
            ("show",   "Show current memory"),
            ("add",    "Add a memory entry"),
            ("clear",  "Clear all memory"),
            ("search", "Search memory entries"),
        ]),
    });

    m.insert("export", ParamDef {
        params: vec![".md", ".json", ".txt", ".html"],
        descriptions: HashMap::from([
            (".md",   "Markdown format"),
            (".json", "JSON transcript"),
            (".txt",  "Plain text"),
            (".html", "Interactive HTML"),
        ]),
    });

    m.insert("sentinel", ParamDef {
        params: vec!["on", "off", "status", "strict"],
        descriptions: HashMap::from([
            ("on",     "Enable context sentinel"),
            ("off",    "Disable context sentinel"),
            ("status", "Show sentinel status"),
            ("strict", "Strict mode (block suspicious)"),
        ]),
    });

    m.insert("labs", ParamDef {
        params: vec!["list", "enable", "disable"],
        descriptions: HashMap::from([
            ("list",    "List experimental features"),
            ("enable",  "Enable a lab feature"),
            ("disable", "Disable a lab feature"),
        ]),
    });

    m.insert("mcp", ParamDef {
        params: vec!["status", "add", "remove", "restart", "list"],
        descriptions: HashMap::from([
            ("status",  "Show MCP server status"),
            ("add",     "Add an MCP server"),
            ("remove",  "Remove an MCP server"),
            ("restart", "Restart MCP servers"),
            ("list",    "List configured servers"),
        ]),
    });

    m.insert("agents", ParamDef {
        params: vec!["list", "create", "delete", "show"],
        descriptions: HashMap::from([
            ("list",   "List available agents"),
            ("create", "Create a new agent definition"),
            ("delete", "Delete an agent definition"),
            ("show",   "Show agent details"),
        ]),
    });

    m.insert("diff", ParamDef {
        params: vec!["--staged", "--stat", "--name-only"],
        descriptions: HashMap::from([
            ("--staged",    "Show only staged changes"),
            ("--stat",      "Show diff statistics"),
            ("--name-only", "Show only changed file names"),
        ]),
    });

    m.insert("provider", ParamDef {
        params: vec!["list", "mercury", "openai"],
        descriptions: HashMap::from([
            ("list",    "List all providers and models"),
            ("mercury", "Switch to Mercury-2 (Inception Labs)"),
            ("openai",  "Switch to OpenAI (ChatGPT)"),
        ]),
    });

    m.insert("settings", ParamDef {
        params: vec![
            "model", "max_tokens", "temperature",
            "reasoning_effort", "reasoning_summary", "stream", "diffusing",
        ],
        descriptions: HashMap::from([
            ("model",             "Change AI model"),
            ("max_tokens",        "Set max output tokens"),
            ("temperature",       "Set temperature (0-2)"),
            ("reasoning_effort",  "Set reasoning effort"),
            ("reasoning_summary", "Toggle reasoning summary"),
            ("stream",            "Toggle streaming output"),
            ("diffusing",         "Toggle diffusion mode"),
        ]),
    });

    m
}

// ---------------------------------------------------------------------------
// Command-level descriptions
// ---------------------------------------------------------------------------

fn command_descriptions() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("/help",          "Show available commands"),
        ("/clear",         "Clear the terminal screen"),
        ("/trust",         "Set permission level"),
        ("/workspace",     "Show workspace info"),
        ("/reasoning",     "Set reasoning depth"),
        ("/supercompress", "Aggressively compress context"),
        ("/contextsearch", "Search conversation context"),
        ("/sandbox",       "Configure sandbox mode"),
        ("/history",       "Manage session history"),
        ("/context",       "Show context usage"),
        ("/settings",      "View/change settings"),
        ("/config",        "Edit configuration"),
        ("/edit",          "Open file in editor"),
        ("/exit",          "Exit Mercury Code"),
        ("/agents",        "Manage agent definitions"),
        ("/diff",          "Show git diff"),
        ("/compact",       "Compress conversation"),
        ("/new",           "Start new conversation"),
        ("/copy",          "Copy last response"),
        ("/init",          "Initialize project config"),
        ("/labs",          "Experimental features"),
        ("/cost",          "Show token costs"),
        ("/doctor",        "Run diagnostic checks"),
        ("/bug",           "Report a bug"),
        ("/status",        "Show system status"),
        ("/memory",        "Manage memory entries"),
        ("/model",         "Switch AI model"),
        ("/undo",          "Undo last change"),
        ("/login",         "Set API key"),
        ("/logout",        "Remove API key"),
        ("/verbose",       "Toggle verbose output"),
        ("/mcp",           "MCP server management"),
        ("/skills",        "List available skills"),
        ("/export",        "Export conversation"),
        ("/sentinel",      "Context sentinel settings"),
        ("/provider",      "Switch AI provider"),
    ])
}

// ---------------------------------------------------------------------------
// Completion result
// ---------------------------------------------------------------------------

/// A single completion candidate with an optional description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    /// The text to insert.
    pub text: String,
    /// An optional human-readable description shown beside the candidate.
    pub description: Option<String>,
}

// ---------------------------------------------------------------------------
// MercuryCompleter
// ---------------------------------------------------------------------------

/// Autocomplete engine for the Mercury REPL.
///
/// Dispatches completion based on the current input context:
///   - `/` prefix  -> slash-command and parameter completion
///   - file paths  -> directory scanning
///   - model/provider names -> known lists
pub struct MercuryCompleter {
    /// The full set of slash commands (e.g. `["/help", "/clear", ...]`).
    slash_commands: Vec<String>,
    /// Known model names for `/model` completion.
    models: Vec<String>,
    /// Known provider names for `/provider` completion.
    providers: Vec<String>,
    /// Pre-built parameter map.
    params: HashMap<&'static str, ParamDef>,
    /// Command descriptions.
    descriptions: HashMap<&'static str, &'static str>,
}

impl MercuryCompleter {
    /// Create a new completer.
    ///
    /// `extra_commands` are additional slash commands beyond the built-in set
    /// (e.g. from skill managers).
    pub fn new(
        extra_commands: &[String],
        models: Vec<String>,
        providers: Vec<String>,
    ) -> Self {
        let descs = command_descriptions();
        let mut slash_commands: Vec<String> = descs.keys().map(|s| s.to_string()).collect();
        for cmd in extra_commands {
            if !slash_commands.contains(cmd) {
                slash_commands.push(cmd.clone());
            }
        }
        slash_commands.sort();

        Self {
            slash_commands,
            models,
            providers,
            params: command_params(),
            descriptions: descs,
        }
    }

    // -- Public dispatch -------------------------------------------------------

    /// Return completions for the given input line.
    pub fn complete(&self, line: &str) -> Vec<Completion> {
        if line.starts_with('/') {
            self.command_completion(line)
        } else {
            // Try file path completion for anything that looks like a path
            self.file_path_completion(line)
        }
    }

    // -- Slash command completion -----------------------------------------------

    /// Complete slash commands and their parameters.
    fn command_completion(&self, line: &str) -> Vec<Completion> {
        let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
        let cmd = parts[0];

        // Level 1: command name completion
        if parts.len() == 1 {
            return self.slash_commands
                .iter()
                .filter(|c| c.starts_with(cmd))
                .map(|c| Completion {
                    text: c.clone(),
                    description: self.descriptions.get(c.as_str()).map(|d| d.to_string()),
                })
                .collect();
        }

        // Level 2: parameter completion
        let partial = parts.get(1).copied().unwrap_or("");
        let cmd_name = cmd.strip_prefix('/').unwrap_or(cmd);

        // Special cases
        if cmd_name == "model" {
            return self.model_completion(partial);
        }
        if cmd_name == "provider" {
            return self.provider_completion(partial);
        }

        // Generic parameter completion from the param table
        if let Some(def) = self.params.get(cmd_name) {
            return def.params.iter()
                .filter(|p| p.starts_with(partial))
                .map(|p| Completion {
                    text: format!("{cmd} {p}"),
                    description: def.descriptions.get(p).map(|d| d.to_string()),
                })
                .collect();
        }

        Vec::new()
    }

    // -- Tool completion -------------------------------------------------------

    /// Complete tool names from a provided list of known tools.
    pub fn tool_completion(prefix: &str, tools: &[&str]) -> Vec<Completion> {
        tools.iter()
            .filter(|t| t.starts_with(prefix))
            .map(|t| Completion {
                text: t.to_string(),
                description: None,
            })
            .collect()
    }

    // -- Model completion ------------------------------------------------------

    /// Complete model names.
    fn model_completion(&self, partial: &str) -> Vec<Completion> {
        self.models.iter()
            .filter(|m| m.starts_with(partial))
            .map(|m| Completion {
                text: format!("/model {m}"),
                description: None,
            })
            .collect()
    }

    // -- Provider completion ---------------------------------------------------

    /// Complete provider names.
    fn provider_completion(&self, partial: &str) -> Vec<Completion> {
        self.providers.iter()
            .filter(|p| p.starts_with(partial))
            .map(|p| Completion {
                text: format!("/provider {p}"),
                description: None,
            })
            .collect()
    }

    // -- File path completion --------------------------------------------------

    /// Scan a directory and return completions matching `partial`.
    fn file_path_completion(&self, partial: &str) -> Vec<Completion> {
        let (dir, prefix) = if let Some(pos) = partial.rfind('/') {
            let dir_part = &partial[..=pos];
            let file_part = &partial[pos + 1..];
            (dir_part.to_string(), file_part.to_string())
        } else if let Some(pos) = partial.rfind(std::path::MAIN_SEPARATOR) {
            let dir_part = &partial[..=pos];
            let file_part = &partial[pos + 1..];
            (dir_part.to_string(), file_part.to_string())
        } else {
            (".".to_string(), partial.to_string())
        };

        let dir_path = Path::new(&dir);
        let entries = match std::fs::read_dir(dir_path) {
            Ok(rd) => rd,
            Err(_) => return Vec::new(),
        };

        let mut results = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.starts_with(&prefix) {
                continue;
            }
            // Skip hidden files unless the user is explicitly typing a dot-prefix
            if name_str.starts_with('.') && !prefix.starts_with('.') {
                continue;
            }
            let full = if dir == "." {
                name_str.to_string()
            } else {
                format!("{dir}{name_str}")
            };
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            let display = if is_dir {
                format!("{full}/")
            } else {
                full.clone()
            };
            results.push(Completion {
                text: display,
                description: if is_dir { Some("directory".into()) } else { None },
            });
        }
        results.sort_by(|a, b| a.text.cmp(&b.text));
        results
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_completer() -> MercuryCompleter {
        MercuryCompleter::new(
            &[],
            vec!["mercury-2".into(), "mercury-2-mini".into(), "gpt-4o".into()],
            vec!["mercury".into(), "openai".into()],
        )
    }

    #[test]
    fn test_command_completion_prefix() {
        let c = make_completer();
        let results = c.complete("/he");
        assert!(results.iter().any(|r| r.text == "/help"));
    }

    #[test]
    fn test_command_completion_all() {
        let c = make_completer();
        let results = c.complete("/");
        // Should return all slash commands
        assert!(results.len() > 10);
    }

    #[test]
    fn test_param_completion_trust() {
        let c = make_completer();
        let results = c.complete("/trust r");
        assert!(results.iter().any(|r| r.text.contains("readonly")));
    }

    #[test]
    fn test_param_completion_full_list() {
        let c = make_completer();
        let results = c.complete("/trust ");
        // Should list all trust params
        assert!(results.len() >= 7);
    }

    #[test]
    fn test_model_completion() {
        let c = make_completer();
        let results = c.complete("/model merc");
        assert!(results.iter().any(|r| r.text.contains("mercury-2")));
    }

    #[test]
    fn test_provider_completion() {
        let c = make_completer();
        let results = c.complete("/provider o");
        assert!(results.iter().any(|r| r.text.contains("openai")));
    }

    #[test]
    fn test_tool_completion() {
        let tools = &["Read", "Write", "Edit", "Bash", "Glob"];
        let results = MercuryCompleter::tool_completion("Re", tools);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Read");
    }

    #[test]
    fn test_tool_completion_empty_prefix() {
        let tools = &["Read", "Write"];
        let results = MercuryCompleter::tool_completion("", tools);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_file_path_completion_current_dir() {
        // Completing from "." should return something (at minimum Cargo.toml
        // or src/ in most project dirs).  We just verify it does not panic.
        let c = make_completer();
        let _ = c.file_path_completion("src");
    }

    #[test]
    fn test_file_path_completion_nonexistent() {
        let c = make_completer();
        let results = c.file_path_completion("/nonexistent_path_xyz_12345/");
        assert!(results.is_empty());
    }

    #[test]
    fn test_extra_commands() {
        let c = MercuryCompleter::new(
            &["/custom".into()],
            vec![],
            vec![],
        );
        let results = c.complete("/cust");
        assert!(results.iter().any(|r| r.text == "/custom"));
    }

    #[test]
    fn test_descriptions_populated() {
        let c = make_completer();
        let results = c.complete("/help");
        assert_eq!(results.len(), 1);
        assert!(results[0].description.is_some());
    }

    #[test]
    fn test_command_params_has_sandbox() {
        let params = command_params();
        assert!(params.contains_key("sandbox"));
        let sandbox = &params["sandbox"];
        assert!(sandbox.params.contains(&"strict"));
    }
}
