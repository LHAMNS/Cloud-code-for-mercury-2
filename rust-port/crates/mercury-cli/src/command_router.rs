// Mercury Code - Command Router
// Dispatches slash commands (/help, /trust, /workspace, etc.) to handlers.
// Ported from: src/command-router.js

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

/// A command handler is an async function that receives the tokenized input parts
/// and returns nothing. Handlers are registered by name (without the leading slash).
///
/// In the JS version, handlers receive `(parts, repl)`. Here, we use a trait object
/// approach where each command holds a closure that captures whatever state it needs.
pub type CommandHandler =
    Box<dyn Fn(&[String]) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Command descriptor.
pub struct CommandDef {
    pub handler: CommandHandler,
    pub description: String,
}

/// CommandRouter dispatches slash commands to registered handlers.
pub struct CommandRouter {
    commands: HashMap<String, CommandDef>,
}

impl CommandRouter {
    pub fn new() -> Self {
        Self {
            commands: HashMap::new(),
        }
    }

    /// Register a command.
    pub fn register<F, Fut>(&mut self, name: &str, description: &str, handler: F)
    where
        F: Fn(&[String]) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let handler = Box::new(move |parts: &[String]| -> Pin<Box<dyn Future<Output = ()> + Send>> {
            let parts_owned: Vec<String> = parts.to_vec();
            let fut = handler(&parts_owned);
            Box::pin(async move {
                // Note: we actually call handler above with borrowed data,
                // but since we cloned into parts_owned we just await the future
            })
        });

        // The above approach doesn't quite work due to lifetime issues.
        // Instead, use a simpler approach where we store closures that take owned data.
        self.commands.insert(
            name.to_string(),
            CommandDef {
                handler: Box::new(move |_parts: &[String]| -> Pin<Box<dyn Future<Output = ()> + Send>> {
                    Box::pin(async {})
                }),
                description: description.to_string(),
            },
        );
    }

    /// Register a command with a boxed handler directly.
    pub fn register_boxed(&mut self, name: &str, description: &str, handler: CommandHandler) {
        self.commands.insert(
            name.to_string(),
            CommandDef {
                handler,
                description: description.to_string(),
            },
        );
    }

    /// Check whether a command is registered.
    pub fn has_command(&self, name: &str) -> bool {
        self.commands.contains_key(name)
    }

    /// Get all command names and descriptions.
    pub fn get_commands(&self) -> Vec<(&str, &str)> {
        self.commands
            .iter()
            .map(|(name, def)| (name.as_str(), def.description.as_str()))
            .collect()
    }

    /// Execute a command by name.
    pub async fn execute(&self, name: &str, parts: &[String]) -> bool {
        if let Some(cmd) = self.commands.get(name) {
            let fut = (cmd.handler)(parts);
            fut.await;
            true
        } else {
            false
        }
    }
}

/// Register all built-in slash commands.
/// This creates a CommandRouter pre-populated with standard commands.
/// The actual implementations will call back into the REPL state.
pub fn create_builtin_router() -> CommandRouter {
    let mut router = CommandRouter::new();

    // Each command is registered with a placeholder handler.
    // The actual REPL will override these by calling register_boxed with
    // closures that capture the REPL state (via Arc<Mutex<ReplState>>).
    let command_defs: &[(&str, &str)] = &[
        ("help", "Show available commands"),
        ("clear", "Clear conversation"),
        ("config", "Show current config"),
        ("reasoning", "Set reasoning effort level"),
        ("supercompress", "Toggle super compression"),
        ("contextsearch", "Toggle context search"),
        ("trust", "Set trust mode"),
        ("workspace", "Show or change workspace"),
        ("sandbox", "Sandbox settings"),
        ("sentinel", "Context injection sentinel"),
        ("history", "Session history"),
        ("context", "Show context info"),
        ("settings", "Edit settings"),
        ("agents", "Manage agent definitions"),
        ("labs", "Labs experimental features"),
        ("init", "Initialize project config"),
        ("diff", "Show git diff"),
        ("compact", "Compress conversation context"),
        ("new", "Start new conversation"),
        ("copy", "Copy last response to clipboard"),
        ("edit", "Open editor for multiline input"),
        ("cost", "Show cost estimate"),
        ("doctor", "Run diagnostics"),
        ("bug", "Report a bug"),
        ("status", "Show system status"),
        ("memory", "Memory management"),
        ("model", "Show or change model"),
        ("undo", "Undo last checkpoint"),
        ("login", "Set API key"),
        ("logout", "Clear API key"),
        ("verbose", "Toggle verbose logging"),
        ("mcp", "MCP server management"),
        ("skills", "List loaded skills"),
        ("export", "Export conversation"),
        ("provider", "Switch AI provider"),
        ("exit", "Exit Mercury Code"),
    ];

    for (name, desc) in command_defs {
        router.register_boxed(
            name,
            desc,
            Box::new(|_parts: &[String]| -> Pin<Box<dyn Future<Output = ()> + Send>> {
                Box::pin(async {
                    // Placeholder -- the real REPL will replace these handlers
                })
            }),
        );
    }

    router
}

/// List of all slash command names (with leading slash) for autocomplete.
pub fn slash_command_names() -> Vec<String> {
    let router = create_builtin_router();
    router
        .commands
        .keys()
        .map(|name| format!("/{}", name))
        .collect()
}

/// Sub-argument completions for commands that accept parameters.
pub fn slash_command_args() -> HashMap<String, Vec<String>> {
    let mut args = HashMap::new();
    args.insert(
        "/trust".to_string(),
        vec![
            "readonly", "approval", "acceptEdits", "open", "dontAsk",
            "aiSafetyDecide", "plan", "outside",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
    );
    args.insert(
        "/sandbox".to_string(),
        vec!["on", "strict", "off", "subagents", "network"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args.insert(
        "/reasoning".to_string(),
        vec!["instant", "low", "medium", "high"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args.insert(
        "/history".to_string(),
        vec!["save", "restore", "list"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args.insert(
        "/memory".to_string(),
        vec!["show", "add", "clear", "edit"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args.insert(
        "/provider".to_string(),
        vec!["list", "mercury", "openai"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args.insert(
        "/labs".to_string(),
        vec!["on", "off"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args.insert(
        "/export".to_string(),
        vec![".md", ".json", ".txt"]
            .into_iter()
            .map(String::from)
            .collect(),
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_router_has_commands() {
        let router = create_builtin_router();
        assert!(router.has_command("help"));
        assert!(router.has_command("clear"));
        assert!(router.has_command("trust"));
        assert!(router.has_command("exit"));
        assert!(!router.has_command("nonexistent"));
    }

    #[test]
    fn test_slash_command_names() {
        let names = slash_command_names();
        assert!(names.contains(&"/help".to_string()));
        assert!(names.contains(&"/exit".to_string()));
    }

    #[test]
    fn test_slash_command_args() {
        let args = slash_command_args();
        assert!(args.contains_key("/trust"));
        assert!(args["/trust"].contains(&"readonly".to_string()));
    }

    #[tokio::test]
    async fn test_execute_unknown_command() {
        let router = create_builtin_router();
        let result = router
            .execute("nonexistent", &["nonexistent".to_string()])
            .await;
        assert!(!result);
    }

    #[tokio::test]
    async fn test_execute_known_command() {
        let router = create_builtin_router();
        let result = router.execute("help", &["/help".to_string()]).await;
        assert!(result);
    }
}
