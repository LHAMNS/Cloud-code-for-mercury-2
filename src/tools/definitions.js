// Mercury Code - Tool Definitions
// OpenAI function calling format tool definitions for the coding assistant

/**
 * Read file contents from the local filesystem.
 */
const ReadTool = {
  type: "function",
  function: {
    name: "Read",
    description:
      "Read the contents of a file from the local filesystem. " +
      "Returns the file content with line numbers. " +
      "Use offset and limit to read specific portions of large files.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path to the file to read.",
        },
        offset: {
          type: "number",
          description:
            "The line number to start reading from (1-based). " +
            "Optional; defaults to reading from the beginning of the file.",
        },
        limit: {
          type: "number",
          description:
            "The maximum number of lines to read. " +
            "Optional; defaults to reading the entire file.",
        },
      },
      required: ["file_path"],
    },
  },
};

/**
 * Write content to a file, creating it if it does not exist or overwriting if it does.
 */
const WriteTool = {
  type: "function",
  function: {
    name: "Write",
    description:
      "Write content to a file on the local filesystem. " +
      "Creates the file if it does not exist, or overwrites it if it does. " +
      "Parent directories are created automatically as needed.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path to the file to write.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["file_path", "content"],
    },
  },
};

/**
 * Edit a file by performing an exact string replacement.
 */
const EditTool = {
  type: "function",
  function: {
    name: "Edit",
    description:
      "Edit a file by replacing an exact string match with new content. " +
      "The old_string must uniquely match a section of the file. " +
      "Provide enough surrounding context in old_string to ensure a unique match.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path to the file to edit.",
        },
        old_string: {
          type: "string",
          description:
            "The exact text to find and replace. " +
            "Must match the file content exactly, including indentation and whitespace.",
        },
        new_string: {
          type: "string",
          description:
            "The new text to replace old_string with. " +
            "Use an empty string to delete the matched text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "If true, replace all occurrences of old_string in the file. " +
            "Defaults to false, which requires old_string to be unique.",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
};

/**
 * Execute a bash command in the user's shell.
 */
const BashTool = {
  type: "function",
  function: {
    name: "Bash",
    description:
      "Execute a bash command and return its stdout and stderr. " +
      "The working directory persists between calls within a session. " +
      "Use this for running scripts, installing packages, git operations, " +
      "and any other shell tasks.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute.",
        },
        timeout: {
          type: "number",
          description:
            "Optional timeout in milliseconds. " +
            "The command will be terminated if it exceeds this duration. " +
            "Defaults to 120000 (2 minutes).",
        },
      },
      required: ["command"],
    },
  },
};

/**
 * Find files matching a glob pattern.
 */
const GlobTool = {
  type: "function",
  function: {
    name: "Glob",
    description:
      "Find files matching a glob pattern. " +
      'Supports standard glob syntax such as "**/*.js", "src/**/*.ts", etc. ' +
      "Returns a list of matching file paths sorted by modification time.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'The glob pattern to match files against (e.g., "**/*.js", "src/**/*.ts").',
        },
        path: {
          type: "string",
          description:
            "The directory to search in. " +
            "Optional; defaults to the current working directory.",
        },
      },
      required: ["pattern"],
    },
  },
};

/**
 * Search file contents using a regular expression pattern.
 */
const GrepTool = {
  type: "function",
  function: {
    name: "Grep",
    description:
      "Search file contents using a regular expression pattern. " +
      "Returns matching file paths or matching lines depending on usage. " +
      "Supports full regex syntax for powerful code search.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "The regular expression pattern to search for in file contents.",
        },
        path: {
          type: "string",
          description:
            "The file or directory to search in. " +
            "Optional; defaults to the current working directory.",
        },
        include: {
          type: "string",
          description:
            'Glob pattern to filter which files are searched (e.g., "*.js", "*.{ts,tsx}"). ' +
            "Optional; searches all files by default.",
        },
      },
      required: ["pattern"],
    },
  },
};

/**
 * Spawn a sub-agent to handle a specific task autonomously.
 */
const SubAgentTool = {
  type: "function",
  function: {
    name: "SubAgent",
    description:
      "Spawn an autonomous sub-agent to handle a specific task. " +
      "The sub-agent gets its own isolated conversation context. " +
      "Use this for tasks that can be done independently: " +
      "searching the codebase, reading and analyzing files, " +
      "running tests, or performing research. " +
      "Available agent types: 'explore' (fast read-only search), " +
      "'plan' (architecture/design), 'general-purpose' (full tools). " +
      "Custom agents from .mercury/agents/*.md are also available. " +
      "Agents can be resumed by passing their agentId, run in background, " +
      "or isolated in a git worktree.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A detailed description of what the sub-agent should do. " +
            "Be specific — include file paths, patterns to search for, " +
            "or exact operations to perform. The sub-agent has no context " +
            "from the main conversation, so include all necessary information.",
        },
        agent_type: {
          type: "string",
          description:
            "The type of agent to spawn. Built-in types: 'explore' (read-only codebase search), " +
            "'plan' (architecture/design research), 'general-purpose' (full read/write tools). " +
            "Defaults to auto-selection based on task description.",
        },
        resume: {
          type: "string",
          description:
            "Agent ID to resume. Pass the agentId from a previous invocation to continue " +
            "with the agent's full prior context preserved. The new task/prompt will be " +
            "appended to the existing conversation.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "Run the agent in the background. Returns immediately with the agentId. " +
            "The agent continues working asynchronously. Check results later by resuming.",
        },
        isolation: {
          type: "string",
          enum: ["worktree"],
          description:
            "Set to 'worktree' to run the agent in a temporary git worktree, " +
            "giving it an isolated copy of the repository. Changes are committed " +
            "to a temporary branch. Worktree is cleaned up if no changes are made.",
        },
      },
      required: ["task"],
    },
  },
};

/**
 * Spawn a team of sub-agents to work on multiple tasks in parallel.
 */
const SubAgentTeamTool = {
  type: "function",
  function: {
    name: "SubAgentTeam",
    description:
      "Spawn multiple sub-agents to work on different tasks in parallel. " +
      "Each sub-agent gets its own context and can use tools independently. " +
      "All sub-agents run concurrently and results are returned together. " +
      "Use this for multiple independent research or analysis tasks. " +
      "Each task can specify its own agent_type. Maximum 5 concurrent sub-agents.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Detailed description of this sub-agent's task.",
              },
              agent_type: {
                type: "string",
                description:
                  "Agent type for this task: 'explore', 'plan', 'general-purpose', or a custom name.",
              },
            },
            required: ["task"],
          },
          description:
            "Array of task objects. Each task is self-contained with all necessary context.",
          maxItems: 5,
        },
      },
      required: ["tasks"],
    },
  },
};

/**
 * List the contents of a directory with optional depth control.
 */
const ListDirTool = {
  type: "function",
  function: {
    name: "ListDir",
    description:
      "List the contents of a directory. Returns file and subdirectory names, sizes, " +
      "and types in a tree-like format. Useful for understanding project structure. " +
      "Use max_depth to control recursion depth (default 1 = immediate children only).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The absolute path to the directory to list. " +
            "Defaults to the current working directory if not specified.",
        },
        max_depth: {
          type: "number",
          description:
            "Maximum depth to recurse into subdirectories. " +
            "1 = immediate children only (default), 2 = one level of subdirs, etc. Max 5.",
        },
        show_hidden: {
          type: "boolean",
          description:
            "If true, include hidden files/directories (starting with '.'). Default is false.",
        },
      },
      required: [],
    },
  },
};

/**
 * Show the diff between two files or git changes.
 */
const DiffTool = {
  type: "function",
  function: {
    name: "Diff",
    description:
      "Show differences between files or git changes. " +
      "Can compare two files, show git diff for uncommitted changes, " +
      "or show diff between two git refs (commits/branches). " +
      "Returns unified diff format output.",
    parameters: {
      type: "object",
      properties: {
        file_a: {
          type: "string",
          description:
            "Path to the first file, or a git ref (e.g., HEAD, branch name). " +
            "If only file_a is given, shows git diff for that file's uncommitted changes.",
        },
        file_b: {
          type: "string",
          description:
            "Path to the second file, or a git ref. " +
            "When comparing two files, this is the 'new' version.",
        },
        git_ref: {
          type: "string",
          description:
            "Git ref to diff against (e.g., 'HEAD', 'main', 'HEAD~3'). " +
            "If specified without file_a/file_b, shows all changes since that ref.",
        },
      },
      required: [],
    },
  },
};

/**
 * Fetch content from a URL.
 */
const FetchTool = {
  type: "function",
  function: {
    name: "Fetch",
    description:
      "Fetch content from a URL via HTTP/HTTPS. Returns the response body as text. " +
      "Useful for downloading documentation, checking API endpoints, " +
      "fetching remote configuration files, or reading web pages. " +
      "Follows redirects automatically. Timeout is 30 seconds.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch (must start with http:// or https://).",
        },
        method: {
          type: "string",
          description:
            "HTTP method to use. Defaults to GET. Supports GET, POST, PUT, DELETE.",
        },
        headers: {
          type: "object",
          description:
            "Optional HTTP headers as key-value pairs (e.g., {\"Authorization\": \"Bearer ...\"}).",
        },
        body: {
          type: "string",
          description: "Optional request body for POST/PUT requests.",
        },
      },
      required: ["url"],
    },
  },
};

/**
 * Apply a multi-region patch to a file efficiently.
 */
const PatchTool = {
  type: "function",
  function: {
    name: "Patch",
    description:
      "Apply multiple edits to a file in a single operation. " +
      "More efficient than calling Edit multiple times for the same file. " +
      "Each edit specifies an old_string to find and a new_string to replace it with. " +
      "All edits are applied in order.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path to the file to patch.",
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_string: {
                type: "string",
                description: "Exact text to find.",
              },
              new_string: {
                type: "string",
                description: "Text to replace it with.",
              },
            },
            required: ["old_string", "new_string"],
          },
          description: "Array of {old_string, new_string} pairs to apply in order.",
        },
      },
      required: ["file_path", "edits"],
    },
  },
};

/**
 * Search the complete conversation log for relevant historical context.
 * Uses Mercury-2 as a sub-agent to intelligently scan and extract content.
 */
const ContextSearchTool = {
  type: "function",
  function: {
    name: "ContextSearch",
    description:
      "Search the complete conversation history (.mercury/conversation.jsonl) " +
      "for relevant past context. This tool uses Mercury-2 to intelligently " +
      "scan the full conversation log in chunks, finding and extracting " +
      "relevant content (exact code changes, error messages, command outputs, " +
      "earlier discussions, etc.). Use this when you need to recall details " +
      "that may have been lost during context compression — it is your " +
      "primary way to recover information from earlier in the session.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Describe what you are looking for. Be specific: mention file names, " +
            "function names, error messages, tool names, or topics. " +
            "Example: 'the exact error message when running npm test earlier' " +
            "or 'what changes were made to src/config.js'",
        },
        scope: {
          type: "string",
          description:
            "Optional scope to narrow the search: 'recent' (last 25% of log), " +
            "'early' (first 25% of log), or 'all' (full scan, default). " +
            "Use 'recent' or 'early' for faster results when you know approximately " +
            "when the information appeared.",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * Go to definition, find references, and get hover info using LSP.
 */
const LspTool = {
  type: "function",
  function: {
    name: "Lsp",
    description:
      "Language Server Protocol operations for semantic code intelligence. " +
      "Supports: definition (go to definition), references (find all references), " +
      "hover (type info/docs), symbols (document outline), workspace_symbols (search symbols). " +
      "Requires a language server to be available on the system. " +
      "Auto-detects: TypeScript, Python, Go, Rust, C/C++.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "The LSP action: 'definition', 'references', 'hover', 'symbols', 'workspace_symbols', 'diagnostics'.",
        },
        file_path: {
          type: "string",
          description: "Absolute path to the file (required for definition, references, hover, symbols, diagnostics).",
        },
        line: {
          type: "number",
          description: "1-based line number (required for definition, references, hover).",
        },
        character: {
          type: "number",
          description: "0-based column number (required for definition, references, hover).",
        },
        query: {
          type: "string",
          description: "Search query for workspace_symbols action.",
        },
      },
      required: ["action"],
    },
  },
};

/**
 * AST-based structural code search.
 */
const AstSearchTool = {
  type: "function",
  function: {
    name: "AstSearch",
    description:
      "Search for code symbols (functions, classes, methods, types, imports, etc.) " +
      "using structural pattern matching. Faster and more precise than Grep for finding " +
      "code definitions. Use 'search' to find symbols across the workspace, or 'outline' " +
      "to get the structural outline of a single file. " +
      "Supports: JavaScript, TypeScript, Python, Go, Rust.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action: 'search' (find symbols) or 'outline' (file structure).",
        },
        query: {
          type: "string",
          description: "Symbol name or regex pattern to search for (required for 'search').",
        },
        kind: {
          type: "string",
          description:
            "Filter by symbol kind: function, class, method, interface, type, enum, " +
            "import, export, variable, decorator, struct, trait, macro. Optional.",
        },
        language: {
          type: "string",
          description: "Filter by language: javascript, typescript, python, go, rust. Optional.",
        },
        file_path: {
          type: "string",
          description: "Absolute path to file (required for 'outline').",
        },
      },
      required: ["action"],
    },
  },
};

/**
 * Complete list of tool definitions in OpenAI function calling format.
 */
export const TOOL_DEFINITIONS = [
  ReadTool,
  WriteTool,
  EditTool,
  PatchTool,
  BashTool,
  GlobTool,
  GrepTool,
  ListDirTool,
  DiffTool,
  FetchTool,
  LspTool,
  AstSearchTool,
  ContextSearchTool,
  SubAgentTool,
  SubAgentTeamTool,
];
