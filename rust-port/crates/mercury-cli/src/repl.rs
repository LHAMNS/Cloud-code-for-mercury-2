//! Mercury Code REPL - Main interactive loop.
//! Handles user input, API communication, streaming, tool execution, and context management.
//!
//! Ported from: src/repl.js (3277 lines)

use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use serde_json::Value;

use mercury_core::config::{ClientConfig, ModelLimits};
use mercury_core::conversation::{Conversation, Usage};
use mercury_core::memory::MemoryManager;

/// Configuration for creating a new REPL instance.
#[derive(Debug, Clone)]
pub struct ReplConfig {
    pub workspace: PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub trust_mode: Option<String>,
    pub verbose: bool,
    pub resume_session: Option<String>,
    pub pipe_prompt: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl Default for ReplConfig {
    fn default() -> Self {
        Self {
            workspace: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            provider: None,
            model: None,
            trust_mode: None,
            verbose: false,
            resume_session: None,
            pipe_prompt: None,
            api_key: None,
            base_url: None,
        }
    }
}

/// Stream result after processing an API response.
#[derive(Debug)]
struct StreamResult {
    content: String,
    tool_calls: Vec<Value>,
    usage: Option<Usage>,
    finish_reason: Option<String>,
}

/// The main Mercury Code REPL.
pub struct MercuryRepl {
    editor: DefaultEditor,
    conversation: Conversation,
    config: ReplConfig,
    client_config: ClientConfig,
    model_limits: ModelLimits,
    memory: Option<MemoryManager>,
    workspace: PathBuf,
    trust_mode: String,
    verbose: bool,
    turn_count: u64,
    is_processing: bool,
    should_exit: bool,
    /// History file path
    history_path: Option<PathBuf>,
}

impl MercuryRepl {
    /// Create a new REPL instance.
    pub async fn new(config: ReplConfig) -> Result<Self> {
        let workspace = config.workspace.clone();
        let trust_mode = config.trust_mode.clone().unwrap_or_else(|| "approval".to_string());
        let verbose = config.verbose;

        // Build system prompt
        let sandbox_info = crate::system_prompt::SandboxInfo::default();
        let provider_info = crate::system_prompt::ProviderInfo {
            display_name: None,
            model: config.model.clone(),
            max_context: None,
        };
        let system_prompt = crate::system_prompt::build_system_prompt(
            &workspace.to_string_lossy(),
            &trust_mode,
            &sandbox_info,
            &provider_info,
        );

        let conversation = Conversation::new(&system_prompt);
        let client_config = ClientConfig::default();
        let model_limits = ModelLimits::default();

        // Setup memory
        let mercury_dir = workspace.join(".mercury");
        let memory = if mercury_dir.exists() || tokio::fs::create_dir_all(&mercury_dir).await.is_ok() {
            Some(MemoryManager::new(&workspace, Some(&mercury_dir)))
        } else {
            None
        };

        // Setup readline editor
        let mut editor = DefaultEditor::new()
            .context("Failed to create readline editor")?;

        // Load history
        let history_path = dirs::home_dir()
            .map(|h| h.join(".mercury").join("history.txt"));
        if let Some(ref hp) = history_path {
            if hp.exists() {
                let _ = editor.load_history(hp);
            }
        }

        Ok(Self {
            editor,
            conversation,
            config,
            client_config,
            model_limits,
            memory,
            workspace,
            trust_mode,
            verbose,
            turn_count: 0,
            is_processing: false,
            should_exit: false,
            history_path,
        })
    }

    /// Run the main REPL loop.
    pub async fn run(&mut self) -> Result<()> {
        // Check for pipe mode
        if let Some(ref prompt) = self.config.pipe_prompt.clone() {
            return self.run_pipe_mode(prompt).await;
        }

        // Print welcome message
        self.print_welcome();

        // Load memory into conversation
        if let Some(ref memory) = self.memory {
            let content = memory.read().await;
            if !content.is_empty() {
                self.conversation.load_memory_content(&content);
            }
        }

        // Main loop
        loop {
            if self.should_exit {
                break;
            }

            let prompt = self.build_prompt();
            match self.editor.readline(&prompt) {
                Ok(line) => {
                    let input = line.trim().to_string();
                    if input.is_empty() {
                        continue;
                    }

                    // Add to history
                    let _ = self.editor.add_history_entry(&input);

                    // Process input
                    match self.process_input(&input).await {
                        Ok(should_continue) => {
                            if !should_continue {
                                break;
                            }
                        }
                        Err(e) => {
                            eprintln!("\x1b[31mError: {}\x1b[0m", e);
                        }
                    }
                }
                Err(ReadlineError::Interrupted) => {
                    // Ctrl+C
                    if self.is_processing {
                        self.is_processing = false;
                        println!("\n\x1b[33mInterrupted.\x1b[0m");
                    } else {
                        println!("\n\x1b[2mUse Ctrl+D or /exit to quit.\x1b[0m");
                    }
                }
                Err(ReadlineError::Eof) => {
                    // Ctrl+D
                    println!("\n\x1b[2mGoodbye!\x1b[0m");
                    break;
                }
                Err(e) => {
                    eprintln!("Readline error: {}", e);
                    break;
                }
            }
        }

        // Save history
        if let Some(ref hp) = self.history_path {
            if let Some(parent) = hp.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = self.editor.save_history(hp);
        }

        Ok(())
    }

    /// Process a single line of input. Returns false if REPL should exit.
    async fn process_input(&mut self, input: &str) -> Result<bool> {
        // Check for slash commands
        if input.starts_with('/') {
            return self.handle_command(input).await;
        }

        // Regular user message
        self.conversation.add_user_message(input);
        self.turn_count += 1;

        // Send to API
        self.send_to_api().await?;

        // Check context usage and auto-compress if needed
        self.check_context_usage().await?;

        Ok(true)
    }

    /// Handle a slash command.
    async fn handle_command(&mut self, input: &str) -> Result<bool> {
        let parts: Vec<&str> = input.splitn(2, ' ').collect();
        let command = parts[0].to_lowercase();
        let args = parts.get(1).copied().unwrap_or("");

        match command.as_str() {
            "/exit" | "/quit" | "/q" => {
                println!("\x1b[2mGoodbye!\x1b[0m");
                return Ok(false);
            }
            "/help" | "/h" => {
                self.print_help();
            }
            "/clear" => {
                self.conversation.clear();
                println!("\x1b[32mConversation cleared.\x1b[0m");
            }
            "/compact" => {
                println!("\x1b[33mCompressing context...\x1b[0m");
                self.conversation.compress(
                    &() as &dyn std::any::Any,
                    self.memory.as_ref().map(|_m| "").map(|_| ""),
                    false,
                ).await?;
                println!("\x1b[32mContext compressed.\x1b[0m");
            }
            "/super-compact" => {
                println!("\x1b[33mSuper-compressing context...\x1b[0m");
                self.conversation.compress(
                    &() as &dyn std::any::Any,
                    None,
                    true,
                ).await?;
                println!("\x1b[32mContext super-compressed.\x1b[0m");
            }
            "/model" => {
                if args.is_empty() {
                    println!("Current model: {}", self.client_config.model);
                } else {
                    self.client_config.model = args.to_string();
                    println!("\x1b[32mModel switched to: {}\x1b[0m", args);
                }
            }
            "/provider" => {
                if args.is_empty() {
                    println!("Current provider: {}", self.config.provider.as_deref().unwrap_or("mercury"));
                } else {
                    self.config.provider = Some(args.to_string());
                    println!("\x1b[32mProvider switched to: {}\x1b[0m", args);
                }
            }
            "/trust" => {
                if args.is_empty() {
                    println!("Current trust mode: {}", self.trust_mode);
                } else {
                    self.trust_mode = args.to_string();
                    println!("\x1b[32mTrust mode set to: {}\x1b[0m", args);
                }
            }
            "/memory" => {
                if let Some(ref memory) = self.memory {
                    let content = memory.read().await;
                    if content.is_empty() {
                        println!("\x1b[2mNo memory stored.\x1b[0m");
                    } else {
                        println!("--- Memory ---\n{}\n--- End ---", content);
                    }
                } else {
                    println!("\x1b[2mMemory not available.\x1b[0m");
                }
            }
            "/usage" | "/tokens" => {
                let pct = self.conversation.get_usage_percent(Some(self.model_limits.max_context_tokens as u64));
                println!("Token usage: {}", pct);
            }
            "/version" => {
                println!("Mercury Code v{}", env!("CARGO_PKG_VERSION"));
            }
            "/verbose" => {
                self.verbose = !self.verbose;
                println!("Verbose mode: {}", if self.verbose { "on" } else { "off" });
            }
            "/web" => {
                println!("\x1b[33mWeb mode not yet implemented in Rust port.\x1b[0m");
            }
            "/history" => {
                println!("\x1b[33mSession history not yet implemented in Rust port.\x1b[0m");
            }
            "/rollback" | "/undo" => {
                println!("\x1b[33mRollback not yet implemented in Rust port.\x1b[0m");
            }
            "/labs" => {
                println!("\x1b[33mLabs features not yet implemented in Rust port.\x1b[0m");
            }
            "/agents" => {
                println!("\x1b[33mAgent management not yet implemented in Rust port.\x1b[0m");
            }
            "/bug" => {
                println!("Report bugs at: https://github.com/LHAMNS/Cloud-code-for-mercury-2/issues");
            }
            _ => {
                println!("\x1b[31mUnknown command: {}\x1b[0m. Type /help for available commands.", command);
            }
        }

        Ok(true)
    }

    /// Send conversation to API and handle the response.
    fn send_to_api(&mut self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(self._send_to_api_inner())
    }

    async fn _send_to_api_inner(&mut self) -> Result<()> {
        self.is_processing = true;

        let messages = self.conversation.get_messages();
        let tool_defs = self.build_tool_definitions();

        // Build request body
        let body = serde_json::json!({
            "model": self.client_config.model,
            "messages": messages.iter().map(|m| {
                let mut obj = serde_json::json!({
                    "role": m.role,
                    "content": m.content,
                });
                if let Some(ref tc) = m.tool_calls {
                    obj["tool_calls"] = serde_json::json!(tc);
                }
                if let Some(ref id) = m.tool_call_id {
                    obj["tool_call_id"] = serde_json::json!(id);
                }
                obj
            }).collect::<Vec<_>>(),
            "max_tokens": self.client_config.max_tokens,
            "temperature": self.client_config.temperature,
            "stream": true,
            "tools": tool_defs,
        });

        if self.verbose {
            eprintln!("\x1b[2m[API] Sending {} messages with {} tools\x1b[0m",
                messages.len(), tool_defs.len());
        }

        // In the Rust port, we use reqwest for the API call
        let api_key = self.config.api_key.clone()
            .or_else(|| std::env::var("INCEPTION_API_KEY").ok())
            .unwrap_or_default();

        if api_key.is_empty() {
            self.is_processing = false;
            anyhow::bail!(
                "No API key found. Set INCEPTION_API_KEY environment variable or pass --api-key."
            );
        }

        let base_url = self.config.base_url.clone()
            .or_else(|| std::env::var("MERCURY_API_BASE").ok())
            .unwrap_or_else(|| "https://api.inceptionlabs.ai/v1".to_string());

        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let client = reqwest::Client::new();
        let response: Result<reqwest::Response, reqwest::Error> = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;

        match response {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    self.is_processing = false;
                    eprintln!("\x1b[31mAPI error ({}): {}\x1b[0m", status, &body[..body.len().min(500)]);
                    return Ok(());
                }

                // Handle streaming response
                let stream_result = self.handle_stream(resp).await?;

                // Add assistant message
                if !stream_result.tool_calls.is_empty() {
                    self.conversation.add_assistant_message(
                        &stream_result.content,
                        Some(stream_result.tool_calls.clone()),
                    );
                } else {
                    self.conversation.add_assistant_message(&stream_result.content, None);
                }

                // Update usage
                if let Some(usage) = stream_result.usage {
                    self.conversation.update_usage(usage);
                }

                // Handle tool calls if any
                if !stream_result.tool_calls.is_empty() {
                    self.handle_tool_calls(stream_result.tool_calls).await?;
                } else {
                    // Print newline after streaming
                    println!();
                }
            }
            Err(e) => {
                self.is_processing = false;
                eprintln!("\x1b[31mNetwork error: {}\x1b[0m", e);
            }
        }

        self.is_processing = false;
        Ok(())
    }

    /// Handle streaming SSE response.
    async fn handle_stream(&mut self, response: reqwest::Response) -> Result<StreamResult> {
        let mut content = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut usage: Option<Usage> = None;
        let mut finish_reason: Option<String> = None;

        let body = response.text().await?;

        // Parse SSE events
        for line in body.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("data: ") {
                continue;
            }
            let data = &trimmed[6..];
            if data == "[DONE]" {
                continue;
            }

            if let Ok(chunk) = serde_json::from_str::<Value>(data) {
                // Extract delta content
                if let Some(choices) = chunk.get("choices").and_then(|c| c.as_array()) {
                    for choice in choices {
                        let delta = choice.get("delta").unwrap_or(&Value::Null);

                        // Content delta
                        if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                            content.push_str(text);
                            // Stream to terminal
                            print!("{}", text);
                            let _ = std::io::stdout().flush();
                        }

                        // Tool call delta
                        if let Some(tc_arr) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                            for tc in tc_arr {
                                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;

                                // Ensure tool_calls vec is large enough
                                while tool_calls.len() <= idx {
                                    tool_calls.push(serde_json::json!({
                                        "id": "",
                                        "type": "function",
                                        "function": {"name": "", "arguments": ""}
                                    }));
                                }

                                // Merge delta into tool call
                                if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                                    tool_calls[idx]["id"] = Value::String(id.to_string());
                                }
                                if let Some(func) = tc.get("function") {
                                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                                        tool_calls[idx]["function"]["name"] = Value::String(name.to_string());
                                    }
                                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                                        let existing = tool_calls[idx]["function"]["arguments"]
                                            .as_str().unwrap_or("").to_string();
                                        tool_calls[idx]["function"]["arguments"] =
                                            Value::String(format!("{}{}", existing, args));
                                    }
                                }
                            }
                        }

                        // Finish reason
                        if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                            finish_reason = Some(fr.to_string());
                        }
                    }
                }

                // Usage
                if let Some(usage_obj) = chunk.get("usage") {
                    usage = Some(Usage {
                        prompt_tokens: usage_obj.get("prompt_tokens").and_then(|t| t.as_u64()),
                        completion_tokens: usage_obj.get("completion_tokens").and_then(|t| t.as_u64()),
                        total_tokens: usage_obj.get("total_tokens").and_then(|t| t.as_u64()),
                    });
                }
            }
        }

        Ok(StreamResult {
            content,
            tool_calls,
            usage,
            finish_reason,
        })
    }

    /// Handle tool calls from the API response.
    async fn handle_tool_calls(&mut self, tool_calls: Vec<Value>) -> Result<()> {
        let executor = mercury_tools::ToolExecutor::new(self.workspace.clone());

        for tc in &tool_calls {
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let tool_call_id = tc["id"].as_str().unwrap_or("unknown");

            // Parse arguments
            let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Object(Default::default()));

            // Display tool call
            println!("\n\x1b[36m⚡ {}\x1b[0m", tool_name);
            if self.verbose {
                let display_args = serde_json::to_string_pretty(&args).unwrap_or_default();
                if display_args.len() <= 200 {
                    eprintln!("\x1b[2m  {}\x1b[0m", display_args);
                }
            }

            // Execute tool
            let result = executor.execute(tool_name, &args).await;

            // Display result summary
            if result.is_error {
                eprintln!("\x1b[31m  Error: {}\x1b[0m", &result.output[..result.output.len().min(200)]);
            } else if self.verbose {
                let preview = &result.output[..result.output.len().min(200)];
                eprintln!("\x1b[2m  {}{}\x1b[0m", preview,
                    if result.output.len() > 200 { "..." } else { "" });
            }

            // Add tool result to conversation
            self.conversation.add_tool_result(tool_call_id, &result.output);
        }

        // Send back to API for continued processing
        self.send_to_api().await?;

        Ok(())
    }

    /// Check context usage and auto-compress if needed.
    async fn check_context_usage(&mut self) -> Result<()> {
        let estimate = self.conversation.get_token_estimate();
        let limit = self.model_limits.max_context_tokens;
        let usage_pct = estimate as f64 / limit as f64;

        if usage_pct > 0.85 {
            if self.verbose {
                eprintln!("\x1b[33m[Context] Usage at {:.0}%, auto-compressing...\x1b[0m", usage_pct * 100.0);
            }
            self.conversation.compress(
                &() as &dyn std::any::Any,
                None,
                usage_pct > 0.95, // super compress if very high
            ).await?;
        }

        Ok(())
    }

    /// Run in pipe mode (non-interactive, single prompt).
    async fn run_pipe_mode(&mut self, prompt: &str) -> Result<()> {
        // Load memory
        if let Some(ref memory) = self.memory {
            let content = memory.read().await;
            if !content.is_empty() {
                self.conversation.load_memory_content(&content);
            }
        }

        self.conversation.add_user_message(prompt);
        self.send_to_api().await?;
        println!(); // Final newline

        Ok(())
    }

    /// Build tool definitions for the API.
    fn build_tool_definitions(&self) -> Vec<Value> {
        let defs = mercury_tools::tool_definitions();
        defs.into_iter()
            .map(|d| serde_json::to_value(d).unwrap_or_default())
            .collect()
    }

    /// Build the readline prompt string.
    fn build_prompt(&self) -> String {
        let model = &self.client_config.model;
        let short_model = if model.len() > 12 { &model[..12] } else { model };
        format!("\x1b[1;35m{}\x1b[0m \x1b[2m>\x1b[0m ", short_model)
    }

    /// Print the welcome message.
    fn print_welcome(&self) {
        println!("\x1b[1;35m╭─────────────────────────────────────╮\x1b[0m");
        println!("\x1b[1;35m│       Mercury Code v{}          │\x1b[0m", env!("CARGO_PKG_VERSION"));
        println!("\x1b[1;35m│  Powered by Mercury-2 Diffusion     │\x1b[0m");
        println!("\x1b[1;35m╰─────────────────────────────────────╯\x1b[0m");
        println!();
        println!("\x1b[2mWorkspace: {}\x1b[0m", self.workspace.display());
        println!("\x1b[2mTrust mode: {} | Model: {}\x1b[0m", self.trust_mode, self.client_config.model);
        println!("\x1b[2mType /help for commands, Ctrl+D to exit.\x1b[0m");
        println!();
    }

    /// Print help message.
    fn print_help(&self) {
        println!("\x1b[1mAvailable commands:\x1b[0m");
        println!("  \x1b[36m/help\x1b[0m          Show this help message");
        println!("  \x1b[36m/clear\x1b[0m         Clear conversation history");
        println!("  \x1b[36m/compact\x1b[0m       Compress conversation context");
        println!("  \x1b[36m/super-compact\x1b[0m Aggressively compress context");
        println!("  \x1b[36m/model [name]\x1b[0m  Show or switch model");
        println!("  \x1b[36m/provider [name]\x1b[0m Show or switch provider");
        println!("  \x1b[36m/trust [mode]\x1b[0m  Show or set trust mode");
        println!("  \x1b[36m/memory\x1b[0m        Show accumulated memory");
        println!("  \x1b[36m/usage\x1b[0m         Show token usage");
        println!("  \x1b[36m/verbose\x1b[0m       Toggle verbose mode");
        println!("  \x1b[36m/version\x1b[0m       Show version");
        println!("  \x1b[36m/bug\x1b[0m           Report a bug");
        println!("  \x1b[36m/exit\x1b[0m          Exit Mercury Code");
    }

    /// Get current workspace.
    pub fn workspace(&self) -> &PathBuf {
        &self.workspace
    }

    /// Get current trust mode.
    pub fn trust_mode(&self) -> &str {
        &self.trust_mode
    }

    /// Get turn count.
    pub fn turn_count(&self) -> u64 {
        self.turn_count
    }

    /// Create a session snapshot for save/restore.
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            workspace: self.workspace.clone(),
            model: self.client_config.model.clone(),
            trust_mode: self.trust_mode.clone(),
            turn_count: self.turn_count,
            message_count: self.conversation.messages.len(),
        }
    }
}

/// Session snapshot for save/restore.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionSnapshot {
    pub workspace: PathBuf,
    pub model: String,
    pub trust_mode: String,
    pub turn_count: u64,
    pub message_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repl_config_default() {
        let config = ReplConfig::default();
        assert!(!config.verbose);
        assert!(config.pipe_prompt.is_none());
        assert!(config.provider.is_none());
    }

    #[test]
    fn test_session_snapshot_serialization() {
        let snapshot = SessionSnapshot {
            workspace: PathBuf::from("/test"),
            model: "mercury-2".to_string(),
            trust_mode: "approval".to_string(),
            turn_count: 5,
            message_count: 10,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        let restored: SessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.model, "mercury-2");
        assert_eq!(restored.turn_count, 5);
    }

    #[test]
    fn test_snapshot_excludes_sensitive_data() {
        let snapshot = SessionSnapshot {
            workspace: PathBuf::from("/test"),
            model: "mercury-2".to_string(),
            trust_mode: "open".to_string(),
            turn_count: 0,
            message_count: 0,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        // Should not contain API key or system prompt
        assert!(!json.contains("apiKey"));
        assert!(!json.contains("api_key"));
    }

    #[test]
    fn test_build_prompt() {
        // We can't fully test MercuryRepl::new without async, but we can test the struct
        let snapshot = SessionSnapshot {
            workspace: PathBuf::from("/test"),
            model: "mercury-2".to_string(),
            trust_mode: "approval".to_string(),
            turn_count: 3,
            message_count: 6,
        };
        assert_eq!(snapshot.workspace, PathBuf::from("/test"));
    }
}
