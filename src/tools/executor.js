import { readFile, writeFile, mkdir, readdir, stat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { SubAgent, runSubAgentTeam } from '../subagent.js';
import { MercuryClient } from '../client.js';
import { AgentTabBar } from '../ui/agent-tabs.js';
import { Sandbox, SANDBOX_OFF } from '../sandbox.js';
import { LspClient, formatLocations, formatSymbols } from '../lsp.js';
import { searchSymbols, fileOutline, formatSearchResults } from '../ast-search.js';
import { discoverAgents, matchAgentForTask } from '../agent-definitions.js';
import { executeAgentTeams } from '../agent-teams.js';
import { labs } from '../labs.js';

// ── Sanitized environment for child processes ────────────────────────────────
// Strip keys that commonly hold secrets to prevent exfiltration via Bash.
// Claude Code approach: comprehensive pattern matching + explicit allowlist.
const SENSITIVE_ENV_PATTERNS = [
  /KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /CREDENTIAL/i, /AUTH/i,
  /^AWS_/, /^GCP_/, /^AZURE_/, /^GITHUB_TOKEN$/, /^NPM_TOKEN$/,
  /^INCEPTION_/, /^MERCURY_.*KEY/, /^DATABASE_URL$/i, /^REDIS_URL$/i,
  /^MONGO_URI$/i, /^PRIVATE_KEY$/i, /^SESSION_SECRET$/i, /^COOKIE_SECRET$/i,
  /^STRIPE_/, /^TWILIO_/, /^SENDGRID_/, /^SLACK_TOKEN$/i,
  /^OPENAI_/, /^ANTHROPIC_/, /^GOOGLE_APPLICATION_CREDENTIALS$/,
];

// Explicit allowlist for env vars that are always safe to pass through
const SAFE_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERM_PROGRAM", "EDITOR", "VISUAL", "PAGER",
  "NODE_ENV", "NODE_PATH", "NODE_OPTIONS",
  "TMPDIR", "TMP", "TEMP",
  "PWD", "OLDPWD", "SHLVL",
  "HOSTNAME", "LOGNAME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
  "DISPLAY", "COLORTERM", "FORCE_COLOR", "NO_COLOR",
]);

function _sanitizedEnv() {
  const clean = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Always pass through explicitly safe vars
    if (SAFE_ENV_ALLOWLIST.has(key)) {
      clean[key] = value;
      continue;
    }
    // Block anything matching sensitive patterns
    if (SENSITIVE_ENV_PATTERNS.some(re => re.test(key))) continue;
    clean[key] = value;
  }
  return clean;
}

// ── Suspicious command detection (Claude Code pattern) ────────────────────
// Commands that look like exfiltration or destructive operations.
const SUSPICIOUS_COMMAND_PATTERNS = [
  // Data exfiltration via curl/wget with POST/upload
  /\bcurl\b.*(-X\s*(POST|PUT)|--data|--upload|-d\s).*\bhttps?:\/\//i,
  /\bwget\b.*--post/i,
  // Encoding data for exfiltration
  /\bbase64\b.*\|.*\bcurl\b/i,
  // Direct network send of file contents
  /\bcat\b.*\|.*\b(nc|ncat|netcat|curl|wget)\b/i,
  // Reverse shells
  /\bbash\s+-i\b.*\/dev\/(tcp|udp)/i,
  /\bnc\b.*-e\s*\/bin\/(sh|bash)/i,
  // Destructive commands on system paths
  /\brm\s+(-rf?|--force).*\s+\/($|\s)/,
  /\brm\s+(-rf?|--force).*\s+\/(etc|usr|bin|boot|lib|var)\b/,
  /\bmkfs\b/i,
  /\bdd\b.*of=\/dev\//i,
  // Reading sensitive files
  /\bcat\b.*\/(etc\/shadow|etc\/passwd|\.ssh\/id_)/,
  // Env variable exfiltration
  /\benv\b.*\|.*\b(curl|wget|nc)\b/i,
  /\bprintenv\b.*\|.*\b(curl|wget|nc)\b/i,
];

// ── SSRF protection: block requests to private/loopback/link-local addresses ─

/**
 * Check if an IP address is private, loopback, or link-local.
 * @param {string} ip
 * @returns {boolean}
 */
function _isPrivateIp(ip) {
  // IPv4 loopback
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  // IPv6 loopback
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  // IPv4 private ranges (RFC 1918)
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  // IPv4 link-local
  if (ip.startsWith('169.254.')) return true;
  // IPv4 CGNAT
  if (ip.startsWith('100.64.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  // IPv6 private / link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;  // ULA
  if (ip.startsWith('fe80:')) return true;  // link-local
  // Unspecified
  if (ip === '0.0.0.0' || ip === '::') return true;
  // Metadata endpoints (cloud)
  if (ip === '169.254.169.254') return true;
  return false;
}

/**
 * Resolve hostname and check if any resolved address is private/loopback.
 * Also blocks direct IP access to private ranges.
 * @param {string} hostname
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
async function _checkSsrf(hostname) {
  // Direct IP literal check
  if (net.isIP(hostname)) {
    if (_isPrivateIp(hostname)) {
      return { allowed: false, reason: `Request to private/loopback address ${hostname} blocked` };
    }
    return { allowed: true };
  }

  // Block common dangerous hostnames
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower === 'metadata.google.internal') {
    return { allowed: false, reason: `Request to ${hostname} blocked (local/metadata hostname)` };
  }

  // DNS resolution check — resolve hostname and verify all addresses are public
  try {
    const addresses = await new Promise((resolve, reject) => {
      dns.resolve(hostname, (err, addrs) => {
        if (err) {
          // Try resolve4 + resolve6
          dns.resolve4(hostname, (err4, a4) => {
            if (err4) {
              dns.resolve6(hostname, (err6, a6) => {
                if (err6) reject(err6);
                else resolve(a6);
              });
            } else {
              resolve(a4);
            }
          });
        } else {
          resolve(addrs);
        }
      });
    });

    for (const addr of addresses) {
      if (_isPrivateIp(addr)) {
        return { allowed: false, reason: `${hostname} resolves to private address ${addr}` };
      }
    }
  } catch {
    // DNS resolution failed — allow the request (it will fail at connect time)
  }

  return { allowed: true };
}

// ── Read tool token limit ────────────────────────────────────────────────────
// ~35,000 tokens at ~4 bytes/token ≈ 140,000 bytes (Codex-style bytes/4 estimation)
const READ_MAX_CHARS = 140000;

// ── ContextSearch constants ──────────────────────────────────────────────────
// Read conversation log in chunks of ~100K tokens ≈ 350K chars
const CONTEXT_SEARCH_CHUNK_CHARS = 350000;

/**
 * Validate a git ref to prevent command injection.
 * Only allows hex hashes, branch-like names, and common refs.
 */
function isValidGitRef(ref) {
  if (!ref || typeof ref !== 'string') return false;
  // Allow: hex hashes, alphanumeric with /-._~^, HEAD, HEAD~N, branch names
  return /^[a-zA-Z0-9._\-/~^]+$/.test(ref) && ref.length <= 200;
}

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
   * @param {string} [options.workspace] - Workspace root directory
   * @param {string} [options.trustMode] - Trust mode: 'readonly', 'approval', 'open'
   * @param {Sandbox} [options.sandbox] - Sandbox instance for isolation enforcement
   * @param {object} [options.permissionRules] - Permission rules to pass to sub-agents
   */
  constructor(options = {}) {
    this._clientOptions = {
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    };
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || 'approval';
    /** @type {Sandbox|null} */
    this.sandbox = options.sandbox || null;
    /** @type {object|null} Permission rules config for sub-agents */
    this._permissionRules = options.permissionRules || null;
    /** @type {LspClient|null} */
    this._lspClient = null;
    /** @type {Map|null} Cached agent definitions */
    this._agents = null;
    /**
     * One-time bypass for outside-workspace writes.
     * Set to true before executing an approved outside-workspace operation,
     * then cleared immediately after (in a finally block) to avoid persistent backdoor.
     * @type {boolean}
     */
    this._allowOutsideOnce = false;
  }

  /**
   * Get discovered agents (lazy-loaded, cached).
   */
  async _getAgents() {
    if (!this._agents) {
      this._agents = await discoverAgents(this.workspace);
    }
    return this._agents;
  }

  /**
   * Check if a path is within the workspace (symlink-safe).
   * Uses realpathSync to resolve symlinks before comparison.
   * @param {string} filePath - Path to check
   * @returns {boolean}
   */
  _isInWorkspace(filePath) {
    try {
      const resolvedWorkspace = realpathSync(this.workspace);
      // Try realpath first; if file doesn't exist yet, walk up to the nearest
      // existing ancestor and resolve ITS real path to catch symlink escapes
      // (e.g. workspace/symlink-to-etc/passwd would resolve to /etc/passwd).
      let resolvedPath;
      try {
        resolvedPath = realpathSync(filePath);
      } catch {
        resolvedPath = this._resolveViaAncestor(filePath);
      }
      return resolvedPath === resolvedWorkspace ||
        resolvedPath.startsWith(resolvedWorkspace + path.sep);
    } catch {
      // If workspace itself doesn't exist, fall back to strict path.resolve
      const resolvedPath = path.resolve(filePath);
      const resolvedWorkspace = path.resolve(this.workspace);
      return resolvedPath === resolvedWorkspace ||
        resolvedPath.startsWith(resolvedWorkspace + path.sep);
    }
  }

  /**
   * Resolve a non-existent path by finding the nearest existing ancestor,
   * resolving it through realpathSync (following symlinks), then appending
   * the remaining path segments. This prevents symlink escape attacks where
   * a symlink inside the workspace points outside it.
   *
   * Example: /workspace/evil-link/file.txt where evil-link → /etc
   *   → ancestor = /workspace/evil-link, realpath = /etc
   *   → result = /etc/file.txt  (correctly detected as outside workspace)
   */
  _resolveViaAncestor(filePath) {
    const absolute = path.resolve(filePath);
    let current = absolute;
    const trailing = [];

    // Walk up until we find an existing path component
    while (current !== path.dirname(current)) {
      try {
        const real = realpathSync(current);
        // Append trailing segments to the resolved ancestor
        return trailing.length > 0
          ? path.join(real, ...trailing.reverse())
          : real;
      } catch {
        trailing.push(path.basename(current));
        current = path.dirname(current);
      }
    }

    // Reached filesystem root without finding existing path — use absolute
    return absolute;
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
      patch: '_patchFile',
      bash: '_bash',
      glob: '_glob',
      grep: '_grep',
      listdir: '_listDir',
      diff: '_diff',
      fetch: '_fetch',
      subagent: '_subAgent',
      subagentteam: '_subAgentTeam',
      contextsearch: '_contextSearch',
      lsp: '_lsp',
      astsearch: '_astSearch',
      agentteams: '_agentTeams',
    };

    const handler = handlers[toolName.toLowerCase()];
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
    let { file_path, offset, limit } = args;

    if (!file_path) {
      return 'Error: file_path is required.';
    }

    // Normalize path and reject null bytes
    file_path = path.resolve(file_path);
    if (file_path.includes('\0')) {
      return 'Error: Path contains null bytes (invalid).';
    }

    // Sandbox path check
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(file_path, 'read');
      if (!check.allowed) return `Error: ${check.reason}`;
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
    const totalLines = lines.length;

    // Apply offset (1-based)
    const startLine = offset && offset > 0 ? offset - 1 : 0;
    if (startLine > 0) {
      lines = lines.slice(startLine);
    }

    // Apply limit
    if (limit && limit > 0) {
      lines = lines.slice(0, limit);
    }

    // Check token limit (~35,000 tokens ≈ 122,500 chars)
    const selectedContent = lines.join('\n');
    if (selectedContent.length > READ_MAX_CHARS) {
      const estimatedTokens = Math.ceil(selectedContent.length / 3.5);
      return (
        `Error: Content too large (~${estimatedTokens} tokens, limit is ~35,000 tokens). ` +
        `File has ${totalLines} lines total. ` +
        `Use offset and limit parameters to read smaller portions. ` +
        `Example: { "file_path": "${file_path}", "offset": 1, "limit": 500 }`
      );
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
    let { file_path, content } = args;

    if (!file_path) {
      return 'Error: file_path is required.';
    }
    if (content === undefined || content === null) {
      return 'Error: content is required.';
    }

    // Normalize path to resolve .. traversals (security: prevents path confusion)
    file_path = path.resolve(file_path);

    // Block paths containing null bytes (path injection)
    if (file_path.includes('\0')) {
      return 'Error: Path contains null bytes (invalid).';
    }

    // Enforce workspace boundary for writes
    if (this.trustMode === 'readonly') {
      return 'Error: Write is disabled in read-only mode.';
    }
    if (!this._isInWorkspace(file_path) && !this._allowOutsideOnce) {
      return `Error: Write blocked — path is outside workspace: ${file_path}`;
    }

    // Sandbox path check (write)
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(file_path, 'write');
      if (!check.allowed) return `Error: ${check.reason}`;
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
    let { file_path, old_string, new_string, replace_all = false } = args;

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

    // Normalize path to resolve .. traversals
    file_path = path.resolve(file_path);

    // Block null bytes
    if (file_path.includes('\0')) {
      return 'Error: Path contains null bytes (invalid).';
    }

    // Enforce workspace boundary for edits
    if (this.trustMode === 'readonly') {
      return 'Error: Edit is disabled in read-only mode.';
    }
    if (!this._isInWorkspace(file_path) && !this._allowOutsideOnce) {
      return `Error: Edit blocked — path is outside workspace: ${file_path}`;
    }

    // Sandbox path check (write)
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(file_path, 'write');
      if (!check.allowed) return `Error: ${check.reason}`;
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

    // Readonly mode: block all Bash execution
    if (this.trustMode === 'readonly') {
      return 'Error: Bash is disabled in read-only mode.';
    }

    // Suspicious command detection (Claude Code pattern)
    // Flag potentially dangerous commands for user awareness
    if (SUSPICIOUS_COMMAND_PATTERNS.some(re => re.test(command))) {
      return `Error: Suspicious command blocked — "${command.slice(0, 100)}" matches a known dangerous pattern (data exfiltration, reverse shell, or destructive operation). If this is intentional, break it into smaller safe commands.`;
    }

    // Command length limit — prevent absurdly long commands that may hide malicious content
    if (command.length > 100000) {
      return 'Error: Command too long (max 100,000 characters). Break into smaller commands.';
    }

    // Sandbox: wrap command in isolation if enabled
    const execCommand = this.sandbox?.enabled
      ? this.sandbox.wrapCommand(command, { cwd: this.workspace })
      : command;

    // Output truncation limit (~35K tokens ≈ 140K chars) to prevent context flooding
    const BASH_OUTPUT_MAX_CHARS = 140000;

    try {
      const result = execSync(execCommand, {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        cwd: this.workspace, // Enforce workspace as working directory
        env: _sanitizedEnv(), // Strip sensitive env vars
      });
      if (!result) return '(command completed with no output)';
      if (result.length > BASH_OUTPUT_MAX_CHARS) {
        return result.slice(0, BASH_OUTPUT_MAX_CHARS) +
          `\n... (output truncated at ${BASH_OUTPUT_MAX_CHARS} chars, ${result.length} total)`;
      }
      return result;
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
      // Truncate error output too
      if (output.length > BASH_OUTPUT_MAX_CHARS) {
        output = output.slice(0, BASH_OUTPUT_MAX_CHARS) +
          `\n... (error output truncated at ${BASH_OUTPUT_MAX_CHARS} chars)`;
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

    // Glob pattern length limit (prevents crafted patterns causing excessive processing)
    if (pattern.length > 500) {
      return 'Error: Glob pattern too long (max 500 characters).';
    }

    const searchDir = basePath || this.workspace;

    // Sandbox path check (read)
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(searchDir, 'read');
      if (!check.allowed) return `Error: ${check.reason}`;
    }

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

    // Reject excessively long regex patterns (ReDoS mitigation)
    if (pattern.length > 500) {
      return 'Error: Regex pattern too long (max 500 characters).';
    }

    let regex;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return `Error: Invalid regex pattern "${pattern}": ${err.message}`;
    }

    const targetPath = searchPath || this.workspace;

    // Sandbox path check (read)
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(targetPath, 'read');
      if (!check.allowed) return `Error: ${check.reason}`;
    }

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
        // Apply include filter against both filename and relative path
        if (includeRegex) {
          const relPath = path.relative(dirPath, fullPath).replace(/\\/g, '/');
          if (!includeRegex.test(entry.name) && !includeRegex.test(relPath)) {
            continue;
          }
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
    const { task, description, agent_type, resume, run_in_background, isolation, model, max_turns } = args;
    if (!task) {
      return 'Error: task is required.';
    }

    if (this.trustMode === 'readonly') {
      return 'Error: Sub-agents are disabled in read-only mode.';
    }

    // Resolve agent definition
    const agents = await this._getAgents();
    let agentDef = null;
    if (agent_type) {
      agentDef = agents.get(agent_type);
      if (!agentDef) {
        return `Error: Unknown agent type "${agent_type}". Available: ${[...agents.keys()].join(', ')}`;
      }
    } else {
      // Auto-select based on task description
      agentDef = matchAgentForTask(agents, task);
    }

    // Apply direct model override from tool parameter (takes precedence over agentDef)
    if (model && agentDef) {
      agentDef = { ...agentDef, model };
    } else if (model && !agentDef) {
      agentDef = { model, tools: null, disallowedTools: [] };
    }

    // Gate advanced sub-agent features through labs
    // Apply frontmatter defaults from agentDef if caller didn't specify
    const effectiveResume = (resume && labs.isActive("agent-resume")) ? resume : undefined;
    const wantBackground = run_in_background || (agentDef?.background === true);
    const effectiveBackground = (wantBackground && labs.isActive("agent-background")) ? true : false;
    const wantIsolation = isolation || agentDef?.isolation || null;
    const effectiveIsolation = (wantIsolation && labs.isActive("agent-worktree")) ? wantIsolation : undefined;

    if (resume && !labs.isActive("agent-resume")) {
      return 'Error: Agent resume requires labs. Enable with /labs on then /labs agent-resume on';
    }
    if (run_in_background && !labs.isActive("agent-background")) {
      return 'Error: Background agents require labs. Enable with /labs on then /labs agent-background on';
    }
    if (isolation && !labs.isActive("agent-worktree")) {
      return 'Error: Worktree isolation requires labs. Enable with /labs on then /labs agent-worktree on';
    }

    const agent = new SubAgent({
      task,
      ...this._clientOptions,
      workspace: this.workspace,
      trustMode: this.trustMode,
      sandboxConfig: this.sandbox?.toSubAgentConfig(),
      permissionRules: this._permissionRules,
      agentDef,
      resume: effectiveResume,
      runInBackground: effectiveBackground,
      isolation: effectiveIsolation,
      maxTurns: max_turns || undefined,
      onProgress: description
        ? (event, detail) => {
            // Use description as the agent label for progress display
            if (this._onSubAgentProgress) {
              this._onSubAgentProgress(description, event, detail);
            }
          }
        : undefined,
    });
    return await agent.run();
  }

  // ── New Tools ────────────────────────────────────────────────────────────

  /**
   * Apply multiple edits to a file in a single operation.
   */
  async _patchFile(args) {
    let { file_path, edits } = args;
    if (!file_path) return 'Error: file_path is required.';
    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return 'Error: edits array is required and must not be empty.';
    }

    // Normalize and validate path
    file_path = path.resolve(file_path);
    if (file_path.includes('\0')) {
      return 'Error: Path contains null bytes (invalid).';
    }

    // Enforce workspace boundary for patches
    if (this.trustMode === 'readonly') {
      return 'Error: Patch is disabled in read-only mode.';
    }
    if (!this._isInWorkspace(file_path) && !this._allowOutsideOnce) {
      return `Error: Patch blocked — path is outside workspace: ${file_path}`;
    }

    // Sandbox path check (write)
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(file_path, 'write');
      if (!check.allowed) return `Error: ${check.reason}`;
    }

    let content;
    try {
      content = await readFile(file_path, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return `Error: File not found: ${file_path}`;
      return `Error reading file: ${err.message}`;
    }

    // Validate all edits can be applied before writing anything (transactional)
    const errors = [];
    let testContent = content;

    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string } = edits[i];
      if (old_string === undefined || new_string === undefined) {
        errors.push(`Edit ${i + 1}: missing old_string or new_string`);
        continue;
      }
      const idx = testContent.indexOf(old_string);
      if (idx === -1) {
        errors.push(`Edit ${i + 1}: old_string not found (may overlap with previous edit)`);
        continue;
      }
      testContent = testContent.substring(0, idx) + new_string + testContent.substring(idx + old_string.length);
    }

    if (errors.length > 0) {
      return `Patch aborted (no changes written). Errors:\n${errors.join('\n')}`;
    }

    try {
      await writeFile(file_path, testContent, 'utf-8');
    } catch (err) {
      return `Error writing file: ${err.message}`;
    }

    return `Applied ${edits.length}/${edits.length} edits to ${file_path}`;
  }

  /**
   * List directory contents with tree-like format.
   */
  async _listDir(args) {
    const dirPath = args.path || this.workspace;
    const maxDepth = Math.min(args.max_depth || 1, 5);
    const showHidden = args.show_hidden || false;

    // Sandbox path check (read)
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(dirPath, 'read');
      if (!check.allowed) return `Error: ${check.reason}`;
    }

    try {
      await stat(dirPath);
    } catch (err) {
      if (err.code === 'ENOENT') return `Error: Directory not found: ${dirPath}`;
      return `Error: ${err.message}`;
    }

    const lines = [];
    await this._listDirRecursive(dirPath, '', maxDepth, 0, showHidden, lines);

    if (lines.length === 0) return '(empty directory)';
    return lines.join('\n');
  }

  async _listDirRecursive(dirPath, prefix, maxDepth, depth, showHidden, lines) {
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: dirs first, then files, alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    // Filter hidden if needed
    if (!showHidden) {
      entries = entries.filter((e) => !e.name.startsWith('.'));
    }

    const skipDirs = new Set(['node_modules', '.git', '__pycache__', 'dist', '.next', 'coverage']);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entry.isDirectory()) {
        const skip = skipDirs.has(entry.name);
        lines.push(`${prefix}${connector}📁 ${entry.name}/${skip ? ' (skipped)' : ''}`);
        if (!skip) {
          const fullPath = path.join(dirPath, entry.name);
          await this._listDirRecursive(fullPath, prefix + childPrefix, maxDepth, depth + 1, showHidden, lines);
        }
      } else {
        // Get file size
        let size = '';
        try {
          const s = await stat(path.join(dirPath, entry.name));
          size = this._formatSize(s.size);
        } catch {
          // skip size
        }
        lines.push(`${prefix}${connector}${entry.name} ${size}`);
      }
    }
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `(${bytes}B)`;
    if (bytes < 1024 * 1024) return `(${(bytes / 1024).toFixed(1)}KB)`;
    return `(${(bytes / (1024 * 1024)).toFixed(1)}MB)`;
  }

  /**
   * Show file or git diffs. Uses execFileSync to prevent command injection.
   */
  async _diff(args) {
    const { file_a, file_b, git_ref } = args;
    const execOpts = { encoding: 'utf-8', timeout: 30000, maxBuffer: 5 * 1024 * 1024, cwd: this.workspace };

    // Validate git ref if provided
    if (git_ref && !isValidGitRef(git_ref)) {
      return `Error: Invalid git ref "${git_ref}". Only alphanumeric, /, -, ., _, ~, ^ allowed.`;
    }

    // Case 1: git diff against a ref
    if (git_ref && !file_a && !file_b) {
      try {
        const result = execFileSync('git', ['diff', git_ref], execOpts);
        return result || '(no changes)';
      } catch (err) {
        return `Error: ${err.stderr || err.message}`;
      }
    }

    // Case 2: git diff for a specific file
    if (file_a && !file_b) {
      const ref = git_ref || 'HEAD';
      if (!isValidGitRef(ref)) return `Error: Invalid git ref "${ref}".`;
      try {
        const result = execFileSync('git', ['diff', ref, '--', file_a], execOpts);
        return result || `(no changes for ${file_a})`;
      } catch (err) {
        return `Error: ${err.stderr || err.message}`;
      }
    }

    // Case 3: diff between two files
    if (file_a && file_b) {
      try {
        const result = execFileSync('diff', ['-u', '--', file_a, file_b], execOpts);
        return result || '(files are identical)';
      } catch (err) {
        if (err.stdout) return err.stdout;
        return `Error: ${err.stderr || err.message}`;
      }
    }

    // Case 4: no args → show all uncommitted changes
    try {
      const result = execFileSync('git', ['diff'], execOpts);
      return result || '(no uncommitted changes)';
    } catch (err) {
      return `Error: ${err.stderr || err.message}`;
    }
  }

  /**
   * Fetch content from a URL via HTTP/HTTPS.
   */
  async _fetch(args, _redirectCount = 0) {
    const { url, method = 'GET', headers = {}, body } = args;
    const MAX_REDIRECTS = 5;
    const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB max response

    if (!url) return 'Error: url is required.';
    if (typeof url !== 'string') return 'Error: url must be a string.';
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'Error: url must start with http:// or https://';
    }
    // Block URLs with credentials (user:pass@host) — prevent credential smuggling
    if (/@/.test(url.split('//')[1]?.split('/')[0] || '')) {
      return 'Error: URLs with embedded credentials are not allowed.';
    }
    if (_redirectCount > MAX_REDIRECTS) {
      return `Error: Too many redirects (>${MAX_REDIRECTS})`;
    }

    // Sandbox URL check
    if (this.sandbox?.enabled) {
      const check = this.sandbox.checkUrl(url);
      if (!check.allowed) return `Error: ${check.reason}`;
    }

    // SSRF protection: resolve hostname and block private/loopback addresses
    const parsedUrl = new URL(url);
    const ssrfCheck = await _checkSsrf(parsedUrl.hostname);
    if (!ssrfCheck.allowed) {
      return `Error: SSRF blocked — ${ssrfCheck.reason}`;
    }

    // In readonly mode, only allow pure GET (no body, no query params — prevent data exfiltration)
    if (this.trustMode === 'readonly') {
      if (method.toUpperCase() !== 'GET') {
        return `Error: Only GET requests are allowed in read-only mode (attempted ${method.toUpperCase()}).`;
      }
      if (body) {
        return 'Error: Request body is not allowed in read-only mode.';
      }
      if (parsedUrl.search && parsedUrl.search.length > 1) {
        return 'Error: URL query parameters are not allowed in read-only mode (risk of data exfiltration via query string).';
      }
    }

    return new Promise((resolve) => {
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      // Strip dangerous headers that could be used for SSRF or impersonation
      const safeHeaders = { ...headers };
      delete safeHeaders['Host'];  // Prevent Host header SSRF
      delete safeHeaders['host'];
      delete safeHeaders['Origin'];  // Prevent cross-origin confusion
      delete safeHeaders['origin'];

      const options = {
        method: method.toUpperCase(),
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'MercuryCode/1.0',
          ...safeHeaders,
        },
        timeout: 30000,
      };

      const req = lib.request(options, (res) => {
        // Follow redirects per RFC: 301/302/303 change to GET, 307/308 preserve method
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          // Validate redirect target protocol (prevent file://, ftp://, etc.)
          if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
            resolve(`Error: Redirect to non-HTTP protocol blocked: ${redirectUrl}`);
            return;
          }
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
            resolve(this._fetch({ url: redirectUrl, method: 'GET', headers }, _redirectCount + 1));
          } else {
            resolve(this._fetch({ ...args, url: redirectUrl }, _redirectCount + 1));
          }
          return;
        }

        let data = '';
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_BODY_SIZE) {
            data += chunk.toString();
          } else {
            res.destroy(); // Stop downloading oversized responses
          }
        });
        res.on('end', () => {
          if (size > MAX_BODY_SIZE) {
            resolve(data.slice(0, 50000) + `\n... (response too large: ${(size/1024).toFixed(0)}KB, truncated)`);
          } else if (res.statusCode >= 400) {
            resolve(`HTTP ${res.statusCode}: ${data.slice(0, 2000)}`);
          } else if (data.length > 50000) {
            resolve(data.slice(0, 50000) + `\n... (truncated, ${data.length} total chars)`);
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', (err) => resolve(`Error: ${err.message}`));
      req.on('timeout', () => {
        req.destroy();
        resolve('Error: Request timed out (30s)');
      });

      if (body) req.write(body);
      req.end();
    });
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

    if (this.trustMode === 'readonly') {
      return 'Error: Sub-agents are disabled in read-only mode.';
    }

    // Resolve agent definitions for each task
    const agents = await this._getAgents();
    const resolvedTasks = tasks.map((t) => {
      const taskObj = typeof t === 'string' ? { task: t } : { ...t };
      if (taskObj.agent_type) {
        taskObj.agentDef = agents.get(taskObj.agent_type) || null;
      } else {
        taskObj.agentDef = matchAgentForTask(agents, taskObj.task);
      }
      // Apply per-task model override from tool parameter
      if (taskObj.model && taskObj.agentDef) {
        taskObj.agentDef = { ...taskObj.agentDef, model: taskObj.model };
      } else if (taskObj.model && !taskObj.agentDef) {
        taskObj.agentDef = { model: taskObj.model, tools: null, disallowedTools: [] };
      }
      return taskObj;
    });

    // Create interactive tab bar for live display
    const tabBar = new AgentTabBar();
    for (const task of resolvedTasks) {
      tabBar.addAgent(task);
    }
    tabBar.start();

    let results;
    try {
      results = await runSubAgentTeam(resolvedTasks, {
        ...this._clientOptions,
        workspace: this.workspace,
        trustMode: this.trustMode,
        sandboxConfig: this.sandbox?.toSubAgentConfig(),
        permissionRules: this._permissionRules,
        onAgentProgress: (agentIndex, event, detail) => {
          if (event === 'done' || event === 'error') {
            tabBar.finish(agentIndex, event === 'done', detail);
          } else {
            tabBar.update(agentIndex, event, detail);
          }
        },
      });
    } finally {
      // Clean up tab bar and show final summary
      tabBar.cleanup();
      tabBar.printSummary();
    }

    // Format results
    const formatted = results.map((result, i) => {
      const taskDesc = typeof tasks[i] === 'string' ? tasks[i] : tasks[i].task;
      const truncatedTask = taskDesc.length > 80 ? taskDesc.slice(0, 80) + '...' : taskDesc;
      return `── Sub-agent ${i + 1}: ${truncatedTask} ──\n${result}`;
    });

    return formatted.join('\n\n');
  }

  // ── Agent Teams ──────────────────────────────────────────────────────────────

  /**
   * Collaborative agent teams with shared task list and mailbox.
   */
  async _agentTeams(args) {
    if (this.trustMode === 'readonly') {
      return 'Error: Agent teams are disabled in read-only mode.';
    }
    return await executeAgentTeams(args, {
      workspace: this.workspace,
      apiKey: this._clientOptions.apiKey,
      baseURL: this._clientOptions.baseURL,
      trustMode: this.trustMode,
      sandboxConfig: this.sandbox?.toSubAgentConfig(),
      permissionRules: this._permissionRules,
    });
  }

  // ── LSP ────────────────────────────────────────────────────────────────────

  /**
   * Language Server Protocol operations for semantic code intelligence.
   * Lazy-initializes the LSP client on first use.
   */
  async _lsp(args) {
    const { action, file_path, line, character, query } = args;
    if (!action) return 'Error: action is required (definition, references, hover, symbols, workspace_symbols, diagnostics).';

    // Validate file_path is within workspace (LSP is read-only but should respect sandbox)
    if (file_path && this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(file_path, 'read');
      if (!check.allowed) return `Error: ${check.reason}`;
    }

    // Lazy init LspClient
    if (!this._lspClient) {
      this._lspClient = new LspClient(this.workspace);
    }

    try {
      switch (action) {
        case 'definition': {
          if (!file_path || !line) return 'Error: file_path and line are required for definition.';
          const locs = await this._lspClient.gotoDefinition(file_path, line, character || 0);
          return formatLocations(locs);
        }
        case 'references': {
          if (!file_path || !line) return 'Error: file_path and line are required for references.';
          const refs = await this._lspClient.findReferences(file_path, line, character || 0);
          return formatLocations(refs);
        }
        case 'hover': {
          if (!file_path || !line) return 'Error: file_path and line are required for hover.';
          const info = await this._lspClient.hover(file_path, line, character || 0);
          return info || 'No hover information available.';
        }
        case 'symbols': {
          if (!file_path) return 'Error: file_path is required for symbols.';
          const syms = await this._lspClient.documentSymbols(file_path);
          return formatSymbols(syms);
        }
        case 'workspace_symbols': {
          if (!query) return 'Error: query is required for workspace_symbols.';
          const syms = await this._lspClient.workspaceSymbols(query);
          return formatSymbols(syms);
        }
        case 'diagnostics': {
          if (!file_path) return 'Error: file_path is required for diagnostics.';
          const diags = await this._lspClient.getDiagnostics(file_path);
          if (!diags || diags.length === 0) return 'No diagnostics for this file.';
          return diags.map(d => `${d.severity || 'info'} (line ${d.range?.start?.line || '?'}): ${d.message}`).join('\n');
        }
        default:
          return `Error: Unknown LSP action "${action}". Use: definition, references, hover, symbols, workspace_symbols, diagnostics.`;
      }
    } catch (err) {
      return `LSP error: ${err.message}`;
    }
  }

  // ── AST Search ─────────────────────────────────────────────────────────────

  /**
   * AST-based structural code search. Two actions: 'search' and 'outline'.
   */
  async _astSearch(args) {
    const { action, query, kind, language, file_path } = args;
    if (!action) return 'Error: action is required (search or outline).';

    // Validate file_path is within workspace if sandbox is active
    if (file_path && this.sandbox?.enabled) {
      const check = this.sandbox.checkPath(file_path, 'read');
      if (!check.allowed) return `Error: ${check.reason}`;
    }

    try {
      switch (action) {
        case 'search': {
          if (!query) return 'Error: query is required for search action.';
          const results = await searchSymbols(this.workspace, query, { kind, language });
          return formatSearchResults(results);
        }
        case 'outline': {
          if (!file_path) return 'Error: file_path is required for outline action.';
          return await fileOutline(file_path);
        }
        default:
          return `Error: Unknown AstSearch action "${action}". Use: search, outline.`;
      }
    } catch (err) {
      return `AstSearch error: ${err.message}`;
    }
  }

  // ── ContextSearch ──────────────────────────────────────────────────────────

  /**
   * Search the complete conversation log using Mercury-2 as a reader agent.
   * Reads .mercury/conversation.jsonl in chunks, asks the model to judge
   * relevance and extract key content for each chunk.
   *
   * @param {object} args
   * @param {string} args.query - What to search for
   * @param {string} [args.scope] - 'recent', 'early', or 'all' (default)
   * @returns {string} Compiled relevant findings
   */
  async _contextSearch(args) {
    const { query, scope = 'all' } = args;
    if (!query) return 'Error: query is required.';

    // Locate the conversation log
    const logPath = path.join(this.workspace, '.mercury', 'conversation.jsonl');
    let logContent;
    try {
      logContent = await readFile(logPath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return 'No conversation log found (.mercury/conversation.jsonl does not exist). Nothing to search.';
      }
      return `Error reading conversation log: ${err.message}`;
    }

    if (!logContent.trim()) {
      return 'Conversation log is empty. Nothing to search.';
    }

    // Determine which portion of the log to scan based on scope
    let targetContent = logContent;
    if (scope === 'recent') {
      const quarterPoint = Math.floor(logContent.length * 0.75);
      targetContent = logContent.slice(quarterPoint);
    } else if (scope === 'early') {
      const quarterPoint = Math.floor(logContent.length * 0.25);
      targetContent = logContent.slice(0, quarterPoint);
    }

    // Split into chunks of ~100K tokens (≈350K chars)
    const chunks = [];
    for (let i = 0; i < targetContent.length; i += CONTEXT_SEARCH_CHUNK_CHARS) {
      chunks.push(targetContent.slice(i, i + CONTEXT_SEARCH_CHUNK_CHARS));
    }

    // Create a client for the search sub-agent
    const client = new MercuryClient({
      apiKey: this._clientOptions.apiKey,
      baseURL: this._clientOptions.baseURL,
    });

    const findings = [];

    // Process each chunk — ask Mercury-2 to judge relevance and extract
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const searchPrompt =
        `You are a context search agent. Your job is to scan a portion of a conversation log and find content relevant to the user's query.\n\n` +
        `## Query\n${query}\n\n` +
        `## Instructions\n` +
        `1. Read the conversation log chunk below carefully.\n` +
        `2. If you find content relevant to the query, extract and return the key information verbatim (exact code, exact error messages, exact file paths, etc.).\n` +
        `3. If nothing relevant is found, respond with exactly: NO_MATCH\n` +
        `4. Be thorough — extract ALL relevant content, not just the first match.\n` +
        `5. Preserve exact formatting of code snippets and error messages.\n\n` +
        `## Conversation Log (chunk ${i + 1}/${chunks.length})\n` +
        `\`\`\`\n${chunk}\n\`\`\``;

      try {
        const response = await client.chatCompletion(
          [
            { role: 'system', content: 'You are a precise context search agent. Extract relevant information from conversation logs.' },
            { role: 'user', content: searchPrompt },
          ],
          {
            max_tokens: 8000,
            temperature: 0.2,
            reasoning_effort: 'low',
          }
        );

        const result = response.choices?.[0]?.message?.content;
        if (result && !result.trim().startsWith('NO_MATCH')) {
          findings.push(`── Chunk ${i + 1}/${chunks.length} ──\n${result.trim()}`);
        }
      } catch (err) {
        // Non-critical: skip this chunk on error
        findings.push(`── Chunk ${i + 1}/${chunks.length} ── (search error: ${err.message})`);
      }
    }

    // Compile results
    if (findings.length === 0) {
      return (
        `No relevant content found for query: "${query}"\n` +
        `Searched ${chunks.length} chunk(s) of conversation log (scope: ${scope}).`
      );
    }

    // If multiple findings, ask Mercury-2 to compile a summary
    if (findings.length > 1) {
      try {
        const compilePrompt =
          `You found the following relevant content from different parts of the conversation log.\n` +
          `Compile these into a single coherent response for the query: "${query}"\n\n` +
          `Remove duplicates. Preserve exact code, paths, and error messages. Be concise but complete.\n\n` +
          findings.join('\n\n');

        const compileResponse = await client.chatCompletion(
          [
            { role: 'system', content: 'Compile search results into a coherent summary. Preserve exact code and error messages.' },
            { role: 'user', content: compilePrompt },
          ],
          { max_tokens: 8000, temperature: 0.2, reasoning_effort: 'low' }
        );

        const compiled = compileResponse.choices?.[0]?.message?.content;
        if (compiled) {
          return `[ContextSearch: scanned ${chunks.length} chunk(s), found ${findings.length} match(es)]\n\n${compiled}`;
        }
      } catch {
        // Fall through to raw findings
      }
    }

    // Return raw findings (single match or compile failed)
    return `[ContextSearch: scanned ${chunks.length} chunk(s), found ${findings.length} match(es)]\n\n${findings.join('\n\n')}`;
  }
}
