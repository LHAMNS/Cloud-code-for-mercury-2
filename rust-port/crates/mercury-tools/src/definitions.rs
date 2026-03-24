// Mercury Code - Tool Definitions
// JSON Schema-compatible tool definitions for the coding assistant.
// Mirrors the OpenAI function calling format used by the JavaScript version.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// All known tool names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ToolName {
    Read,
    Write,
    Edit,
    Patch,
    Bash,
    Glob,
    Grep,
    ListDir,
    Diff,
    Fetch,
    Lsp,
    AstSearch,
    ContextSearch,
    SubAgent,
    SubAgentTeam,
    AgentTeams,
}

impl ToolName {
    /// Return the canonical string name (PascalCase).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "Read",
            Self::Write => "Write",
            Self::Edit => "Edit",
            Self::Patch => "Patch",
            Self::Bash => "Bash",
            Self::Glob => "Glob",
            Self::Grep => "Grep",
            Self::ListDir => "ListDir",
            Self::Diff => "Diff",
            Self::Fetch => "Fetch",
            Self::Lsp => "Lsp",
            Self::AstSearch => "AstSearch",
            Self::ContextSearch => "ContextSearch",
            Self::SubAgent => "SubAgent",
            Self::SubAgentTeam => "SubAgentTeam",
            Self::AgentTeams => "AgentTeams",
        }
    }

    /// Parse from a case-insensitive string.
    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "edit" => Some(Self::Edit),
            "patch" => Some(Self::Patch),
            "bash" => Some(Self::Bash),
            "glob" => Some(Self::Glob),
            "grep" => Some(Self::Grep),
            "listdir" => Some(Self::ListDir),
            "diff" => Some(Self::Diff),
            "fetch" => Some(Self::Fetch),
            "lsp" => Some(Self::Lsp),
            "astsearch" => Some(Self::AstSearch),
            "contextsearch" => Some(Self::ContextSearch),
            "subagent" => Some(Self::SubAgent),
            "subagentteam" => Some(Self::SubAgentTeam),
            "agentteams" => Some(Self::AgentTeams),
            _ => None,
        }
    }

    /// All tool names as a slice.
    pub fn all() -> &'static [ToolName] {
        &[
            Self::Read,
            Self::Write,
            Self::Edit,
            Self::Patch,
            Self::Bash,
            Self::Glob,
            Self::Grep,
            Self::ListDir,
            Self::Diff,
            Self::Fetch,
            Self::Lsp,
            Self::AstSearch,
            Self::ContextSearch,
            Self::SubAgent,
            Self::SubAgentTeam,
            Self::AgentTeams,
        ]
    }
}

impl std::fmt::Display for ToolName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A single tool definition in OpenAI function-calling format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionDef,
}

/// The "function" portion of a tool definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

// ---------------------------------------------------------------------------
// Individual tool definition builders
// ---------------------------------------------------------------------------

fn read_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Read".into(),
            description: "Read the contents of a file from the local filesystem. \
                Returns the file content with line numbers. \
                Use offset and limit to read specific portions of large files."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to read."
                    },
                    "offset": {
                        "type": "number",
                        "description": "The line number to start reading from (1-based). Optional; defaults to reading from the beginning of the file."
                    },
                    "limit": {
                        "type": "number",
                        "description": "The maximum number of lines to read. Optional; defaults to reading the entire file."
                    }
                },
                "required": ["file_path"]
            }),
        },
    }
}

fn write_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Write".into(),
            description: "Write content to a file on the local filesystem. \
                Creates the file if it does not exist, or overwrites it if it does. \
                Parent directories are created automatically as needed."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to write."
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write to the file."
                    }
                },
                "required": ["file_path", "content"]
            }),
        },
    }
}

fn edit_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Edit".into(),
            description: "Edit a file by replacing an exact string match with new content. \
                The old_string must uniquely match a section of the file. \
                Provide enough surrounding context in old_string to ensure a unique match."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to edit."
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The exact text to find and replace. Must match the file content exactly, including indentation and whitespace."
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The new text to replace old_string with. Use an empty string to delete the matched text."
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "If true, replace all occurrences of old_string in the file. Defaults to false, which requires old_string to be unique."
                    }
                },
                "required": ["file_path", "old_string", "new_string"]
            }),
        },
    }
}

fn patch_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Patch".into(),
            description: "Apply multiple edits to a file in a single operation. \
                More efficient than calling Edit multiple times for the same file. \
                Each edit specifies an old_string to find and a new_string to replace it with. \
                All edits are applied in order."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to patch."
                    },
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": {
                                    "type": "string",
                                    "description": "Exact text to find."
                                },
                                "new_string": {
                                    "type": "string",
                                    "description": "Text to replace it with."
                                }
                            },
                            "required": ["old_string", "new_string"]
                        },
                        "description": "Array of {old_string, new_string} pairs to apply in order."
                    }
                },
                "required": ["file_path", "edits"]
            }),
        },
    }
}

fn bash_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Bash".into(),
            description: "Execute a bash command and return its stdout and stderr. \
                The working directory persists between calls within a session. \
                Use this for running scripts, installing packages, git operations, \
                and any other shell tasks."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute."
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Optional timeout in milliseconds. The command will be terminated if it exceeds this duration. Defaults to 120000 (2 minutes)."
                    }
                },
                "required": ["command"]
            }),
        },
    }
}

fn glob_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Glob".into(),
            description: "Find files matching a glob pattern. \
                Supports standard glob syntax such as \"**/*.js\", \"src/**/*.ts\", etc. \
                Returns a list of matching file paths sorted by modification time."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The glob pattern to match files against (e.g., \"**/*.js\", \"src/**/*.ts\")."
                    },
                    "path": {
                        "type": "string",
                        "description": "The directory to search in. Optional; defaults to the current working directory."
                    }
                },
                "required": ["pattern"]
            }),
        },
    }
}

fn grep_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Grep".into(),
            description: "Search file contents using a regular expression pattern. \
                Returns matching file paths or matching lines depending on usage. \
                Supports full regex syntax for powerful code search."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The regular expression pattern to search for in file contents."
                    },
                    "path": {
                        "type": "string",
                        "description": "The file or directory to search in. Optional; defaults to the current working directory."
                    },
                    "include": {
                        "type": "string",
                        "description": "Glob pattern to filter which files are searched (e.g., \"*.js\", \"*.{ts,tsx}\"). Optional; searches all files by default."
                    }
                },
                "required": ["pattern"]
            }),
        },
    }
}

fn list_dir_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "ListDir".into(),
            description: "List the contents of a directory. Returns file and subdirectory names, sizes, \
                and types in a tree-like format. Useful for understanding project structure. \
                Use max_depth to control recursion depth (default 1 = immediate children only)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The absolute path to the directory to list. Defaults to the current working directory if not specified."
                    },
                    "max_depth": {
                        "type": "number",
                        "description": "Maximum depth to recurse into subdirectories. 1 = immediate children only (default), 2 = one level of subdirs, etc. Max 5."
                    },
                    "show_hidden": {
                        "type": "boolean",
                        "description": "If true, include hidden files/directories (starting with '.'). Default is false."
                    }
                },
                "required": []
            }),
        },
    }
}

fn diff_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Diff".into(),
            description: "Show differences between files or git changes. \
                Can compare two files, show git diff for uncommitted changes, \
                or show diff between two git refs (commits/branches). \
                Returns unified diff format output."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "file_a": {
                        "type": "string",
                        "description": "Path to the first file, or a git ref (e.g., HEAD, branch name). If only file_a is given, shows git diff for that file's uncommitted changes."
                    },
                    "file_b": {
                        "type": "string",
                        "description": "Path to the second file, or a git ref. When comparing two files, this is the 'new' version."
                    },
                    "git_ref": {
                        "type": "string",
                        "description": "Git ref to diff against (e.g., 'HEAD', 'main', 'HEAD~3'). If specified without file_a/file_b, shows all changes since that ref."
                    }
                },
                "required": []
            }),
        },
    }
}

fn fetch_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Fetch".into(),
            description: "Fetch content from a URL via HTTP/HTTPS. Returns the response body as text. \
                Useful for downloading documentation, checking API endpoints, \
                fetching remote configuration files, or reading web pages. \
                Follows redirects automatically. Timeout is 30 seconds."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch (must start with http:// or https://)."
                    },
                    "method": {
                        "type": "string",
                        "description": "HTTP method to use. Defaults to GET. Supports GET, POST, PUT, DELETE."
                    },
                    "headers": {
                        "type": "object",
                        "description": "Optional HTTP headers as key-value pairs (e.g., {\"Authorization\": \"Bearer ...\"})."
                    },
                    "body": {
                        "type": "string",
                        "description": "Optional request body for POST/PUT requests."
                    }
                },
                "required": ["url"]
            }),
        },
    }
}

fn lsp_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "Lsp".into(),
            description: "Language Server Protocol operations for semantic code intelligence. \
                Supports: definition (go to definition), references (find all references), \
                hover (type info/docs), symbols (document outline), workspace_symbols (search symbols). \
                Requires a language server to be available on the system. \
                Auto-detects: TypeScript, Python, Go, Rust, C/C++."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The LSP action: 'definition', 'references', 'hover', 'symbols', 'workspace_symbols', 'diagnostics'."
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file (required for definition, references, hover, symbols, diagnostics)."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-based line number (required for definition, references, hover)."
                    },
                    "character": {
                        "type": "number",
                        "description": "0-based column number (required for definition, references, hover)."
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query for workspace_symbols action."
                    }
                },
                "required": ["action"]
            }),
        },
    }
}

fn ast_search_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "AstSearch".into(),
            description: "Search for code symbols (functions, classes, methods, types, imports, etc.) \
                using structural pattern matching. Faster and more precise than Grep for finding \
                code definitions. Use 'search' to find symbols across the workspace, or 'outline' \
                to get the structural outline of a single file. \
                Supports: JavaScript, TypeScript, Python, Go, Rust."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action: 'search' (find symbols) or 'outline' (file structure)."
                    },
                    "query": {
                        "type": "string",
                        "description": "Symbol name or regex pattern to search for (required for 'search')."
                    },
                    "kind": {
                        "type": "string",
                        "description": "Filter by symbol kind: function, class, method, interface, type, enum, import, export, variable, decorator, struct, trait, macro. Optional."
                    },
                    "language": {
                        "type": "string",
                        "description": "Filter by language: javascript, typescript, python, go, rust. Optional."
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to file (required for 'outline')."
                    }
                },
                "required": ["action"]
            }),
        },
    }
}

fn context_search_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "ContextSearch".into(),
            description: "Search the complete conversation history (.mercury/conversation.jsonl) \
                for relevant past context. This tool uses Mercury-2 to intelligently \
                scan the full conversation log in chunks, finding and extracting \
                relevant content (exact code changes, error messages, command outputs, \
                earlier discussions, etc.). Use this when you need to recall details \
                that may have been lost during context compression."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Describe what you are looking for. Be specific: mention file names, function names, error messages, tool names, or topics."
                    },
                    "scope": {
                        "type": "string",
                        "description": "Optional scope to narrow the search: 'recent' (last 25% of log), 'early' (first 25% of log), or 'all' (full scan, default)."
                    }
                },
                "required": ["query"]
            }),
        },
    }
}

fn sub_agent_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "SubAgent".into(),
            description: "Spawn an autonomous sub-agent to handle a specific task. \
                The sub-agent gets its own isolated conversation context. \
                Use this for tasks that can be done independently: \
                searching the codebase, reading and analyzing files, \
                running tests, or performing research."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "A short (3-5 word) summary of what the agent will do."
                    },
                    "task": {
                        "type": "string",
                        "description": "A detailed description of what the sub-agent should do. Be specific."
                    },
                    "agent_type": {
                        "type": "string",
                        "description": "The type of agent to spawn: 'explore', 'plan', 'general-purpose', or a custom name."
                    },
                    "resume": {
                        "type": "string",
                        "description": "Agent ID to resume from a previous invocation."
                    },
                    "run_in_background": {
                        "type": "boolean",
                        "description": "Run the agent in the background. Returns immediately with the agentId."
                    },
                    "isolation": {
                        "type": "string",
                        "enum": ["worktree"],
                        "description": "Set to 'worktree' to run the agent in a temporary git worktree."
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional model override for this agent."
                    },
                    "max_turns": {
                        "type": "number",
                        "description": "Maximum number of agentic turns before stopping."
                    }
                },
                "required": ["task"]
            }),
        },
    }
}

fn sub_agent_team_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "SubAgentTeam".into(),
            description: "Spawn multiple sub-agents to work on different tasks in parallel. \
                Each sub-agent gets its own context and can use tools independently. \
                All sub-agents run concurrently and results are returned together. \
                Maximum 5 concurrent sub-agents."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": {
                                    "type": "string",
                                    "description": "Detailed description of this sub-agent's task."
                                },
                                "agent_type": {
                                    "type": "string",
                                    "description": "Agent type for this task: 'explore', 'plan', 'general-purpose', or a custom name."
                                },
                                "model": {
                                    "type": "string",
                                    "description": "Optional model override for this specific sub-agent."
                                }
                            },
                            "required": ["task"]
                        },
                        "description": "Array of task objects. Each task is self-contained with all necessary context.",
                        "maxItems": 5
                    }
                },
                "required": ["tasks"]
            }),
        },
    }
}

fn agent_teams_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: FunctionDef {
            name: "AgentTeams".into(),
            description: "Create and manage collaborative agent teams. Teams consist of a lead (you) \
                and multiple teammates (sub-agents). Teammates work on shared tasks, \
                communicate via mailbox messages, and can declare task dependencies. \
                Actions: create, add_task, spawn_teammate, message, broadcast, run, status, shutdown."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The team action: 'create', 'add_task', 'spawn_teammate', 'message', 'broadcast', 'run', 'status', 'shutdown'."
                    },
                    "team_name": {
                        "type": "string",
                        "description": "Name of the team (required for all actions)."
                    },
                    "title": {
                        "type": "string",
                        "description": "Task title (for add_task)."
                    },
                    "detail": {
                        "type": "string",
                        "description": "Detailed task prompt (for add_task)."
                    },
                    "depends": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Task IDs this task depends on (for add_task)."
                    },
                    "name": {
                        "type": "string",
                        "description": "Teammate display name (for spawn_teammate)."
                    },
                    "to": {
                        "type": "string",
                        "description": "Recipient teammate ID (for message)."
                    },
                    "from": {
                        "type": "string",
                        "description": "Sender ID (defaults to 'lead')."
                    },
                    "content": {
                        "type": "string",
                        "description": "Message content (for message/broadcast)."
                    }
                },
                "required": ["action", "team_name"]
            }),
        },
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return the complete list of tool definitions in OpenAI function calling format.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        read_tool(),
        write_tool(),
        edit_tool(),
        patch_tool(),
        bash_tool(),
        glob_tool(),
        grep_tool(),
        list_dir_tool(),
        diff_tool(),
        fetch_tool(),
        lsp_tool(),
        ast_search_tool(),
        context_search_tool(),
        sub_agent_tool(),
        sub_agent_team_tool(),
        agent_teams_tool(),
    ]
}

/// Retrieve the definition for a single tool by name.
pub fn get_tool_definition(name: ToolName) -> ToolDefinition {
    match name {
        ToolName::Read => read_tool(),
        ToolName::Write => write_tool(),
        ToolName::Edit => edit_tool(),
        ToolName::Patch => patch_tool(),
        ToolName::Bash => bash_tool(),
        ToolName::Glob => glob_tool(),
        ToolName::Grep => grep_tool(),
        ToolName::ListDir => list_dir_tool(),
        ToolName::Diff => diff_tool(),
        ToolName::Fetch => fetch_tool(),
        ToolName::Lsp => lsp_tool(),
        ToolName::AstSearch => ast_search_tool(),
        ToolName::ContextSearch => context_search_tool(),
        ToolName::SubAgent => sub_agent_tool(),
        ToolName::SubAgentTeam => sub_agent_team_tool(),
        ToolName::AgentTeams => agent_teams_tool(),
    }
}

/// Serialize all tool definitions to a JSON `Value`.
pub fn tool_definitions_json() -> Value {
    serde_json::to_value(tool_definitions()).expect("tool definitions should serialize")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_tools_returned() {
        let defs = tool_definitions();
        assert_eq!(defs.len(), 16);
    }

    #[test]
    fn test_tool_name_round_trip() {
        for name in ToolName::all() {
            let s = name.as_str();
            let parsed = ToolName::from_str_loose(s).expect("should parse");
            assert_eq!(*name, parsed);
        }
    }

    #[test]
    fn test_case_insensitive_lookup() {
        assert_eq!(ToolName::from_str_loose("read"), Some(ToolName::Read));
        assert_eq!(ToolName::from_str_loose("BASH"), Some(ToolName::Bash));
        assert_eq!(ToolName::from_str_loose("ListDir"), Some(ToolName::ListDir));
        assert_eq!(ToolName::from_str_loose("unknown"), None);
    }

    #[test]
    fn test_definitions_serialize_to_json() {
        let val = tool_definitions_json();
        assert!(val.is_array());
        let arr = val.as_array().unwrap();
        assert_eq!(arr.len(), 16);

        // Every definition should have type="function" and a function.name
        for def in arr {
            assert_eq!(def["type"], "function");
            assert!(def["function"]["name"].is_string());
            assert!(def["function"]["description"].is_string());
            assert!(def["function"]["parameters"].is_object());
        }
    }

    #[test]
    fn test_read_tool_has_required_fields() {
        let def = get_tool_definition(ToolName::Read);
        let params = &def.function.parameters;
        let required = params["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "file_path"));
    }
}
