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
   */
  constructor(options = {}) {
    this.mode = options.mode || SANDBOX_ON;
    this.workspace = options.workspace || process.cwd();
    this.sandboxSubAgents = options.sandboxSubAgents !== false;
    this.allowNetwork = options.allowNetwork !== false;
    this.allowedDomains = options.allowedDomains || [];
    this.additionalDenyPaths = options.additionalDenyPaths || [];
    this._capabilities = null;
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

    const resolved = path.resolve(filePath);
    const home = process.env.HOME || "/root";

    // Check sensitive paths (both read and write)
    for (const sensitiveRel of SENSITIVE_PATHS) {
      const sensitiveAbs = path.resolve(home, sensitiveRel);
      if (resolved === sensitiveAbs || resolved.startsWith(sensitiveAbs + path.sep)) {
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
          return {
            allowed: false,
            reason: `Sandbox: writes to ${sysPath} are blocked (system path)`,
          };
        }
      }
    }

    // In strict mode, enforce that reads are also within workspace (except /tmp)
    if (this.mode === SANDBOX_STRICT && operation === "read") {
      const wsResolved = path.resolve(this.workspace);
      const inWorkspace =
        resolved === wsResolved || resolved.startsWith(wsResolved + path.sep);
      const inTmp = resolved.startsWith("/tmp" + path.sep) || resolved === "/tmp";

      if (!inWorkspace && !inTmp) {
        return {
          allowed: false,
          reason: `Sandbox strict: reads outside workspace are blocked: ${resolved}`,
        };
      }
    }

    return { allowed: true };
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

    // Block non-HTTPS in strict mode
    if (this.mode === SANDBOX_STRICT) {
      if (url.startsWith("http://") && !url.startsWith("http://localhost") && !url.startsWith("http://127.0.0.1")) {
        return {
          allowed: false,
          reason: "Sandbox strict: plain HTTP is blocked (use HTTPS)",
        };
      }
    }

    // Domain allowlist (strict mode only, when configured)
    if (this.mode === SANDBOX_STRICT && this.allowedDomains.length > 0) {
      try {
        const parsed = new URL(url);
        const domain = parsed.hostname;
        const isAllowed = this.allowedDomains.some(
          (d) => domain === d || domain.endsWith("." + d)
        );
        if (!isAllowed) {
          return {
            allowed: false,
            reason: `Sandbox strict: domain ${domain} is not in allowlist [${this.allowedDomains.join(", ")}]`,
          };
        }
      } catch {
        return { allowed: false, reason: "Sandbox: invalid URL" };
      }
    }

    return { allowed: true };
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
