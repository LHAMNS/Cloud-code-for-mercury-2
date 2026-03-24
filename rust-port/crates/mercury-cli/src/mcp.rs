// Mercury Code - MCP (Model Context Protocol) Server Manager
// Manages external tool servers connected via stdio or HTTP transports.
// Ported from: src/mcp.js

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::fs;

use crate::utils::{debug_log, env_sanitize};

/// MCP tool name prefix.
pub const MCP_PREFIX: &str = "mcp__";

/// Maximum MCP response size (10MB).
const MAX_MCP_RESPONSE_SIZE: usize = 10 * 1024 * 1024;

// ── McpServer ────────────────────────────────────────────────────────────────

/// Tool definition from an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// An MCP tool with its namespaced name.
#[derive(Debug, Clone)]
pub struct NamespacedMcpTool {
    pub name: String,
    pub namespaced_name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// MCP server status.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub name: String,
    pub ready: bool,
    pub tools: usize,
    pub transport: String,
}

/// Configuration for a single MCP server.
#[derive(Debug, Deserialize)]
struct McpServerConfig {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    transport: Option<String>,
}

/// Top-level MCP configuration file format.
#[derive(Debug, Deserialize)]
struct McpConfig {
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<HashMap<String, McpServerConfig>>,
}

/// Represents a single MCP server connection (stdio transport).
struct McpServer {
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    transport: String,
    is_project_config: bool,
    tools: Vec<McpTool>,
    ready: bool,
    request_id: AtomicU64,
}

impl McpServer {
    fn new(name: &str, config: &McpServerConfig, is_project_config: bool) -> Self {
        let transport = config
            .transport
            .clone()
            .unwrap_or_else(|| {
                if config.url.is_some() {
                    "http".to_string()
                } else {
                    "stdio".to_string()
                }
            });

        Self {
            name: name.to_string(),
            command: config.command.clone().unwrap_or_default(),
            args: config.args.clone().unwrap_or_default(),
            env: config.env.clone().unwrap_or_default(),
            url: config.url.clone(),
            transport,
            is_project_config,
            tools: Vec::new(),
            ready: false,
            request_id: AtomicU64::new(0),
        }
    }

    /// Start the MCP server and discover tools.
    async fn start(&mut self) -> anyhow::Result<()> {
        if self.transport == "http" {
            self.start_http().await
        } else {
            self.start_stdio().await
        }
    }

    async fn start_stdio(&mut self) -> anyhow::Result<()> {
        let base_env = env_sanitize::sanitize_env();
        let mut env = base_env.clone();

        // Merge server env, re-filtering sensitive vars
        for (key, value) in &self.env {
            if env_sanitize::is_sensitive_env_key(key) {
                debug_log(
                    "McpServer.start_stdio",
                    &format!("Blocked sensitive env var from MCP config: {}", key),
                );
                continue;
            }
            env.insert(key.clone(), value.clone());
        }

        // Initialize: send initialize + tools/list via a single child process
        let id = self.request_id.fetch_add(1, Ordering::SeqCst) + 1;
        let init_msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "mercury-code", "version": "1.4.1" }
            }
        });

        let id2 = self.request_id.fetch_add(1, Ordering::SeqCst) + 1;
        let list_msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id2,
            "method": "tools/list",
            "params": {}
        });

        let payload = format!("{}\n{}\n", init_msg, list_msg);

        let output = Command::new(&self.command)
            .args(&self.args)
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                if let Some(ref mut stdin) = child.stdin {
                    let _ = stdin.write_all(payload.as_bytes());
                    let _ = stdin.flush();
                }
                // Give the server a moment then read
                child.wait_with_output()
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(result) = msg.get("result") {
                    if let Some(tools) = result.get("tools").and_then(|t| t.as_array()) {
                        self.tools = tools
                            .iter()
                            .filter_map(|t| {
                                Some(McpTool {
                                    name: t.get("name")?.as_str()?.to_string(),
                                    description: t
                                        .get("description")
                                        .and_then(|d| d.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    input_schema: t
                                        .get("inputSchema")
                                        .cloned()
                                        .unwrap_or(serde_json::json!({"type": "object", "properties": {}})),
                                })
                            })
                            .collect();
                    }
                }
            }
        }

        self.ready = true;
        Ok(())
    }

    async fn start_http(&mut self) -> anyhow::Result<()> {
        // For HTTP transport, we'd make HTTP requests to discover tools
        // Simplified implementation: just mark as ready with no tools for now
        self.ready = true;
        Ok(())
    }

    /// Call a tool on the MCP server.
    async fn call_tool(&self, tool_name: &str, args: &serde_json::Value) -> anyhow::Result<String> {
        if self.transport == "http" {
            return self.call_tool_http(tool_name, args).await;
        }

        let id = self.request_id.fetch_add(1, Ordering::SeqCst) + 1;
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool_name, "arguments": args }
        });

        let env = env_sanitize::sanitize_env();
        let payload = format!("{}\n", msg);

        let output = Command::new(&self.command)
            .args(&self.args)
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                if let Some(ref mut stdin) = child.stdin {
                    let _ = stdin.write_all(payload.as_bytes());
                    let _ = stdin.flush();
                }
                child.wait_with_output()
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(result) = msg.get("result") {
                    if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
                        let parts: Vec<String> = content
                            .iter()
                            .map(|c| {
                                if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    c.get("text")
                                        .and_then(|t| t.as_str())
                                        .unwrap_or("")
                                        .to_string()
                                } else {
                                    serde_json::to_string(c).unwrap_or_default()
                                }
                            })
                            .collect();
                        return Ok(parts.join("\n"));
                    }
                    return Ok(serde_json::to_string(result)?);
                }
                if let Some(error) = msg.get("error") {
                    let err_msg = error
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown MCP error");
                    return Err(anyhow::anyhow!("MCP error: {}", err_msg));
                }
            }
        }

        Err(anyhow::anyhow!("No response from MCP server"))
    }

    async fn call_tool_http(
        &self,
        _tool_name: &str,
        _args: &serde_json::Value,
    ) -> anyhow::Result<String> {
        Err(anyhow::anyhow!("HTTP MCP transport not yet implemented"))
    }

    fn get_tools(&self) -> Vec<NamespacedMcpTool> {
        self.tools
            .iter()
            .map(|t| NamespacedMcpTool {
                name: t.name.clone(),
                namespaced_name: format!("mcp__{}_{}", self.name, t.name),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
            })
            .collect()
    }
}

// ── McpManager ──────────────────────────────────────────────────────────────

/// Manages multiple MCP server connections and provides unified tool access.
pub struct McpManager {
    servers: HashMap<String, McpServer>,
    loaded: bool,
}

/// Result of loading MCP configuration.
#[derive(Debug)]
pub struct McpLoadResult {
    pub loaded: bool,
    pub path: Option<String>,
    pub count: usize,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            servers: HashMap::new(),
            loaded: false,
        }
    }

    /// Load MCP configuration from file.
    pub async fn load_config(
        &mut self,
        workspace: &Path,
        explicit_path: Option<&str>,
        allow_project_config: bool,
    ) -> McpLoadResult {
        let mut candidates = Vec::new();
        let global_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".mercury")
            .join("mcp.json");

        if let Some(path) = explicit_path {
            candidates.push(PathBuf::from(path));
        } else if allow_project_config {
            candidates.push(workspace.join(".mercury").join("mcp.json"));
            candidates.push(workspace.join(".mcp.json"));
        }
        candidates.push(global_path.clone());

        for config_path in &candidates {
            let data = match fs::read_to_string(config_path).await {
                Ok(d) => d,
                Err(_) => continue,
            };

            let config: McpConfig = match serde_json::from_str(&data) {
                Ok(c) => c,
                Err(e) => {
                    debug_log("McpManager.load_config.parse", &e);
                    continue;
                }
            };

            if let Some(servers_config) = config.mcp_servers {
                let is_project_config =
                    config_path != &global_path && explicit_path.map(PathBuf::from).as_ref() != Some(config_path);

                if is_project_config {
                    eprintln!(
                        "\x1b[33m[mcp] Warning: Loading MCP servers from project config: {}\x1b[0m",
                        config_path.display()
                    );
                }

                self.start_servers(servers_config, is_project_config).await;
                self.loaded = true;

                return McpLoadResult {
                    loaded: true,
                    path: Some(config_path.to_string_lossy().to_string()),
                    count: self.servers.len(),
                };
            }
        }

        self.loaded = true;
        McpLoadResult {
            loaded: false,
            path: None,
            count: 0,
        }
    }

    async fn start_servers(
        &mut self,
        servers_config: HashMap<String, McpServerConfig>,
        is_project_config: bool,
    ) {
        for (name, config) in servers_config {
            if config.command.is_none() && config.url.is_none() {
                continue;
            }

            let mut server = McpServer::new(&name, &config, is_project_config);
            match server.start().await {
                Ok(()) => {
                    self.servers.insert(name, server);
                }
                Err(e) => {
                    debug_log(
                        &format!("McpManager.start_servers.{}", name),
                        &e,
                    );
                }
            }
        }
    }

    /// Get all available MCP tools as function calling format definitions.
    pub fn get_tool_definitions(&self) -> Vec<serde_json::Value> {
        let mut defs = Vec::new();
        for server in self.servers.values() {
            if !server.ready {
                continue;
            }
            for tool in server.get_tools() {
                defs.push(serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.namespaced_name,
                        "description": format!("[MCP: {}] {}", server.name, tool.description),
                        "parameters": tool.input_schema,
                    }
                }));
            }
        }
        defs
    }

    /// Execute an MCP tool by its namespaced name.
    pub async fn execute_tool(
        &self,
        namespaced_name: &str,
        args: &serde_json::Value,
    ) -> anyhow::Result<String> {
        let parts: Vec<&str> = namespaced_name.splitn(3, "__").collect();
        if parts.len() < 3 || parts[0] != "mcp" {
            return Err(anyhow::anyhow!(
                "Invalid MCP tool name: {}",
                namespaced_name
            ));
        }

        let server_name = parts[1];
        let tool_name = parts[2];

        let server = self
            .servers
            .get(server_name)
            .ok_or_else(|| anyhow::anyhow!("MCP server not found: {}", server_name))?;

        if !server.ready {
            return Err(anyhow::anyhow!("MCP server not ready: {}", server_name));
        }

        // Validate MCP tool arguments
        validate_mcp_args(args)?;

        server.call_tool(tool_name, args).await
    }

    /// Check if a tool name is an MCP tool.
    pub fn is_mcp_tool(name: &str) -> bool {
        name.starts_with(MCP_PREFIX)
    }

    /// Get status of all MCP servers.
    pub fn get_status(&self) -> Vec<McpServerStatus> {
        self.servers
            .iter()
            .map(|(name, server)| McpServerStatus {
                name: name.clone(),
                ready: server.ready,
                tools: server.tools.len(),
                transport: server.transport.clone(),
            })
            .collect()
    }

    /// Shutdown all MCP servers.
    pub async fn shutdown(&mut self) {
        self.servers.clear();
    }

    pub fn server_count(&self) -> usize {
        self.servers.len()
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }
}

/// Validate MCP tool arguments for dangerous values.
fn validate_mcp_args(args: &serde_json::Value) -> anyhow::Result<()> {
    if let Some(obj) = args.as_object() {
        for (key, value) in obj {
            if let Some(s) = value.as_str() {
                if s.contains('\0') {
                    return Err(anyhow::anyhow!(
                        "MCP argument \"{}\" contains null bytes",
                        key
                    ));
                }
                let lk = key.to_lowercase();
                if (lk.contains("path") || lk.contains("file") || lk.contains("dir"))
                    && (s.contains("../") || s.contains("..\\"))
                {
                    return Err(anyhow::anyhow!(
                        "MCP argument \"{}\" contains path traversal (..)",
                        key
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_mcp_tool() {
        assert!(McpManager::is_mcp_tool("mcp__filesystem__readFile"));
        assert!(!McpManager::is_mcp_tool("Read"));
        assert!(!McpManager::is_mcp_tool("Bash"));
    }

    #[test]
    fn test_validate_mcp_args_null_bytes() {
        let args = serde_json::json!({"path": "file\0.txt"});
        assert!(validate_mcp_args(&args).is_err());
    }

    #[test]
    fn test_validate_mcp_args_traversal() {
        let args = serde_json::json!({"file_path": "../../../etc/passwd"});
        assert!(validate_mcp_args(&args).is_err());
    }

    #[test]
    fn test_validate_mcp_args_ok() {
        let args = serde_json::json!({"file_path": "/workspace/src/main.rs", "content": "hello"});
        assert!(validate_mcp_args(&args).is_ok());
    }

    #[test]
    fn test_mcp_manager_new() {
        let mgr = McpManager::new();
        assert_eq!(mgr.server_count(), 0);
        assert!(!mgr.is_loaded());
    }
}
