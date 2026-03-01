import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { SubAgent, runSubAgentTeam } from '../subagent.js';

/**
 * Simple recursive glob implementation without external dependencies.
 * Uses fs.readdir with { recursive: true } and converts glob patterns to regex.
 */
async function glob(pattern, baseDir = '.') {
  const resolvedBase = path.resolve(baseDir);

  let entries;
  try {
    entries = await readdir(resolvedBase, { recursive: true, withFileTypes: false });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const regex = globToRegex(pattern);
  const matches = [];

  for (const entry of entries) {
    // Normalize to forward slashes for consistent matching
    const normalized = entry.replace(/\\/g, '/');
    if (regex.test(normalized)) {
      matches.push(path.join(resolvedBase, entry));
    }
  }

  matches.sort();
  return matches;
}

/**
 * Convert a glob pattern to a regular expression.
 * Supports *, **, ?, and {a,b,c} brace expansion.
 */
function globToRegex(pattern) {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (ch === '{') {
      // Brace expansion: {a,b,c} → (a|b|c)
      const closeBrace = pattern.indexOf('}', i);
      if (closeBrace !== -1) {
        const inner = pattern.slice(i + 1, closeBrace);
        const alternatives = inner.split(',').map((alt) =>
          alt.replace(/[.*+?^$|\\()[\]]/g, '\\$&')
        );
        regexStr += '(' + alternatives.join('|') + ')';
        i = closeBrace + 1;
      } else {
        regexStr += '\\{';
        i += 1;
      }
    } else if (ch === '.') {
      regexStr += '\\.';
      i += 1;
    } else if (ch === '(' || ch === ')' || ch === '}' ||
               ch === '[' || ch === ']' || ch === '+' || ch === '^' ||
               ch === '$' || ch === '|' || ch === '\\') {
      regexStr += '\\' + ch;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }

  return new RegExp('^' + regexStr + '$');
}


export class ToolExecutor {
  /**
   * @param {object} [options] - Options to pass down to sub-agents
   * @param {string} [options.apiKey] - API key for sub-agent calls
   * @param {string} [options.baseURL] - API base URL for sub-agent calls
   */
  constructor(options = {}) {
    this._clientOptions = options;
  }

  /**
   * Dispatch a tool call to the appropriate handler method.
   * @param {string} toolName - Name of the tool to execute
   * @param {object} args - Arguments for the tool
   * @returns {string} Result of tool execution
   */
  async execute(toolName, args) {
    const handlers = {
      read: '_readFile',
      write: '_writeFile',
      edit: '_editFile',
      bash: '_bash',
      glob: '_glob',
      grep: '_grep',
      subagent: '_subAgent',
      subagentteam: '_subAgentTeam',
    };

    const handler = handlers[toolName];
    if (!handler) {
      return `Error: Unknown tool "${toolName}". Available tools: ${Object.keys(handlers).join(', ')}`;
    }

    try {
      return await this[handler](args);
    } catch (err) {
      return `Error executing ${toolName}: ${err.message}`;
    }
  }

  /**
   * Read a file with optional offset and limit.
   * Returns contents in cat -n format (line numbers prefixed).
   * @param {object} args
   * @param {string} args.file_path - Absolute path to the file
   * @param {number} [args.offset] - 1-based line number to start reading from
   * @param {number} [args.limit] - Number of lines to read
   * @returns {string} File contents with line numbers
   */
  async _readFile(args) {
    const { file_path, offset, limit } = args;

    if (!file_path) {
      return 'Error: file_path is required.';
    }

    let content;
    try {
      content = await readFile(file_path, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `Error: File not found: ${file_path}`;
      }
      if (err.code === 'EACCES') {
        return `Error: Permission denied reading file: ${file_path}`;
      }
      if (err.code === 'EISDIR') {
        return `Error: Path is a directory, not a file: ${file_path}`;
      }
      return `Error reading file: ${err.message}`;
    }

    let lines = content.split('\n');

    // Apply offset (1-based)
    const startLine = offset && offset > 0 ? offset - 1 : 0;
    if (startLine > 0) {
      lines = lines.slice(startLine);
    }

    // Apply limit
    if (limit && limit > 0) {
      lines = lines.slice(0, limit);
    }

    // Format with line numbers (cat -n format)
    const lineNumberStart = startLine + 1;
    const formatted = lines.map((line, idx) => {
      const lineNum = lineNumberStart + idx;
      const padding = String(lineNum).padStart(6, ' ');
      return `${padding}\t${line}`;
    });

    return formatted.join('\n');
  }

  /**
   * Write content to a file, creating parent directories if needed.
   * @param {object} args
   * @param {string} args.file_path - Absolute path to write to
   * @param {string} args.content - Content to write
   * @returns {string} Success or error message
   */
  async _writeFile(args) {
    const { file_path, content } = args;

    if (!file_path) {
      return 'Error: file_path is required.';
    }
    if (content === undefined || content === null) {
      return 'Error: content is required.';
    }

    try {
      const dir = path.dirname(file_path);
      await mkdir(dir, { recursive: true });
      await writeFile(file_path, content, 'utf-8');
      return `Successfully wrote ${content.length} bytes to ${file_path}`;
    } catch (err) {
      if (err.code === 'EACCES') {
        return `Error: Permission denied writing to: ${file_path}`;
      }
      return `Error writing file: ${err.message}`;
    }
  }

  /**
   * Find old_string in a file and replace it with new_string.
   * Errors if old_string is not found or appears more than once (not unique).
   * @param {object} args
   * @param {string} args.file_path - Absolute path to the file
   * @param {string} args.old_string - Exact text to find
   * @param {string} args.new_string - Text to replace with
   * @param {boolean} [args.replace_all=false] - Replace all occurrences
   * @returns {string} Success or error message
   */
  async _editFile(args) {
    const { file_path, old_string, new_string, replace_all = false } = args;

    if (!file_path) {
      return 'Error: file_path is required.';
    }
    if (old_string === undefined || old_string === null) {
      return 'Error: old_string is required.';
    }
    if (new_string === undefined || new_string === null) {
      return 'Error: new_string is required.';
    }
    if (old_string === new_string) {
      return 'Error: old_string and new_string must be different.';
    }

    let content;
    try {
      content = await readFile(file_path, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `Error: File not found: ${file_path}`;
      }
      if (err.code === 'EACCES') {
        return `Error: Permission denied reading file: ${file_path}`;
      }
      return `Error reading file: ${err.message}`;
    }

    // Count occurrences
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(old_string, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + old_string.length;
    }

    if (count === 0) {
      return `Error: old_string not found in ${file_path}. Make sure the string matches exactly, including whitespace and indentation.`;
    }

    if (count > 1 && !replace_all) {
      return `Error: old_string appears ${count} times in ${file_path}. Use replace_all to replace every occurrence, or provide a larger unique string with more context.`;
    }

    let newContent;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
    } else {
      // Replace only the first (and only) occurrence
      const idx = content.indexOf(old_string);
      newContent = content.substring(0, idx) + new_string + content.substring(idx + old_string.length);
    }

    try {
      await writeFile(file_path, newContent, 'utf-8');
      const replacements = replace_all ? count : 1;
      return `Successfully replaced ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${file_path}`;
    } catch (err) {
      if (err.code === 'EACCES') {
        return `Error: Permission denied writing to: ${file_path}`;
      }
      return `Error writing file: ${err.message}`;
    }
  }

  /**
   * Execute a bash command using child_process.execSync.
   * Returns combined stdout and stderr. Respects timeout (default 120s).
   * @param {object} args
   * @param {string} args.command - The shell command to execute
   * @param {number} [args.timeout=120000] - Timeout in milliseconds
   * @returns {string} Command output (stdout + stderr)
   */
  async _bash(args) {
    const { command, timeout = 120000 } = args;

    if (!command) {
      return 'Error: command is required.';
    }

    try {
      const result = execSync(command, {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: process.env,
      });
      return result || '(command completed with no output)';
    } catch (err) {
      // execSync throws on non-zero exit code; capture output anyway
      let output = '';
      if (err.stdout) {
        output += err.stdout;
      }
      if (err.stderr) {
        if (output) output += '\n';
        output += err.stderr;
      }
      if (err.killed) {
        output += `\nError: Command timed out after ${timeout}ms`;
      } else if (!output) {
        output = `Error: Command failed with exit code ${err.status ?? 'unknown'}: ${err.message}`;
      }
      return output;
    }
  }

  /**
   * Find files matching a glob pattern.
   * Uses fs.readdir with recursive:true and filters with a glob-to-regex converter.
   * @param {object} args
   * @param {string} args.pattern - Glob pattern to match (e.g., "** /*.js")
   * @param {string} [args.path] - Base directory to search in (defaults to cwd)
   * @returns {string} Newline-separated list of matching file paths
   */
  async _glob(args) {
    const { pattern, path: basePath } = args;

    if (!pattern) {
      return 'Error: pattern is required.';
    }

    const searchDir = basePath || process.cwd();

    try {
      await stat(searchDir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `Error: Directory not found: ${searchDir}`;
      }
      return `Error accessing directory: ${err.message}`;
    }

    try {
      const matches = await glob(pattern, searchDir);
      if (matches.length === 0) {
        return `No files matched pattern "${pattern}" in ${searchDir}`;
      }
      return matches.join('\n');
    } catch (err) {
      return `Error during glob: ${err.message}`;
    }
  }

  /**
   * Search files for a regex pattern.
   * Walks the directory, reads files, matches lines, returns file:line:content format.
   * @param {object} args
   * @param {string} args.pattern - Regex pattern to search for
   * @param {string} [args.path] - Directory or file to search in (defaults to cwd)
   * @param {string} [args.include] - Glob pattern to filter files (e.g., "*.js")
   * @returns {string} Matching results in file:lineNumber:content format
   */
  async _grep(args) {
    const { pattern, path: searchPath, include } = args;

    if (!pattern) {
      return 'Error: pattern is required.';
    }

    let regex;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return `Error: Invalid regex pattern "${pattern}": ${err.message}`;
    }

    const targetPath = searchPath || process.cwd();
    const results = [];
    const MAX_RESULTS = 1000;

    let includeRegex = null;
    if (include) {
      includeRegex = globToRegex(include);
    }

    try {
      const targetStat = await stat(targetPath);

      if (targetStat.isFile()) {
        await this._grepFile(targetPath, regex, results, MAX_RESULTS);
      } else if (targetStat.isDirectory()) {
        await this._grepDirectory(targetPath, regex, includeRegex, results, MAX_RESULTS);
      } else {
        return `Error: ${targetPath} is not a file or directory.`;
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `Error: Path not found: ${targetPath}`;
      }
      if (err.code === 'EACCES') {
        return `Error: Permission denied: ${targetPath}`;
      }
      return `Error during grep: ${err.message}`;
    }

    if (results.length === 0) {
      return `No matches found for pattern "${pattern}"`;
    }

    let output = results.join('\n');
    if (results.length >= MAX_RESULTS) {
      output += `\n... (results truncated at ${MAX_RESULTS} matches)`;
    }
    return output;
  }

  /**
   * Search a single file for regex matches.
   * @param {string} filePath - Path to the file
   * @param {RegExp} regex - Regex to match against
   * @param {string[]} results - Array to push results into
   * @param {number} maxResults - Maximum number of results
   */
  async _grepFile(filePath, regex, results, maxResults) {
    let content;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      // Skip files that can't be read (binary, permission, etc.)
      return;
    }

    // Quick check: skip likely binary files
    if (content.includes('\0')) {
      return;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (regex.test(lines[i])) {
        results.push(`${filePath}:${i + 1}:${lines[i]}`);
      }
    }
  }

  /**
   * Recursively search a directory for regex matches in files.
   * @param {string} dirPath - Directory to search
   * @param {RegExp} regex - Regex to match against
   * @param {RegExp|null} includeRegex - Optional glob filter for file names
   * @param {string[]} results - Array to push results into
   * @param {number} maxResults - Maximum number of results
   */
  async _grepDirectory(dirPath, regex, includeRegex, results, maxResults) {
    // Skip common non-code directories
    const skipDirs = new Set([
      'node_modules', '.git', '.svn', '.hg',
      '__pycache__', 'dist', '.next',
      'coverage', '.cache', '.vscode', '.idea',
    ]);

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      // Skip directories that can't be read
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          await this._grepDirectory(fullPath, regex, includeRegex, results, maxResults);
        }
      } else if (entry.isFile()) {
        // Apply include filter against the file name
        if (includeRegex && !includeRegex.test(entry.name)) {
          continue;
        }
        await this._grepFile(fullPath, regex, results, maxResults);
      }
    }
  }

  /**
   * Spawn a single sub-agent to handle a task autonomously.
   * @param {object} args
   * @param {string} args.task - Description of the task
   * @returns {string} Sub-agent's final response
   */
  async _subAgent(args) {
    const { task } = args;
    if (!task) {
      return 'Error: task is required.';
    }

    const agent = new SubAgent({ task, ...this._clientOptions });
    return await agent.run();
  }

  /**
   * Spawn a team of sub-agents to work on tasks in parallel.
   * @param {object} args
   * @param {Array<{task: string}>} args.tasks - Array of task descriptions
   * @returns {string} Combined results from all sub-agents
   */
  async _subAgentTeam(args) {
    const { tasks } = args;
    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return 'Error: tasks array is required and must not be empty.';
    }

    if (tasks.length > 5) {
      return 'Error: Maximum 5 sub-agents allowed per team.';
    }

    const results = await runSubAgentTeam(tasks, this._clientOptions);

    // Format results
    const formatted = results.map((result, i) => {
      const taskDesc = typeof tasks[i] === 'string' ? tasks[i] : tasks[i].task;
      const truncatedTask = taskDesc.length > 80 ? taskDesc.slice(0, 80) + '...' : taskDesc;
      return `── Sub-agent ${i + 1}: ${truncatedTask} ──\n${result}`;
    });

    return formatted.join('\n\n');
  }
}
