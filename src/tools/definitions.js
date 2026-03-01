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
 * Complete list of tool definitions in OpenAI function calling format.
 */
export const TOOL_DEFINITIONS = [
  ReadTool,
  WriteTool,
  EditTool,
  BashTool,
  GlobTool,
  GrepTool,
];
