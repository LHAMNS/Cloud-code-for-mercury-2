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

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

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

  // Check bubblewrap
  try {
    execSync("which bwrap", { encoding: "utf-8", timeout: 3000, stdio: "pipe" });
    // Verify it actually works (needs user namespaces)
    execSync("bwrap --ro-bind / / --dev /dev true", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });
    caps.bwrap = true;
  } catch {
    // Not available or not functional
  }

  // Check firejail
  try {
    execSync("which firejail", { encoding: "utf-8", timeout: 3000, stdio: "pipe" });
    caps.firejail = true;
  } catch {
    // Not available
  }

  // Check unshare
  try {
    execSync("which unshare", { encoding: "utf-8", timeout: 3000, stdio: "pipe" });
    caps.unshare = true;
  } catch {
    // Not available
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
    this.mode = options.mode || SANDBOX_ON;
    this.workspace = options.workspace || process.cwd();
    this.sandboxSubAgents = options.sandboxSubAgents !== false;
    this.allowNetwork = options.allowNetwork !== false;
    this.allowedDomains = options.allowedDomains || [];
    this.additionalDenyPaths = options.additionalDenyPaths || [];
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
    // Nonce for tamper detection on sandbox config export
    this._nonce = crypto.randomBytes(8).toString("hex");
  }

  /**
   * Initialize: detect available sandboxing backends.
   * Call this once before using the sandbox.
   */
  init() {
    this._capabilities = detectCapabilities();
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
      return this._wrapWithBwrap(command, cwd);
    }

    // Strategy 2: firejail
    if (caps.firejail) {
      return this._wrapWithFirejail(command, cwd);
    }

    // Strategy 3: ulimit-based restrictions (always available)
    return this._wrapWithUlimit(command, cwd);
  }

  /**
   * Wrap command using bubblewrap for namespace-based isolation.
   * - Read-only bind mount of root filesystem
   * - Read-write bind mount of workspace
   * - Devtmpfs for /dev
   * - Proc for /proc
   * - Network disabled in strict mode
   */
  _wrapWithBwrap(command, cwd) {
    const parts = ["bwrap"];

    // Read-only root filesystem
    parts.push("--ro-bind / /");

    // Read-write workspace
    parts.push(`--bind ${this._shellEscape(this.workspace)} ${this._shellEscape(this.workspace)}`);

    // Read-write /tmp for scratch
    parts.push("--bind /tmp /tmp");

    // Device and proc filesystems
    parts.push("--dev /dev");
    parts.push("--proc /proc");

    // Working directory
    parts.push(`--chdir ${this._shellEscape(cwd)}`);

    // Disable network in strict mode
    if (this.mode === SANDBOX_STRICT && !this.allowNetwork) {
      parts.push("--unshare-net");
    }

    // Resource limits via ulimit inside the sandbox
    const ulimits = this._getUlimits();
    const innerCmd = ulimits ? `${ulimits} && ${command}` : command;

    parts.push("--", "sh", "-c", this._shellEscape(innerCmd));

    return parts.join(" ");
  }

  /**
   * Wrap command using firejail for seccomp-based sandboxing.
   */
  _wrapWithFirejail(command, cwd) {
    const parts = ["firejail"];

    // Restrict to workspace
    parts.push(`--whitelist=${this._shellEscape(this.workspace)}`);
    parts.push("--whitelist=/tmp");

    // No new privileges
    parts.push("--nonewprivs");

    // Quiet mode
    parts.push("--quiet");

    // Working directory
    parts.push(`--chdir=${this._shellEscape(cwd)}`);

    // Disable network in strict mode
    if (this.mode === SANDBOX_STRICT && !this.allowNetwork) {
      parts.push("--net=none");
    }

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
    if (!ulimits) return command;
    return `${ulimits} && ${command}`;
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
    if (!this.enabled) return { allowed: true };

    // Validate operation type
    if (operation !== "read" && operation !== "write") {
      return { allowed: false, reason: `Sandbox: invalid operation type "${operation}" (must be "read" or "write")` };
    }

    // Normalize and resolve the path (resolves .. traversals)
    let resolved = path.resolve(filePath);

    // Attempt realpath resolution via nearest existing ancestor to catch
    // symlinks pointing outside workspace (e.g. workspace/link → /etc)
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      // File may not exist yet — walk up to nearest existing ancestor
      resolved = this._resolveViaAncestor(resolved);
    }

    const home = process.env.HOME || "/root";

    // Check sensitive paths (both read and write) — using normalized paths
    for (const sensitiveRel of SENSITIVE_PATHS) {
      const sensitiveAbs = path.resolve(home, sensitiveRel);
      if (resolved === sensitiveAbs || resolved.startsWith(sensitiveAbs + path.sep)) {
        this._logSecurityEvent("sensitive_path_blocked", `${operation} ${filePath} → ${resolved}`);
        return {
          allowed: false,
          reason: `Sandbox: access to ${sensitiveRel} is blocked (sensitive credentials path)`,
        };
      }
    }

    // Check additional deny paths
    for (const denyPath of this.additionalDenyPaths) {
      const denyAbs = path.resolve(denyPath);
      if (resolved === denyAbs || resolved.startsWith(denyAbs + path.sep)) {
        this._logSecurityEvent("custom_deny_blocked", `${operation} ${filePath}`);
        return {
          allowed: false,
          reason: `Sandbox: access to ${denyPath} is blocked (custom deny rule)`,
        };
      }
    }

    // For write operations, additionally check system paths
    if (operation === "write") {
      for (const sysPath of SYSTEM_DENY_WRITE) {
        if (resolved === sysPath || resolved.startsWith(sysPath + path.sep)) {
          this._logSecurityEvent("system_write_blocked", `${filePath} → ${resolved}`);
          return {
            allowed: false,
            reason: `Sandbox: writes to ${sysPath} are blocked (system path)`,
          };
        }
      }
    }

    // In strict mode, enforce workspace+/tmp boundary for BOTH read AND write
    if (this.mode === SANDBOX_STRICT) {
      const wsResolved = path.resolve(this.workspace);
      const inWorkspace =
        resolved === wsResolved || resolved.startsWith(wsResolved + path.sep);
      const tmpDir = process.platform === "win32"
        ? (process.env.TEMP || process.env.TMP || "C:\\Temp")
        : "/tmp";
      const inTmp = resolved.startsWith(tmpDir + path.sep) || resolved === tmpDir;

      if (!inWorkspace && !inTmp) {
        this._logSecurityEvent("strict_boundary_blocked", `${operation} ${filePath} → ${resolved}`);
        return {
          allowed: false,
          reason: `Sandbox strict: ${operation}s outside workspace are blocked: ${resolved}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Resolve a non-existent path by walking up to nearest existing ancestor,
   * resolving symlinks on the ancestor, and appending remaining segments.
   * Prevents symlink escape attacks (e.g. workspace/evil-link/file where evil-link → /etc).
   * @param {string} filePath
   * @returns {string} Resolved path
   */
  _resolveViaAncestor(filePath) {
    const absolute = path.resolve(filePath);
    let current = absolute;
    const trailing = [];

    while (current !== path.dirname(current)) {
      try {
        const real = fs.realpathSync(current);
        return trailing.length > 0
          ? path.join(real, ...trailing.reverse())
          : real;
      } catch {
        trailing.push(path.basename(current));
        current = path.dirname(current);
      }
    }
    return absolute;
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
    } catch {
      this._logSecurityEvent("invalid_url", url);
      return { allowed: false, reason: "Sandbox: invalid URL" };
    }

    // Strict + allowNetwork=false: block ALL network access
    if (this.mode === SANDBOX_STRICT && !this.allowNetwork) {
      this._logSecurityEvent("network_blocked", url);
      return {
        allowed: false,
        reason: "Sandbox strict: network access is disabled (allowNetwork=false)",
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
      const domain = parsed.hostname.toLowerCase().replace(/\.$/, "");
      const normalizedAllowlist = this.allowedDomains.map(
        (d) => d.toLowerCase().replace(/\.$/, "")
      );
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
    if (!this.enabled || this.symlinkPolicy === "allow") {
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
        const realTarget = fs.realpathSync(filePath);
        const wsResolved = path.resolve(this.workspace);
        const inWorkspace = realTarget === wsResolved || realTarget.startsWith(wsResolved + path.sep);
        const inTmp = realTarget.startsWith("/tmp" + path.sep) || realTarget === "/tmp";

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
        // Path doesn't exist yet — allow (will be created)
        return { allowed: true, resolvedPath: filePath };
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

    const limitKey = `${opType}PerMinute`;
    const limit = this._rateLimits[limitKey];
    if (!limit) return { allowed: true };

    const bucket = this._rateBuckets[opType];
    if (!bucket) return { allowed: true };

    const now = Date.now();
    const windowMs = 60000; // 1 minute

    // Prune old entries
    while (bucket.length > 0 && bucket[0] < now - windowMs) {
      bucket.shift();
    }

    if (bucket.length >= limit) {
      const retryAfterMs = bucket[0] + windowMs - now;
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

    // 3. Content scanning for secrets
    if (this.scanContent && typeof content === "string") {
      for (const pattern of SECRET_CONTENT_PATTERNS) {
        if (pattern.test(content)) {
          warnings.push(`Potential secret detected in content (pattern: ${pattern.source.slice(0, 30)}...)`);
          this._logSecurityEvent("secret_in_content", `${filePath}: matched ${pattern.source.slice(0, 40)}`);
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
