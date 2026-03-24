//! Language Server Protocol client for Mercury Code.
//! Manages LSP server lifecycle and provides goto-definition, references, hover, etc.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use serde_json::Value;

/// LSP client for communicating with language servers.
pub struct LspClient {
    server_command: String,
    server_args: Vec<String>,
    workspace: PathBuf,
    child: Option<Child>,
    request_id: i64,
    initialized: bool,
}

impl LspClient {
    pub fn new(command: &str, args: &[&str], workspace: &Path) -> Self {
        Self {
            server_command: command.to_string(),
            server_args: args.iter().map(|s| s.to_string()).collect(),
            workspace: workspace.to_path_buf(),
            child: None,
            request_id: 0,
            initialized: false,
        }
    }

    /// Start the LSP server process.
    pub async fn start(&mut self) -> anyhow::Result<()> {
        // Sanitize environment before spawning
        let env = sanitize_env();

        let child = Command::new(&self.server_command)
            .args(&self.server_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .envs(env)
            .current_dir(&self.workspace)
            .spawn()?;

        self.child = Some(child);
        self.send_initialize().await?;
        self.initialized = true;
        Ok(())
    }

    /// Send the LSP initialize request.
    async fn send_initialize(&mut self) -> anyhow::Result<Value> {
        let params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": format!("file://{}", self.workspace.display()),
            "capabilities": {
                "textDocument": {
                    "definition": {"dynamicRegistration": false},
                    "references": {"dynamicRegistration": false},
                    "hover": {"contentFormat": ["plaintext", "markdown"]},
                    "documentSymbol": {"dynamicRegistration": false}
                }
            }
        });
        self.send_request("initialize", params).await
    }

    /// Send a JSON-RPC request to the server.
    async fn send_request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.request_id += 1;
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params
        });

        let body = serde_json::to_string(&request)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());

        if let Some(ref mut child) = self.child {
            if let Some(ref mut stdin) = child.stdin {
                stdin.write_all(header.as_bytes()).await?;
                stdin.write_all(body.as_bytes()).await?;
                stdin.flush().await?;
            }

            // Read response
            if let Some(ref mut stdout) = child.stdout {
                let mut reader = BufReader::new(stdout);
                let mut header_line = String::new();
                reader.read_line(&mut header_line).await?;

                // Parse Content-Length
                let content_length: usize = header_line
                    .trim()
                    .strip_prefix("Content-Length: ")
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(0);

                // Read empty line
                let mut empty = String::new();
                reader.read_line(&mut empty).await?;

                // Read body
                let mut body_buf = vec![0u8; content_length];
                tokio::io::AsyncReadExt::read_exact(&mut reader, &mut body_buf).await?;

                let response: Value = serde_json::from_slice(&body_buf)?;
                if let Some(result) = response.get("result") {
                    return Ok(result.clone());
                }
                if let Some(error) = response.get("error") {
                    anyhow::bail!("LSP error: {}", error);
                }
                return Ok(response);
            }
        }

        anyhow::bail!("LSP server not running")
    }

    /// Convert 1-based line/column to 0-based (LSP uses 0-based).
    pub fn to_lsp_position(line: u32, col: u32) -> (u32, u32) {
        (line.saturating_sub(1), col.saturating_sub(1))
    }

    /// Convert 0-based LSP position to 1-based.
    pub fn from_lsp_position(line: u32, col: u32) -> (u32, u32) {
        (line + 1, col + 1)
    }

    /// Normalize a file:// URI to a local path.
    pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
        uri.strip_prefix("file://").map(PathBuf::from)
    }

    /// Convert a local path to file:// URI.
    pub fn path_to_uri(path: &Path) -> String {
        format!("file://{}", path.display())
    }

    /// Go to definition of a symbol at a position.
    pub async fn goto_definition(&mut self, file: &Path, line: u32, col: u32) -> anyhow::Result<Vec<Location>> {
        let (lsp_line, lsp_col) = Self::to_lsp_position(line, col);
        let params = serde_json::json!({
            "textDocument": {"uri": Self::path_to_uri(file)},
            "position": {"line": lsp_line, "character": lsp_col}
        });

        let result = self.send_request("textDocument/definition", params).await?;
        Ok(parse_locations(&result))
    }

    /// Find all references to a symbol.
    pub async fn find_references(&mut self, file: &Path, line: u32, col: u32) -> anyhow::Result<Vec<Location>> {
        let (lsp_line, lsp_col) = Self::to_lsp_position(line, col);
        let params = serde_json::json!({
            "textDocument": {"uri": Self::path_to_uri(file)},
            "position": {"line": lsp_line, "character": lsp_col},
            "context": {"includeDeclaration": true}
        });

        let result = self.send_request("textDocument/references", params).await?;
        Ok(parse_locations(&result))
    }

    /// Get hover information for a symbol.
    pub async fn hover(&mut self, file: &Path, line: u32, col: u32) -> anyhow::Result<Option<String>> {
        let (lsp_line, lsp_col) = Self::to_lsp_position(line, col);
        let params = serde_json::json!({
            "textDocument": {"uri": Self::path_to_uri(file)},
            "position": {"line": lsp_line, "character": lsp_col}
        });

        let result = self.send_request("textDocument/hover", params).await?;
        if result.is_null() {
            return Ok(None);
        }

        let contents = result.get("contents");
        if let Some(content) = contents {
            if let Some(s) = content.as_str() {
                return Ok(Some(s.to_string()));
            }
            if let Some(obj) = content.as_object() {
                if let Some(value) = obj.get("value").and_then(|v| v.as_str()) {
                    return Ok(Some(value.to_string()));
                }
            }
        }

        Ok(None)
    }

    /// Get document symbols (outline).
    pub async fn document_symbols(&mut self, file: &Path) -> anyhow::Result<Vec<DocumentSymbol>> {
        let params = serde_json::json!({
            "textDocument": {"uri": Self::path_to_uri(file)}
        });

        let result = self.send_request("textDocument/documentSymbol", params).await?;
        Ok(parse_document_symbols(&result))
    }

    /// Get diagnostics (requires server push, this is a placeholder).
    pub fn get_diagnostics(&self) -> Vec<Diagnostic> {
        // In real implementation, diagnostics come via notifications
        Vec::new()
    }

    /// Shutdown the LSP server.
    pub async fn shutdown(&mut self) -> anyhow::Result<()> {
        if self.initialized {
            let _ = self.send_request("shutdown", Value::Null).await;
            // Send exit notification
            if let Some(ref mut child) = self.child {
                if let Some(ref mut stdin) = child.stdin {
                    let exit = serde_json::json!({"jsonrpc": "2.0", "method": "exit"});
                    let body = serde_json::to_string(&exit)?;
                    let header = format!("Content-Length: {}\r\n\r\n", body.len());
                    let _ = stdin.write_all(header.as_bytes()).await;
                    let _ = stdin.write_all(body.as_bytes()).await;
                }
                let _ = child.kill().await;
            }
            self.initialized = false;
        }
        Ok(())
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
    }
}

/// A location in a file.
#[derive(Debug, Clone)]
pub struct Location {
    pub file: PathBuf,
    pub line: u32,
    pub col: u32,
}

/// A document symbol.
#[derive(Debug, Clone)]
pub struct DocumentSymbol {
    pub name: String,
    pub kind: String,
    pub line: u32,
}

/// A diagnostic message.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub file: PathBuf,
    pub line: u32,
    pub severity: String,
    pub message: String,
}

/// Parse location(s) from LSP response.
fn parse_locations(value: &Value) -> Vec<Location> {
    let mut locations = Vec::new();

    let items = if value.is_array() {
        value.as_array().unwrap().clone()
    } else if value.is_object() {
        vec![value.clone()]
    } else {
        return locations;
    };

    for item in items {
        if let (Some(uri), Some(range)) = (
            item.get("uri").and_then(|v| v.as_str()),
            item.get("range"),
        ) {
            let file = LspClient::uri_to_path(uri).unwrap_or_default();
            let start = range.get("start").unwrap_or(&Value::Null);
            let line = start.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let col = start.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let (display_line, display_col) = LspClient::from_lsp_position(line, col);
            locations.push(Location { file, line: display_line, col: display_col });
        }
    }

    locations
}

/// Parse document symbols from LSP response.
fn parse_document_symbols(value: &Value) -> Vec<DocumentSymbol> {
    let mut symbols = Vec::new();

    if let Some(arr) = value.as_array() {
        for item in arr {
            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                let kind_num = item.get("kind").and_then(|v| v.as_u64()).unwrap_or(0);
                let kind = symbol_kind_name(kind_num);
                let line = item.get("range")
                    .and_then(|r| r.get("start"))
                    .and_then(|s| s.get("line"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                symbols.push(DocumentSymbol {
                    name: name.to_string(),
                    kind,
                    line: line + 1,
                });
            }
        }
    }

    symbols
}

fn symbol_kind_name(kind: u64) -> String {
    match kind {
        1 => "File", 2 => "Module", 3 => "Namespace", 5 => "Class",
        6 => "Method", 7 => "Property", 8 => "Field", 9 => "Constructor",
        10 => "Enum", 11 => "Interface", 12 => "Function", 13 => "Variable",
        14 => "Constant", 23 => "Struct", 26 => "TypeParameter",
        _ => "Unknown",
    }.to_string()
}

/// Sanitize environment variables before spawning LSP server.
fn sanitize_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    // Remove sensitive variables
    for key in &["INCEPTION_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"] {
        env.remove(*key);
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_lsp_position() {
        assert_eq!(LspClient::to_lsp_position(1, 1), (0, 0));
        assert_eq!(LspClient::to_lsp_position(10, 5), (9, 4));
    }

    #[test]
    fn test_from_lsp_position() {
        assert_eq!(LspClient::from_lsp_position(0, 0), (1, 1));
        assert_eq!(LspClient::from_lsp_position(9, 4), (10, 5));
    }

    #[test]
    fn test_uri_to_path() {
        assert_eq!(LspClient::uri_to_path("file:///home/user/file.rs"), Some(PathBuf::from("/home/user/file.rs")));
        assert_eq!(LspClient::uri_to_path("https://example.com"), None);
    }

    #[test]
    fn test_path_to_uri() {
        assert_eq!(LspClient::path_to_uri(Path::new("/home/user/file.rs")), "file:///home/user/file.rs");
    }

    #[test]
    fn test_sanitize_env() {
        std::env::set_var("TEST_SAFE_VAR", "safe");
        let env = sanitize_env();
        assert!(env.contains_key("TEST_SAFE_VAR"));
        assert!(!env.contains_key("INCEPTION_API_KEY"));
        std::env::remove_var("TEST_SAFE_VAR");
    }

    #[test]
    fn test_symbol_kind_name() {
        assert_eq!(symbol_kind_name(12), "Function");
        assert_eq!(symbol_kind_name(5), "Class");
        assert_eq!(symbol_kind_name(999), "Unknown");
    }

    #[test]
    fn test_parse_locations_empty() {
        let result = parse_locations(&Value::Null);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_locations_single() {
        let loc = serde_json::json!({
            "uri": "file:///test.rs",
            "range": {"start": {"line": 5, "character": 10}, "end": {"line": 5, "character": 15}}
        });
        let locs = parse_locations(&loc);
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].line, 6);
        assert_eq!(locs[0].col, 11);
    }
}
