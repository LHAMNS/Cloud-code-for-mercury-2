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
      "The sub-agent gets its own isolated conversation context and can use all the same tools " +
      "(Read, Write, Edit, Bash, Glob, Grep). " +
      "Use this for tasks that can be done independently, such as: " +
      "searching the codebase for specific patterns, reading and analyzing files, " +
      "running tests, or performing research. " +
      "The sub-agent runs to completion and returns its findings as text. " +
      "You can spawn multiple sub-agents concurrently for parallel work.",
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
      "Each sub-agent gets its own context and can use all tools independently. " +
      "All sub-agents run concurrently and results are returned together. " +
      "Use this when you need to perform multiple independent research or analysis tasks " +
      "simultaneously (e.g., searching different parts of the codebase, " +
      "running different test suites, analyzing different files). " +
      "Maximum 5 concurrent sub-agents.",
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
            },
            required: ["task"],
          },
          description:
            "Array of task objects, each describing a task for one sub-agent. " +
            "Each task should be self-contained with all necessary context.",
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
  ContextSearchTool,
  SubAgentTool,
  SubAgentTeamTool,
];
