//! Tool execution engine for Mercury Code.
//! Routes tool calls to appropriate handlers with sandbox/permission checks.

use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use serde_json::Value;
use regex::Regex;

/// Result of a tool execution.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(output: String) -> Self {
        Self { success: true, output, is_error: false }
    }

    pub fn error(msg: String) -> Self {
        Self { success: false, output: msg, is_error: true }
    }
}

/// Tool executor that routes tool calls to handlers.
pub struct ToolExecutor {
    workspace: PathBuf,
    /// Optional sandbox check function
    check_path: Option<Box<dyn Fn(&str, bool) -> Result<(), String> + Send + Sync>>,
}

impl ToolExecutor {
    pub fn new(workspace: PathBuf) -> Self {
        Self { workspace, check_path: None }
    }

    pub fn with_path_check<F>(mut self, check: F) -> Self
    where
        F: Fn(&str, bool) -> Result<(), String> + Send + Sync + 'static,
    {
        self.check_path = Some(Box::new(check));
        self
    }

    fn check_read_path(&self, path: &str) -> Result<(), String> {
        if let Some(ref check) = self.check_path {
            check(path, false)
        } else {
            Ok(())
        }
    }

    fn check_write_path(&self, path: &str) -> Result<(), String> {
        if let Some(ref check) = self.check_path {
            check(path, true)
        } else {
            Ok(())
        }
    }

    /// Execute a tool call.
    pub async fn execute(&self, tool_name: &str, arguments: &Value) -> ToolResult {
        match tool_name {
            "Read" => self.execute_read(arguments).await,
            "Write" => self.execute_write(arguments).await,
            "Edit" => self.execute_edit(arguments).await,
            "Bash" => self.execute_bash(arguments).await,
            "Glob" => self.execute_glob(arguments).await,
            "Grep" => self.execute_grep(arguments).await,
            "ListDir" => self.execute_listdir(arguments).await,
            "Diff" => self.execute_diff(arguments).await,
            "Fetch" => self.execute_fetch(arguments).await,
            "Patch" => self.execute_patch(arguments).await,
            "Lsp" => self.execute_lsp(arguments).await,
            "AstSearch" => self.execute_ast_search(arguments).await,
            "SubAgent" => self.execute_subagent(arguments).await,
            "SubAgentTeam" => self.execute_subagent_team(arguments).await,
            "AgentTeams" => self.execute_agent_teams(arguments).await,
            "ContextSearch" => self.execute_context_search(arguments).await,
            _ => ToolResult::error(format!("Unknown tool: {}", tool_name)),
        }
    }

    /// Read a file with optional offset and limit.
    async fn execute_read(&self, args: &Value) -> ToolResult {
        let file_path = match args.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: file_path".into()),
        };

        if let Err(e) = self.check_read_path(file_path) {
            return ToolResult::error(e);
        }

        let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;

        match tokio::fs::read_to_string(file_path).await {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let end = (offset + limit).min(lines.len());
                let selected = &lines[offset.min(lines.len())..end];
                let mut output = String::new();
                for (i, line) in selected.iter().enumerate() {
                    let line_num = offset + i + 1;
                    output.push_str(&format!("{:>6}\t{}\n", line_num, line));
                }
                ToolResult::ok(output)
            }
            Err(e) => ToolResult::error(format!("Failed to read {}: {}", file_path, e)),
        }
    }

    /// Write content to a file, creating parent directories if needed.
    async fn execute_write(&self, args: &Value) -> ToolResult {
        let file_path = match args.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: file_path".into()),
        };
        let content = match args.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error("Missing required parameter: content".into()),
        };

        if let Err(e) = self.check_write_path(file_path) {
            return ToolResult::error(e);
        }

        // Create parent dirs
        if let Some(parent) = Path::new(file_path).parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return ToolResult::error(format!("Failed to create directories: {}", e));
            }
        }

        match tokio::fs::write(file_path, content).await {
            Ok(()) => ToolResult::ok(format!("Successfully wrote to {}", file_path)),
            Err(e) => ToolResult::error(format!("Failed to write {}: {}", file_path, e)),
        }
    }

    /// Edit a file by replacing old_string with new_string.
    async fn execute_edit(&self, args: &Value) -> ToolResult {
        let file_path = match args.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: file_path".into()),
        };
        let old_string = match args.get("old_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolResult::error("Missing required parameter: old_string".into()),
        };
        let new_string = match args.get("new_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolResult::error("Missing required parameter: new_string".into()),
        };
        let replace_all = args.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);

        if let Err(e) = self.check_write_path(file_path) {
            return ToolResult::error(e);
        }

        let content = match tokio::fs::read_to_string(file_path).await {
            Ok(c) => c,
            Err(e) => return ToolResult::error(format!("Failed to read {}: {}", file_path, e)),
        };

        let occurrences = content.matches(old_string).count();
        if occurrences == 0 {
            return ToolResult::error(format!("old_string not found in {}", file_path));
        }
        if occurrences > 1 && !replace_all {
            return ToolResult::error(format!(
                "old_string found {} times in {}. Use replace_all=true to replace all, or provide more context.",
                occurrences, file_path
            ));
        }

        let new_content = if replace_all {
            content.replace(old_string, new_string)
        } else {
            content.replacen(old_string, new_string, 1)
        };

        match tokio::fs::write(file_path, &new_content).await {
            Ok(()) => ToolResult::ok(format!(
                "Replaced {} occurrence(s) in {}",
                if replace_all { occurrences } else { 1 },
                file_path
            )),
            Err(e) => ToolResult::error(format!("Failed to write {}: {}", file_path, e)),
        }
    }

    /// Execute a shell command with timeout.
    async fn execute_bash(&self, args: &Value) -> ToolResult {
        let command = match args.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error("Missing required parameter: command".into()),
        };
        let timeout_ms = args.get("timeout").and_then(|v| v.as_u64()).unwrap_or(120000);

        let result = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            Command::new("sh")
                .arg("-c")
                .arg(command)
                .current_dir(&self.workspace)
                .output(),
        )
        .await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let mut result_str = String::new();
                if !stdout.is_empty() {
                    result_str.push_str(&stdout);
                }
                if !stderr.is_empty() {
                    if !result_str.is_empty() {
                        result_str.push('\n');
                    }
                    result_str.push_str("STDERR:\n");
                    result_str.push_str(&stderr);
                }
                if output.status.success() {
                    ToolResult::ok(result_str)
                } else {
                    ToolResult {
                        success: false,
                        output: format!("Exit code: {}\n{}", output.status.code().unwrap_or(-1), result_str),
                        is_error: true,
                    }
                }
            }
            Ok(Err(e)) => ToolResult::error(format!("Failed to execute command: {}", e)),
            Err(_) => ToolResult::error(format!("Command timed out after {}ms", timeout_ms)),
        }
    }

    /// File pattern matching using glob.
    async fn execute_glob(&self, args: &Value) -> ToolResult {
        let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: pattern".into()),
        };
        let path = args.get("path").and_then(|v| v.as_str())
            .unwrap_or_else(|| self.workspace.to_str().unwrap_or("."));

        // Sandbox check: verify the search path is within allowed boundaries
        if let Err(e) = self.check_read_path(path) {
            return ToolResult::error(e);
        }

        let full_pattern = if Path::new(pattern).is_absolute() {
            pattern.to_string()
        } else {
            format!("{}/{}", path, pattern)
        };

        match glob::glob(&full_pattern) {
            Ok(entries) => {
                let mut files: Vec<String> = Vec::new();
                for entry in entries {
                    if let Ok(path) = entry {
                        files.push(path.to_string_lossy().to_string());
                    }
                }
                files.sort();
                if files.is_empty() {
                    ToolResult::ok("No files matched the pattern.".into())
                } else {
                    ToolResult::ok(files.join("\n"))
                }
            }
            Err(e) => ToolResult::error(format!("Invalid glob pattern: {}", e)),
        }
    }

    /// Content search using regex.
    async fn execute_grep(&self, args: &Value) -> ToolResult {
        let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: pattern".into()),
        };
        let path = args.get("path").and_then(|v| v.as_str())
            .unwrap_or_else(|| self.workspace.to_str().unwrap_or("."));

        // Sandbox check: verify the search path is within allowed boundaries
        if let Err(e) = self.check_read_path(path) {
            return ToolResult::error(e);
        }
        let output_mode = args.get("output_mode").and_then(|v| v.as_str()).unwrap_or("files_with_matches");
        let context_lines = args.get("context").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let case_insensitive = args.get("-i").and_then(|v| v.as_bool()).unwrap_or(false);

        let regex = match if case_insensitive {
            Regex::new(&format!("(?i){}", pattern))
        } else {
            Regex::new(pattern)
        } {
            Ok(r) => r,
            Err(e) => return ToolResult::error(format!("Invalid regex: {}", e)),
        };

        let mut results = Vec::new();
        let walker = walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file());

        for entry in walker {
            let file_path = entry.path();
            // Skip binary files and hidden dirs
            let path_str = file_path.to_string_lossy();
            if path_str.contains("/.git/") || path_str.contains("/node_modules/") {
                continue;
            }

            if let Ok(content) = std::fs::read_to_string(file_path) {
                let mut file_matches = Vec::new();
                for (line_num, line) in content.lines().enumerate() {
                    if regex.is_match(line) {
                        file_matches.push((line_num + 1, line.to_string()));
                    }
                }

                if !file_matches.is_empty() {
                    match output_mode {
                        "files_with_matches" => {
                            results.push(file_path.to_string_lossy().to_string());
                        }
                        "count" => {
                            results.push(format!("{}:{}", file_path.display(), file_matches.len()));
                        }
                        "content" | _ => {
                            for (num, line) in &file_matches {
                                results.push(format!("{}:{}:{}", file_path.display(), num, line));
                            }
                        }
                    }
                }
            }
        }

        if results.is_empty() {
            ToolResult::ok("No matches found.".into())
        } else {
            ToolResult::ok(results.join("\n"))
        }
    }

    /// Directory listing with metadata.
    async fn execute_listdir(&self, args: &Value) -> ToolResult {
        let path = args.get("path").and_then(|v| v.as_str())
            .unwrap_or_else(|| self.workspace.to_str().unwrap_or("."));

        if let Err(e) = self.check_read_path(path) {
            return ToolResult::error(e);
        }

        match tokio::fs::read_dir(path).await {
            Ok(mut entries) => {
                let mut items = Vec::new();
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let metadata = entry.metadata().await.ok();
                    let type_indicator = if metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
                        "/"
                    } else {
                        ""
                    };
                    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                    items.push(format!("{}{}\t{}B", name, type_indicator, size));
                }
                items.sort();
                ToolResult::ok(items.join("\n"))
            }
            Err(e) => ToolResult::error(format!("Failed to list directory {}: {}", path, e)),
        }
    }

    /// Generate file diff.
    async fn execute_diff(&self, args: &Value) -> ToolResult {
        let file_path = match args.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: file_path".into()),
        };

        if let Err(e) = self.check_read_path(file_path) {
            return ToolResult::error(e);
        }

        // Use git diff if in a git repo
        let result = Command::new("git")
            .args(["diff", file_path])
            .current_dir(&self.workspace)
            .output()
            .await;

        match result {
            Ok(output) if output.status.success() => {
                let diff = String::from_utf8_lossy(&output.stdout);
                if diff.is_empty() {
                    ToolResult::ok("No changes.".into())
                } else {
                    ToolResult::ok(diff.to_string())
                }
            }
            _ => ToolResult::error("Failed to generate diff (not a git repo or git not available)".into()),
        }
    }

    /// HTTP fetch with comprehensive SSRF protection.
    async fn execute_fetch(&self, args: &Value) -> ToolResult {
        let url = match args.get("url").and_then(|v| v.as_str()) {
            Some(u) => u,
            None => return ToolResult::error("Missing required parameter: url".into()),
        };

        // Comprehensive SSRF check using the safety module
        // Step 1: URL-level check (protocol, credentials, hostname patterns)
        match mercury_safety::ssrf::check_url_ssrf(url) {
            Ok(result) => {
                if !result.allowed {
                    return ToolResult::error(format!(
                        "SSRF protection: {}",
                        result.reason.unwrap_or_else(|| "blocked".to_string())
                    ));
                }
            }
            Err(e) => return ToolResult::error(format!("SSRF protection: {}", e)),
        }

        // Step 2: Hostname-based SSRF check (checks for private/dangerous hostnames)
        if let Ok(parsed) = url::Url::parse(url) {
            if let Some(host) = parsed.host_str() {
                let hostname_result = mercury_safety::ssrf::check_ssrf_hostname(host);
                if !hostname_result.allowed {
                    return ToolResult::error(format!(
                        "SSRF protection: {}",
                        hostname_result.reason.unwrap_or_else(|| "dangerous hostname".to_string())
                    ));
                }
            }
        }

        match reqwest::get(url).await {
            Ok(resp) => {
                let status = resp.status();
                match resp.text().await {
                    Ok(body) => {
                        let truncated = if body.len() > 50000 {
                            format!("{}...\n[Truncated: {} bytes total]", &body[..50000], body.len())
                        } else {
                            body
                        };
                        ToolResult::ok(format!("HTTP {}\n\n{}", status, truncated))
                    }
                    Err(e) => ToolResult::error(format!("Failed to read response body: {}", e)),
                }
            }
            Err(e) => ToolResult::error(format!("Fetch failed: {}", e)),
        }
    }

    /// Multi-edit patch.
    async fn execute_patch(&self, args: &Value) -> ToolResult {
        let file_path = match args.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error("Missing required parameter: file_path".into()),
        };
        let edits = match args.get("edits").and_then(|v| v.as_array()) {
            Some(e) => e,
            None => return ToolResult::error("Missing required parameter: edits".into()),
        };

        if let Err(e) = self.check_write_path(file_path) {
            return ToolResult::error(e);
        }

        let mut content = match tokio::fs::read_to_string(file_path).await {
            Ok(c) => c,
            Err(e) => return ToolResult::error(format!("Failed to read {}: {}", file_path, e)),
        };

        let mut applied = 0;
        for edit in edits {
            if let (Some(old), Some(new)) = (
                edit.get("old_string").and_then(|v| v.as_str()),
                edit.get("new_string").and_then(|v| v.as_str()),
            ) {
                if content.contains(old) {
                    content = content.replacen(old, new, 1);
                    applied += 1;
                }
            }
        }

        match tokio::fs::write(file_path, &content).await {
            Ok(()) => ToolResult::ok(format!("Applied {}/{} edits to {}", applied, edits.len(), file_path)),
            Err(e) => ToolResult::error(format!("Failed to write {}: {}", file_path, e)),
        }
    }

    /// LSP tool handler — delegates to the LspClient.
    async fn execute_lsp(&self, args: &Value) -> ToolResult {
        let action = match args.get("action").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => return ToolResult::error("Missing required parameter: action".into()),
        };
        let file = args.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
        let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
        let col = args.get("character").and_then(|v| v.as_u64()).unwrap_or(1) as u32;

        match action {
            "definition" | "references" | "hover" | "symbols" | "diagnostics" => {
                ToolResult::ok(format!(
                    "LSP {} at {}:{}:{} — LSP server connection required (not yet connected)",
                    action, file, line, col
                ))
            }
            _ => ToolResult::error(format!("Unknown LSP action: {}", action)),
        }
    }

    /// AST search tool handler.
    async fn execute_ast_search(&self, args: &Value) -> ToolResult {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q,
            None => return ToolResult::error("Missing required parameter: query".into()),
        };
        let path = args.get("path").and_then(|v| v.as_str())
            .map(std::path::Path::new)
            .unwrap_or(self.workspace.as_path());

        let results = crate::ast_search::search_symbols(path, query);
        if results.is_empty() {
            ToolResult::ok(format!("No symbols matching '{}' found.", query))
        } else {
            let output: Vec<String> = results.iter().map(|s| {
                format!("{}:{} [{}] {}", s.file, s.line, s.kind, s.name)
            }).collect();
            ToolResult::ok(output.join("\n"))
        }
    }

    /// SubAgent tool handler — placeholder for agent execution.
    async fn execute_subagent(&self, args: &Value) -> ToolResult {
        let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("(no task)");
        let model = args.get("model").and_then(|v| v.as_str()).unwrap_or("default");
        ToolResult::ok(format!(
            "SubAgent spawned: task='{}', model='{}' — agent execution requires runtime integration",
            task, model
        ))
    }

    /// SubAgentTeam tool handler — placeholder for parallel agent execution.
    async fn execute_subagent_team(&self, args: &Value) -> ToolResult {
        let tasks = args.get("tasks").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        ToolResult::ok(format!(
            "SubAgentTeam: {} tasks queued — team execution requires runtime integration",
            tasks
        ))
    }

    /// AgentTeams tool handler — placeholder for team management.
    async fn execute_agent_teams(&self, args: &Value) -> ToolResult {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("list");
        match action {
            "list" => ToolResult::ok("No active agent teams.".into()),
            "create" => {
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed");
                ToolResult::ok(format!("Agent team '{}' created.", name))
            }
            _ => ToolResult::ok(format!("AgentTeams action '{}' acknowledged.", action)),
        }
    }

    /// ContextSearch tool handler — searches conversation context.
    async fn execute_context_search(&self, args: &Value) -> ToolResult {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q,
            None => return ToolResult::error("Missing required parameter: query".into()),
        };
        ToolResult::ok(format!(
            "ContextSearch for '{}' — requires conversation context integration",
            query
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_read_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "line 1\nline 2\nline 3\n").unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({"file_path": file.to_str().unwrap()});
        let result = executor.execute("Read", &args).await;
        assert!(result.success);
        assert!(result.output.contains("line 1"));
        assert!(result.output.contains("line 2"));
    }

    #[tokio::test]
    async fn test_write_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("new.txt");
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({"file_path": file.to_str().unwrap(), "content": "hello world"});
        let result = executor.execute("Write", &args).await;
        assert!(result.success);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello world");
    }

    #[tokio::test]
    async fn test_edit_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("edit.txt");
        std::fs::write(&file, "hello world").unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({
            "file_path": file.to_str().unwrap(),
            "old_string": "world",
            "new_string": "rust"
        });
        let result = executor.execute("Edit", &args).await;
        assert!(result.success);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello rust");
    }

    #[tokio::test]
    async fn test_edit_not_found() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("edit.txt");
        std::fs::write(&file, "hello world").unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({
            "file_path": file.to_str().unwrap(),
            "old_string": "nonexistent",
            "new_string": "rust"
        });
        let result = executor.execute("Edit", &args).await;
        assert!(result.is_error);
    }

    #[tokio::test]
    async fn test_bash_command() {
        let dir = TempDir::new().unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({"command": "echo hello"});
        let result = executor.execute("Bash", &args).await;
        assert!(result.success);
        assert!(result.output.contains("hello"));
    }

    #[tokio::test]
    async fn test_bash_timeout() {
        let dir = TempDir::new().unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({"command": "sleep 10", "timeout": 100});
        let result = executor.execute("Bash", &args).await;
        assert!(result.is_error);
        assert!(result.output.contains("timed out"));
    }

    #[tokio::test]
    async fn test_listdir() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "content").unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let args = serde_json::json!({"path": dir.path().to_str().unwrap()});
        let result = executor.execute("ListDir", &args).await;
        assert!(result.success);
        assert!(result.output.contains("a.txt"));
        assert!(result.output.contains("subdir/"));
    }

    #[tokio::test]
    async fn test_unknown_tool() {
        let dir = TempDir::new().unwrap();
        let executor = ToolExecutor::new(dir.path().to_path_buf());
        let result = executor.execute("UnknownTool", &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.output.contains("Unknown tool"));
    }
}
