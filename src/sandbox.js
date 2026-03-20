// Mercury Code - Sandbox Module
// Provides configurable process isolation for Bash commands, file operations,
// and network access. Default: ON for both main agent and sub-agents.
//
// Three modes:
//   off    — No sandboxing (legacy behavior)
//   on     — Default: workspace-scoped filesystem, sanitized env, resource limits
//   strict — Maximum isolation: read-only root, no network for Bash, domain allowlist
//
// Detection priority for Bash sandboxing:
//   1. bubblewrap (bwrap) — lightweight Linux namespace sandbox
//   2. firejail           — security sandbox with seccomp
//   3. fallback           — ulimit + sanitized env (always available)

import { execSync, execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { resolveViaAncestor as _sharedResolveViaAncestor } from "./utils/path-safety.js";
import { debugLog } from "./utils/debug-log.js";

// ── Sandbox modes ────────────────────────────────────────────────────────────

export const SANDBOX_OFF = "off";
export const SANDBOX_ON = "on";
export const SANDBOX_STRICT = "strict";

export const SANDBOX_MODES = [SANDBOX_OFF, SANDBOX_ON, SANDBOX_STRICT];

// ── Sensitive path deny-list ─────────────────────────────────────────────────
// These paths are blocked for read/write even if inside a generous workspace.
// Prevents accidental or malicious access to credentials and system config.

const SENSITIVE_PATHS = [
  // SSH keys & config
  ".ssh",
  // GPG keys
  ".gnupg",
  // Cloud credentials
  ".aws/credentials",
  ".aws/config",
  ".azure",
  ".config/gcloud",
  ".config/gcloud/application_default_credentials.json",
  // Package manager tokens
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pip/pip.conf",
  ".pypirc",
  // Shell history (may contain secrets pasted by mistake)
  ".bash_history",
  ".zsh_history",
  ".node_repl_history",
  ".python_history",
  ".mysql_history",
  ".psql_history",
  // Docker credentials
  ".docker/config.json",
  // Kubernetes config
  ".kube/config",
  // Git credentials
  ".git-credentials",
  ".gitconfig",
  // Password stores
  ".password-store",
  ".local/share/keyrings",
  // Browser profiles (may contain cookies/passwords)
  ".config/google-chrome",
  ".mozilla/firefox",
  // Environment files that commonly contain secrets
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development.local",
  // Terraform state (may contain cloud secrets)
  ".terraform",
  // Vault tokens
  ".vault-token",
  // Netrc (credentials for HTTP/FTP)
  ".netrc",
  // Helm repos (may contain tokens)
  ".config/helm",
  // Cargo registry credentials
  ".cargo/credentials",
  ".cargo/credentials.toml",
  // Gradle properties (may contain signing keys)
  ".gradle/gradle.properties",
  // Maven settings (may contain repo credentials)
  ".m2/settings.xml",
  // Ruby gem credentials
  ".gem/credentials",
  // Rust/crates.io token
  ".cargo/registry",
  // 1Password CLI
  ".op",
  ".config/op",
  // Bitwarden CLI
  ".config/Bitwarden CLI",
  // GitHub CLI credentials
  ".config/gh/hosts.yml",
  // Heroku CLI
  ".config/heroku",
  // Poetry auth
  ".config/poetry/auth.toml",
  // Podman/container credentials
  ".config/containers/auth.json",
  // rclone cloud storage credentials
  ".config/rclone/rclone.conf",
  // Hub CLI token
  ".config/hub",
  // Fish shell history
  ".config/fish/fish_history",
  ".local/share/fish/fish_history",
  // VS Code settings (may contain tokens/credentials)
  ".config/Code/User/settings.json",
  // NuGet config (may contain API keys)
  ".nuget/NuGet.Config",
  // Composer auth (PHP package manager credentials)
  ".composer/auth.json",
  // Configstore (various CLI tool credentials)
  ".config/configstore",
  // Shell startup files (can be abused to inject commands)
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".login",
];

// System paths that should never be written to
const SYSTEM_DENY_WRITE = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/var/run",
  "/var/lock",
  "/var/spool",
  "/root",
];

// ── Dangerous file extensions ────────────────────────────────────────────────
// In strict mode, block writes to files with these extensions (executable payloads)
const DANGEROUS_WRITE_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".com", ".bat", ".cmd", ".ps1", ".vbs", ".wsf",
  ".scr", ".pif", ".msi", ".msp",
  ".cpl", ".hta", ".inf", ".reg",
  ".elf", ".ko", ".sys",
  // macOS executables
  ".app", ".command", ".dmg",
  // Linux packages/services
  ".deb", ".rpm", ".desktop", ".service",
  // Java archives
  ".jar", ".war",
]);

// ── Content secret patterns ──────────────────────────────────────────────────
// Regex patterns to detect secrets in file content being written.
// Only applied when content scanning is enabled (strict mode).
const SECRET_CONTENT_PATTERNS = [
  // AWS keys
  /AKIA[0-9A-Z]{16}/,
  // Generic long hex secrets (64+ chars)
  /(?:secret|token|key|password|credential)[\s]*[=:]\s*['"]?[A-Za-z0-9/+=]{40,}['"]?/i,
  // Private keys (PEM)
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  // GitHub tokens
  /gh[pousr]_[A-Za-z0-9_]{36,}/,
  // Slack tokens
  /xox[bporas]-[0-9]+-[A-Za-z0-9-]+/,
  // Generic JWT
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // Stripe keys
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/,
  // SendGrid keys
  /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/,
  // npm tokens
  /npm_[A-Za-z0-9]{36,}/,
  // PyPI tokens
  /pypi-[A-Za-z0-9_-]{50,}/,
  // Google service account
  /"type"\s*:\s*"service_account"/,
];

// ── Sandbox capability detection ─────────────────────────────────────────────

/**
 * Detect available sandbox backends on the current system.
 * Results are cached after first call.
 */
let _cachedCapabilities = null;

function detectCapabilities() {
  if (_cachedCapabilities) return _cachedCapabilities;

  const caps = {
    bwrap: false,
    firejail: false,
    unshare: false,
    platform: process.platform,
  };

  if (process.platform !== "linux") {
    // bubblewrap/firejail/unshare are Linux-only
    _cachedCapabilities = caps;
    return caps;
  }

  // Prefer absolute paths for sandbox tool detection to avoid PATH manipulation
  const BWRAP_PATHS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
  const FIREJAIL_PATHS = ["/usr/bin/firejail", "/usr/local/bin/firejail"];
  const UNSHARE_PATHS = ["/usr/bin/unshare", "/usr/local/bin/unshare"];

  // Check bubblewrap — only trust known absolute paths
  const bwrapBin = BWRAP_PATHS.find(p => fs.existsSync(p));
  try {
    if (bwrapBin) {
      // Verify it actually works (needs user namespaces)
      execFileSync(bwrapBin, ["--ro-bind", "/", "/", "--dev", "/dev", "true"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
      caps.bwrap = true;
    }
  } catch (err) {
    debugLog("Sandbox.detectCapabilities.bwrap", err);
  }

  // Check firejail — only trust known absolute paths
  const firejailBin = FIREJAIL_PATHS.find(p => fs.existsSync(p));
  try {
    caps.firejail = !!firejailBin;
  } catch (err) {
    debugLog("Sandbox.detectCapabilities.firejail", err);
  }

  // Check unshare — only trust known absolute paths
  const unshareBin = UNSHARE_PATHS.find(p => fs.existsSync(p));
  try {
    caps.unshare = !!unshareBin;
  } catch (err) {
    debugLog("Sandbox.detectCapabilities.unshare", err);
  }

  // Warn when no sandbox backend is available
  if (!caps.bwrap && !caps.firejail) {
    if (process.platform === "win32") {
      console.warn(`\x1b[33m\u26a0 WARNING: Windows does not support process-level sandboxing (bwrap/firejail). Bash commands run WITHOUT filesystem isolation — the sandbox mode setting does NOT provide containment on this platform. Only basic resource limits (ulimit) are applied.\x1b[0m`);
    } else {
      console.warn(`\x1b[33m\u26a0 WARNING: No sandbox backend (bwrap/firejail) found. Using basic resource limits only. Process-level isolation for Bash commands is NOT available.\x1b[0m`);
    }
  }

  _cachedCapabilities = caps;
  return caps;
}

// ── Sandbox class ────────────────────────────────────────────────────────────

export class Sandbox {
  /**
   * @param {object} options
   * @param {string} [options.mode='on']           - Sandbox mode: 'off', 'on', 'strict'
   * @param {string} [options.workspace]            - Workspace root directory
   * @param {boolean} [options.sandboxSubAgents=true] - Apply sandbox to newly created sub-agents
   * @param {boolean} [options.allowNetwork=true]   - Allow network access in sandboxed Bash commands
   * @param {string[]} [options.allowedDomains]     - Domain allowlist for Fetch (strict mode)
   * @param {string[]} [options.additionalDenyPaths] - Extra paths to deny
   * @param {string} [options.symlinkPolicy='resolve'] - 'resolve' (default), 'block', or 'allow'
   * @param {boolean} [options.scanContent=false]   - Scan written content for secrets (strict mode auto-enables)
   * @param {number} [options.maxWriteSize=10485760] - Max file write size in bytes (default 10MB)
   * @param {object} [options.rateLimits]           - Rate limiting config { bashPerMinute, fetchPerMinute }
   */
  constructor(options = {}) {
    // Validate mode against known values
    const requestedMode = options.mode || SANDBOX_ON;
    if (!SANDBOX_MODES.includes(requestedMode)) {
      throw new Error(`Invalid sandbox mode "${requestedMode}". Must be one of: ${SANDBOX_MODES.join(", ")}`);
    }
    this.mode = requestedMode;
    this.workspace = options.workspace || process.cwd();
    this._workspaceTmp = path.join(this.workspace, '.mercury', 'tmp');
    this.sandboxSubAgents = options.sandboxSubAgents !== false;
    this.allowNetwork = options.allowNetwork !== false;
    this.allowedDomains = [...(options.allowedDomains || [])];
    this.additionalDenyPaths = [...(options.additionalDenyPaths || [])];
    this._capabilities = null;

    // ── New security features ──
    // Symlink policy: 'resolve' (follow & check target), 'block' (reject symlinks), 'allow' (no check)
    this.symlinkPolicy = options.symlinkPolicy || "resolve";
    // Content scanning for secrets in file writes
    this.scanContent = options.scanContent ?? (this.mode === SANDBOX_STRICT);
    // Max write size (default 10MB)
    this.maxWriteSize = options.maxWriteSize ?? 10485760;
    // Rate limiting
    this._rateLimits = options.rateLimits || {
      bashPerMinute: this.mode === SANDBOX_STRICT ? 30 : 60,
      fetchPerMinute: this.mode === SANDBOX_STRICT ? 20 : 40,
    };
    // Rate limit tracking
    this._rateBuckets = { bash: [], fetch: [] };
    // Security event log (in-memory, last 200 events)
    this._securityEvents = [];
  }

  /**
   * Initialize: detect available sandboxing backends.
   * Call this once before using the sandbox.
   */
  init() {
    this._capabilities = detectCapabilities();
    return this;
  }

  setWorkspace(workspace) {
    this.workspace = workspace || process.cwd();
    this._workspaceTmp = path.join(this.workspace, '.mercury', 'tmp');
    return this;
  }

  setMode(mode) {
    if (!SANDBOX_MODES.includes(mode)) {
      throw new Error(`Invalid sandbox mode "${mode}". Must be one of: ${SANDBOX_MODES.join(", ")}`);
    }
    this.mode = mode;
    return this;
  }

  /**
   * Whether sandboxing is active (mode !== 'off').
   */
  get enabled() {
    return this.mode !== SANDBOX_OFF;
  }

  /**
   * Get a human-readable status for display.
   */
  getStatus() {
    if (!this.enabled) {
      return { mode: SANDBOX_OFF, backend: "none", icon: "⊘", label: "Sandbox OFF" };
    }

    const caps = this._capabilities || detectCapabilities();
    let backend = "basic";
    if (caps.bwrap) backend = "bwrap";
    else if (caps.firejail) backend = "firejail";
    else if (caps.unshare) backend = "unshare";

    const icon = this.mode === SANDBOX_STRICT ? "🛡️" : "🔒";
    const modeLabel = this.mode === SANDBOX_STRICT ? "Strict" : "On";
    const label = `Sandbox ${modeLabel} (${backend})`;

    return {
      mode: this.mode,
      backend,
      icon,
      label,
      subAgents: this.sandboxSubAgents,
      network: this.allowNetwork,
    };
  }

  hasCommandIsolation() {
    const caps = this._capabilities || detectCapabilities();
    return !!(caps.bwrap || caps.firejail);
  }

  // ── Bash command sandboxing ──────────────────────────────────────────────

  /**
   * Wrap a bash command in sandbox isolation.
   * Returns the modified command string to execute.
   *
   * @param {string} command   - Original command to execute
   * @param {object} [options]
   * @param {string} [options.cwd] - Working directory (defaults to workspace)
   * @returns {string} Wrapped command
   */
  wrapCommand(command, options = {}) {
    if (!this.enabled) return command;

    const cwd = options.cwd || this.workspace;
    const caps = this._capabilities || detectCapabilities();

    // Strategy 1: bubblewrap (best isolation)
    if (caps.bwrap) {
      throw new Error("wrapCommand does not support bubblewrap command strings; use spawnCommand()");
    }

    // Strategy 2: firejail
    if (caps.firejail) {
      return this._wrapWithFirejail(command, cwd);
    }

    // Strategy 3: ulimit-based restrictions (always available)
    return this._wrapWithUlimit(command, cwd);
  }

  /**
   * Build bwrap args array for namespace-based isolation.
   * Returns { bin, args } for use with spawnSync/execFileSync.
   * - Read-only bind mount of root filesystem
   * - Read-write bind mount of workspace
   * - Devtmpfs for /dev
   * - Proc for /proc
   * - Network disabled in strict mode
   */
  _buildBwrapArgs(command, cwd) {
    const args = [];

    // Read-only root filesystem
    args.push("--ro-bind", "/", "/");

    // Read-write workspace
    args.push("--bind", this.workspace, this.workspace);

    // Read-write /tmp for scratch
    args.push("--tmpfs", "/tmp");

    // Device and proc filesystems
    args.push("--dev", "/dev");
    args.push("--proc", "/proc");

    // Working directory
    args.push("--chdir", cwd);

    // PID, IPC namespace isolation and parent-death signal
    args.push("--unshare-pid");
    args.push("--unshare-ipc");
    args.push("--die-with-parent");

    // Disable network when not explicitly allowed
    if (!this.allowNetwork) {
      args.push("--unshare-net");
    }

    // Disable git hooks and system config inside sandbox
    args.push("--setenv", "GIT_CONFIG_NOSYSTEM", "1");
    args.push("--setenv", "GIT_TERMINAL_PROMPT", "0");

    // Resource limits via ulimit inside the sandbox
    const ulimits = this._getUlimits();
    const innerCmd = ulimits ? `${ulimits} && ${command}` : command;

    // Pass the inner command to sh -c; since we use spawnSync with an args
    // array, the inner command string is passed as a single argument to sh
    // and does NOT go through double shell interpretation.
    args.push("--", "sh", "-c", innerCmd);

    return { bin: "bwrap", args };
  }

  /**
   * Legacy wrapper retained only so callers fail closed when trying to build
   * a bubblewrap shell string instead of using spawnCommand().
   */
  _wrapWithBwrap(command, cwd) {
    const { bin, args } = this._buildBwrapArgs(command, cwd);
    throw new Error(`Bubblewrap command strings are disabled for safety: ${bin} ${args.join(" ")}`);
  }

  /**
   * Execute a sandboxed command using spawnSync with an args array,
   * avoiding double shell interpretation entirely.
   * @param {string} command - The command to run inside the sandbox
   * @param {object} [options] - { cwd, timeout, encoding }
   * @returns {{ stdout: string, stderr: string, status: number }}
   */
  spawnCommand(command, options = {}) {
    if (!this.enabled) {
      const result = spawnSync("sh", ["-c", command], {
        cwd: options.cwd || this.workspace,
        timeout: options.timeout,
        encoding: options.encoding || "utf-8",
        stdio: "pipe",
        env: options.env,
      });
      return result;
    }

    const cwd = options.cwd || this.workspace;
    const caps = this._capabilities || detectCapabilities();

    if (caps.bwrap) {
      const { bin, args } = this._buildBwrapArgs(command, cwd);
      return spawnSync(bin, args, {
        timeout: options.timeout,
        encoding: options.encoding || "utf-8",
        stdio: "pipe",
        env: options.env,
      });
    }

    // Fallback to shell execution for firejail/ulimit wrappers
    const wrapped = caps.firejail
      ? this._wrapWithFirejail(command, cwd)
      : this._wrapWithUlimit(command, cwd);
    return spawnSync("sh", ["-c", wrapped], {
      cwd,
      timeout: options.timeout,
      encoding: options.encoding || "utf-8",
      stdio: "pipe",
      env: options.env,
    });
  }

  /**
   * Wrap command using firejail for seccomp-based sandboxing.
   */
  _wrapWithFirejail(command, cwd) {
    const parts = ["firejail"];

    // Restrict to workspace
    parts.push(`--whitelist=${this._shellEscape(this.workspace)}`);
    parts.push("--private-tmp");

    // No new privileges
    parts.push("--nonewprivs");

    // Seccomp system call filtering
    parts.push("--seccomp");

    // Quiet mode
    parts.push("--quiet");

    // Working directory
    parts.push(`--chdir=${this._shellEscape(cwd)}`);

    // Disable network when not explicitly allowed
    if (!this.allowNetwork) {
      parts.push("--net=none");
    }

    // Disable git hooks and system config inside sandbox
    parts.push("--env=GIT_CONFIG_NOSYSTEM=1");
    parts.push("--env=GIT_TERMINAL_PROMPT=0");

    // The command
    const ulimits = this._getUlimits();
    const innerCmd = ulimits ? `${ulimits} && ${command}` : command;
    parts.push("--", "sh", "-c", this._shellEscape(innerCmd));

    return parts.join(" ");
  }

  /**
   * Fallback: wrap command with ulimit restrictions.
   * This provides resource limits but not filesystem isolation.
   */
  _wrapWithUlimit(command, _cwd) {
    const ulimits = this._getUlimits();
    const gitEnv = "GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0";
    if (!ulimits) return `${gitEnv} ${command}`;
    return `${ulimits} && ${gitEnv} ${command}`;
  }

  /**
   * Generate ulimit commands for resource restriction.
   */
  _getUlimits() {
    const limits = [];

    // Max virtual memory: 2GB (prevent memory bombs)
    limits.push("ulimit -v 2097152 2>/dev/null");

    // Max file size: 100MB (prevent disk filling)
    limits.push("ulimit -f 102400 2>/dev/null");

    // Max number of processes: 256 (prevent fork bombs)
    limits.push("ulimit -u 256 2>/dev/null");

    // Max open files: 1024
    limits.push("ulimit -n 1024 2>/dev/null");

    // CPU time limit: 300 seconds (5 min hard limit)
    if (this.mode === SANDBOX_STRICT) {
      limits.push("ulimit -t 300 2>/dev/null");
    }

    return limits.join("; ");
  }

  // ── Path policy enforcement ────────────────────────────────────────────

  /**
   * Check if a file path is allowed for a given operation.
   * Returns { allowed: boolean, reason?: string }
   *
   * @param {string} filePath  - Path to check
   * @param {string} operation - 'read' or 'write'
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkPath(filePath, operation = "read") {
    if (typeof filePath !== 'string' || filePath.includes('\0')) {
      return { allowed: false, reason: 'Sandbox: path contains null bytes or is not a string' };
    }

    if (!this.enabled) return { allowed: true };

    // Validate operation type
    if (operation !== "read" && operation !== "write") {
      return { allowed: false, reason: `Sandbox: invalid operation type "${operation}" (must be "read" or "write")` };
    }

    const resolved = this._resolvePolicyPath(filePath);
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || (process.platform === "win32" ? "C:\\Users\\Default" : "/root");
    const { workspaceRoot, tmpRoot } = this._getBoundaryRoots();
    const inWorkspace = this._isWithinRoot(resolved, workspaceRoot);

    // Workspace-specific temp directory: always allowed for reads and writes
    const workspaceTmpResolved = this._resolvePolicyPath(this._workspaceTmp);
    const inWorkspaceTmp = this._isWithinRoot(resolved, workspaceTmpResolved);
    // System /tmp: allowed for reads only, NOT for writes (prevents temp-dir abuse)
    const inSystemTmp = this._isWithinRoot(resolved, tmpRoot);

    // Check sensitive paths (both read and write) — using normalized paths
    for (const sensitiveRel of SENSITIVE_PATHS) {
      const sensitiveAbs = this._resolvePolicyPath(path.join(home, sensitiveRel));
      if (this._isWithinRoot(resolved, sensitiveAbs)) {
        this._logSecurityEvent("sensitive_path_blocked", `${operation} ${filePath} → ${resolved}`);
        return {
          allowed: false,
          reason: `Sandbox: access to ${sensitiveRel} is blocked (sensitive credentials path)`,
        };
      }
    }

    // Check additional deny paths
    for (const denyPath of this.additionalDenyPaths) {
      const denyAbs = this._resolvePolicyPath(denyPath);
      if (this._isWithinRoot(resolved, denyAbs)) {
        this._logSecurityEvent("custom_deny_blocked", `${operation} ${filePath}`);
        return {
          allowed: false,
          reason: `Sandbox: access to ${denyPath} is blocked (custom deny rule)`,
        };
      }
    }

    // Allow workspace and temp paths before generic system write protections.
    // This keeps workspaces nested under /root, /usr/src, etc. usable while
    // still blocking clearly sensitive locations above.
    // For reads: allow workspace, workspace-tmp, and system /tmp (read-only)
    // For writes: only allow workspace and workspace-tmp, NOT system /tmp
    const inAllowedRoot = operation === "read"
      ? (inWorkspace || inWorkspaceTmp || inSystemTmp)
      : (inWorkspace || inWorkspaceTmp);

    // CRITICAL: Prevent arbitrary writes to .mercury workspace configuration
    // (allows reading them, and allows writing to .mercury/tmp)
    if (operation === "write" && inWorkspace && !inWorkspaceTmp) {
      const dotMercury = this._resolvePolicyPath(path.join(this.workspace, ".mercury"));
      if (this._isWithinRoot(resolved, dotMercury)) {
        this._logSecurityEvent("workspace_config_write_blocked", `${filePath} → ${resolved}`);
        return {
          allowed: false,
          reason: `Sandbox: writes to workspace configuration (.mercury/) are blocked`
        };
      }
    }

    // For write operations, additionally check system paths
    if (operation === "write") {
      for (const sysPath of SYSTEM_DENY_WRITE) {
        const sysResolved = this._resolvePolicyPath(sysPath);
        const workspaceNestedUnderSystem =
          workspaceRoot !== sysResolved &&
          this._isWithinRoot(workspaceRoot, sysResolved);

        if (this._isWithinRoot(resolved, sysResolved) && !(inWorkspace && workspaceNestedUnderSystem)) {
          this._logSecurityEvent("system_write_blocked", `${filePath} → ${resolved}`);
          return {
            allowed: false,
            reason: `Sandbox: writes to ${sysPath} are blocked (system path)`,
          };
        }
      }
    }

    // "on" and "strict" are both workspace-scoped. Strict keeps the stronger
    // messaging because callers/tests distinguish it explicitly.
    if ((this.mode === SANDBOX_ON || this.mode === SANDBOX_STRICT) && !inAllowedRoot) {
      const eventType = this.mode === SANDBOX_STRICT ? "strict_boundary_blocked" : "boundary_blocked";
      this._logSecurityEvent(eventType, `${operation} ${filePath} → ${resolved}`);
      return {
        allowed: false,
        reason: this.mode === SANDBOX_STRICT
          ? `Sandbox strict: ${operation}s outside workspace are blocked: ${resolved}`
          : `Sandbox: ${operation}s outside the workspace or temp directory are blocked: ${resolved}`,
      };
    }

    return { allowed: true };
  }

  _resolvePolicyPath(filePath) {
    const absolute = path.resolve(filePath);
    try {
      return fs.realpathSync(absolute);
    } catch (err) {
      debugLog("Sandbox._resolvePolicyPath", err);
      return this._resolveViaAncestor(absolute);
    }
  }

  _getTmpDir() {
    return process.platform === "win32"
      ? (process.env.TEMP || process.env.TMP || "C:\\Temp")
      : "/tmp";
  }

  _getBoundaryRoots() {
    return {
      workspaceRoot: this._resolvePolicyPath(this.workspace),
      tmpRoot: this._resolvePolicyPath(this._getTmpDir()),
    };
  }

  _isWithinRoot(targetPath, rootPath) {
    // Normalize for Windows case-insensitive comparison
    if (process.platform === "win32") {
      const t = targetPath.toLowerCase();
      const r = rootPath.toLowerCase();
      return t === r || t.startsWith(r + path.sep);
    }
    return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
  }

  /**
   * Resolve a non-existent path by walking up to nearest existing ancestor,
   * resolving symlinks on the ancestor, and appending remaining segments.
   * Delegates to shared utility in utils/path-safety.js.
   * @param {string} filePath
   * @returns {string} Resolved path
   */
  _resolveViaAncestor(filePath) {
    const resolved = _sharedResolveViaAncestor(filePath);
    // Log if resolution fell back to absolute (no ancestor found)
    const absolute = path.resolve(filePath);
    if (resolved === absolute) {
      try {
        fs.realpathSync(filePath);
      } catch (err) {
        debugLog("Sandbox._resolveViaAncestor", err);
        this._logSecurityEvent("ancestor_resolution_failed", absolute);
      }
    }
    return resolved;
  }

  // ── URL / network policy ──────────────────────────────────────────────

  /**
   * Check if a URL is allowed by the sandbox policy.
   * In strict mode with allowedDomains set, only those domains are permitted.
   *
   * @param {string} url - URL to check
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkUrl(url) {
    if (!this.enabled) return { allowed: true };

    // Force URL parsing first — reject malformed URLs early
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      debugLog("Sandbox.checkUrl", err);
      this._logSecurityEvent("invalid_url", url);
      return { allowed: false, reason: "Sandbox: invalid URL" };
    }
    if (parsed.username || parsed.password) {
      this._logSecurityEvent("credentialed_url", url);
      return { allowed: false, reason: "Sandbox: URLs with embedded credentials are blocked" };
    }
    if (parsed.hostname.split(".").some((label) => label.startsWith("xn--"))) {
      this._logSecurityEvent("idn_blocked", parsed.hostname);
      return { allowed: false, reason: "Sandbox: IDN/punycode hostnames are blocked" };
    }

    // allowNetwork=false: block ALL network access in any sandbox mode
    if (this.enabled && !this.allowNetwork) {
      this._logSecurityEvent("network_blocked", url);
      return {
        allowed: false,
        reason: "Sandbox: network access is disabled (allowNetwork=false)",
      };
    }

    // Protocol enforcement — only http: and https: allowed (defense-in-depth).
    // Blocks file://, ftp://, data://, javascript:, etc. in all modes.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      this._logSecurityEvent("protocol_blocked", `${parsed.protocol} ${url}`);
      return {
        allowed: false,
        reason: `Sandbox: protocol ${parsed.protocol} is not allowed (only http/https)`,
      };
    }

    // Block non-HTTPS in strict mode — NO localhost exception
    // (localhost HTTP can be used for SSRF to cloud metadata endpoints etc.)
    if (this.mode === SANDBOX_STRICT) {
      if (parsed.protocol !== "https:") {
        this._logSecurityEvent("http_blocked", url);
        return {
          allowed: false,
          reason: "Sandbox strict: plain HTTP is blocked, including localhost (use HTTPS)",
        };
      }
    }

    // Domain allowlist (strict mode only, when configured)
    if (this.mode === SANDBOX_STRICT && this.allowedDomains.length > 0) {
      // Normalize domain: lowercase, strip trailing dot
      if (!parsed.hostname) {
        this._logSecurityEvent("domain_blocked", "null hostname");
        return {
          allowed: false,
          reason: "Sandbox strict: malformed URL (no hostname)",
        };
      }
      const domain = parsed.hostname.toLowerCase().replace(/\.$/, "");
      const normalizedAllowlist = this.allowedDomains
        .map(d => d.toLowerCase().replace(/\.$/, ""))
        .filter(d => d.includes('.')); // Reject single-label domains
      const isAllowed = normalizedAllowlist.some(
        (d) => domain === d || domain.endsWith("." + d)
      );
      if (!isAllowed) {
        this._logSecurityEvent("domain_blocked", `${domain} not in [${normalizedAllowlist.join(", ")}]`);
        return {
          allowed: false,
          reason: `Sandbox strict: domain ${domain} is not in allowlist [${normalizedAllowlist.join(", ")}]`,
        };
      }
    }

    return { allowed: true };
  }

  // ── Symlink policy enforcement ────────────────────────────────────────

  /**
   * Check a path against the symlink policy.
   * @param {string} filePath - Path to check
   * @returns {{ allowed: boolean, resolvedPath?: string, reason?: string }}
   */
  checkSymlink(filePath) {
    if (!this.enabled) {
      return { allowed: true, resolvedPath: filePath };
    }

    try {
      const lstat = fs.lstatSync(filePath);
      const isSymlink = lstat.isSymbolicLink();

      if (isSymlink && this.symlinkPolicy === "block") {
        this._logSecurityEvent("symlink_blocked", filePath);
        return {
          allowed: false,
          reason: `Sandbox: symlinks are blocked by policy (path: ${filePath})`,
        };
      }

      if (isSymlink && this.symlinkPolicy === "resolve") {
        // Resolve the symlink and verify target is within workspace or /tmp
        const realTarget = this._resolvePolicyPath(filePath);
        const { workspaceRoot, tmpRoot } = this._getBoundaryRoots();
        const inWorkspace = this._isWithinRoot(realTarget, workspaceRoot);
        const inTmp = this._isWithinRoot(realTarget, tmpRoot);

        if (!inWorkspace && !inTmp) {
          this._logSecurityEvent("symlink_escape", `${filePath} → ${realTarget}`);
          return {
            allowed: false,
            reason: `Sandbox: symlink target ${realTarget} is outside workspace (escape attempt)`,
          };
        }
        return { allowed: true, resolvedPath: realTarget };
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        // Path doesn't exist yet — resolve via ancestor to detect symlink escapes
        // in parent directories (e.g. /workspace/evil-link/newfile where evil-link → /etc)
        const ancestorResolved = this._resolveViaAncestor(filePath);
        const { workspaceRoot, tmpRoot } = this._getBoundaryRoots();
        const inWorkspace = this._isWithinRoot(ancestorResolved, workspaceRoot);
        const inTmp = this._isWithinRoot(ancestorResolved, tmpRoot);
        if (!inWorkspace && !inTmp) {
          this._logSecurityEvent("symlink_escape_newpath", `${filePath} → ${ancestorResolved}`);
          return {
            allowed: false,
            reason: `Sandbox: resolved path ${ancestorResolved} is outside workspace`,
          };
        }
        return { allowed: true, resolvedPath: ancestorResolved };
      }
      // Other errors (EACCES, EIO, etc.) — deny for safety
      this._logSecurityEvent("symlink_error", `${filePath}: ${err.code || err.message}`);
      return {
        allowed: false,
        reason: `Sandbox: cannot verify symlink status for ${filePath} (${err.code || err.message})`,
      };
    }

    return { allowed: true, resolvedPath: filePath };
  }

  // ── Rate limiting ──────────────────────────────────────────────────────

  /**
   * Check rate limit for a given operation type.
   * @param {string} opType - 'bash' or 'fetch'
   * @returns {{ allowed: boolean, reason?: string, retryAfterMs?: number }}
   */
  checkRateLimit(opType) {
    if (!this.enabled) return { allowed: true };

    // Validate opType against known operation types to prevent prototype pollution
    if (opType !== "bash" && opType !== "fetch") {
      return { allowed: false, reason: `Sandbox: unknown rate limit operation type: ${opType}` };
    }

    const limitKey = `${opType}PerMinute`;
    const limit = this._rateLimits[limitKey];
    if (!limit) return { allowed: true };

    const bucket = this._rateBuckets[opType];
    if (!bucket) return { allowed: true };

    const now = Date.now();
    const windowMs = 60000; // 1 minute

    // Prune old entries (guard against clock skew — also remove entries in the future)
    while (bucket.length > 0 && (bucket[0] < now - windowMs || bucket[0] > now)) {
      bucket.shift();
    }

    if (bucket.length >= limit) {
      const retryAfterMs = bucket.length > 0 ? Math.max(0, bucket[0] + windowMs - now) : windowMs;
      this._logSecurityEvent("rate_limited", `${opType}: ${bucket.length}/${limit} per minute`);
      return {
        allowed: false,
        reason: `Sandbox: rate limit exceeded for ${opType} (${limit}/min). Retry in ${Math.ceil(retryAfterMs / 1000)}s.`,
        retryAfterMs,
      };
    }

    bucket.push(now);
    return { allowed: true };
  }

  // ── File write validation ──────────────────────────────────────────────

  /**
   * Validate a file write operation (size, extension, content scanning).
   * @param {string} filePath - Target file path
   * @param {string|Buffer} content - Content to write
   * @returns {{ allowed: boolean, reason?: string, warnings?: string[] }}
   */
  checkWrite(filePath, content) {
    if (!this.enabled) return { allowed: true };

    const warnings = [];

    // Validate content type
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      return { allowed: false, reason: 'Sandbox: content must be a string or Buffer' };
    }

    // 1. Check file size limit
    const size = typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.length;
    if (size > this.maxWriteSize) {
      this._logSecurityEvent("write_size_exceeded", `${filePath}: ${size} bytes > ${this.maxWriteSize}`);
      return {
        allowed: false,
        reason: `Sandbox: file write exceeds size limit (${(size / 1048576).toFixed(1)}MB > ${(this.maxWriteSize / 1048576).toFixed(1)}MB)`,
      };
    }

    // 2. Check dangerous extensions (strict mode only)
    if (this.mode === SANDBOX_STRICT) {
      const ext = path.extname(filePath).toLowerCase();
      if (DANGEROUS_WRITE_EXTENSIONS.has(ext)) {
        this._logSecurityEvent("dangerous_extension", `${filePath} (${ext})`);
        return {
          allowed: false,
          reason: `Sandbox strict: writing executable files (${ext}) is blocked`,
        };
      }
    }

    // 3. Content scanning for secrets (handles both strings and Buffers)
    if (this.scanContent) {
      const textContent = typeof content === "string" ? content : content.toString("utf-8");
      const detectedSecrets = [];
      for (const pattern of SECRET_CONTENT_PATTERNS) {
        if (pattern.test(textContent)) {
          detectedSecrets.push(pattern.source.slice(0, 30));
          this._logSecurityEvent("secret_in_content", `${filePath}: matched ${pattern.source.slice(0, 40)}`);
        }
      }
      if (detectedSecrets.length > 0) {
        // In strict mode, block writes containing secrets
        if (this.mode === SANDBOX_STRICT) {
          return {
            allowed: false,
            reason: `Sandbox strict: potential secrets detected in content (${detectedSecrets.join(", ")}...)`,
          };
        }
        // In standard mode, warn but allow
        for (const s of detectedSecrets) {
          warnings.push(`Potential secret detected in content (pattern: ${s}...)`);
        }
      }
    }

    return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  // ── Security event logging ─────────────────────────────────────────────

  /**
   * Log a security event (in-memory ring buffer, last 200).
   * @param {string} type - Event type
   * @param {string} detail - Event detail
   */
  _logSecurityEvent(type, detail) {
    const event = {
      ts: Date.now(),
      type,
      detail,
      mode: this.mode,
    };
    this._securityEvents.push(event);
    if (this._securityEvents.length > 200) {
      this._securityEvents.shift();
    }
  }

  /**
   * Get recent security events (for audit/debug).
   * @param {number} [count=50] - Max events to return
   * @returns {Array<{ts: number, type: string, detail: string, mode: string}>}
   */
  getSecurityEvents(count = 50) {
    return this._securityEvents.slice(-count);
  }

  /**
   * Export security events as a formatted string for audit logging.
   * @returns {string}
   */
  exportSecurityLog() {
    return this._securityEvents
      .map((e) => `[${new Date(e.ts).toISOString()}] [${e.mode}] ${e.type}: ${e.detail}`)
      .join("\n");
  }

  // ── Serialization for sub-agents ───────────────────────────────────────

  /**
   * Export sandbox config for passing to sub-agents.
   * Returns a plain options object that can be used in SubAgent constructor.
   */
  toSubAgentConfig() {
    if (!this.sandboxSubAgents) {
      return { mode: SANDBOX_OFF };
    }
    return {
      mode: this.mode,
      workspace: this.workspace,
      sandboxSubAgents: this.sandboxSubAgents,
      allowNetwork: this.allowNetwork,
      allowedDomains: this.allowedDomains,
      additionalDenyPaths: this.additionalDenyPaths,
      symlinkPolicy: this.symlinkPolicy,
      scanContent: this.scanContent,
      maxWriteSize: this.maxWriteSize,
      rateLimits: { ...this._rateLimits },
    };
  }

  // ── Summary ────────────────────────────────────────────────────────────

  /**
   * Get a comprehensive security summary for diagnostics.
   * @returns {object}
   */
  getSecuritySummary() {
    const caps = this._capabilities || detectCapabilities();
    return {
      mode: this.mode,
      enabled: this.enabled,
      backend: caps.bwrap ? "bwrap" : caps.firejail ? "firejail" : caps.unshare ? "unshare" : "basic",
      workspace: this.workspace,
      symlinkPolicy: this.symlinkPolicy,
      scanContent: this.scanContent,
      maxWriteSize: this.maxWriteSize,
      rateLimits: { ...this._rateLimits },
      allowNetwork: this.allowNetwork,
      allowedDomains: this.allowedDomains,
      additionalDenyPaths: this.additionalDenyPaths,
      sandboxSubAgents: this.sandboxSubAgents,
      blockedExtensions: this.mode === SANDBOX_STRICT ? [...DANGEROUS_WRITE_EXTENSIONS] : [],
      sensitivePathCount: SENSITIVE_PATHS.length,
      systemDenyWriteCount: SYSTEM_DENY_WRITE.length,
      recentSecurityEvents: this._securityEvents.length,
    };
  }

  // ── Utility ────────────────────────────────────────────────────────────

  /**
   * Escape a string for safe use in shell commands.
   */
  _shellEscape(str) {
    str = String(str).replace(/\0/g, '');
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
}

/**
 * Create a default sandbox instance (mode=on, auto-detect capabilities).
 */
export function createDefaultSandbox(workspace) {
  const sandbox = new Sandbox({ mode: SANDBOX_ON, workspace });
  sandbox.init();
  return sandbox;
}
