// Mercury Code - Sandbox Module (Rust port)
// Ported from: src/sandbox.js
//
// Provides configurable filesystem isolation for file operations.
// Three modes:
//   Off        — No sandboxing (legacy behavior)
//   On         — Default: workspace-scoped filesystem, sensitive path blocking
//   Permissive — Relaxed: blocks sensitive paths but allows broader access
//
// Key security features:
//   - Sensitive path deny-list (SSH keys, credentials, cloud configs, shell history)
//   - System path write protection (/etc, /usr, /bin, etc.)
//   - Symlink escape detection via ancestor resolution
//   - Path traversal prevention
//   - Null byte rejection

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::path_safety::{is_in_workspace, resolve_via_ancestor};

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("invalid sandbox mode: {0}")]
    InvalidMode(String),

    #[error("path blocked: {reason}")]
    PathBlocked { reason: String },

    #[error("null byte in path")]
    NullBytePath,

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

// ── Sandbox Mode ────────────────────────────────────────────────────────────

/// The three sandbox operating modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SandboxMode {
    /// No sandboxing — all paths allowed.
    Off,
    /// Default: workspace-scoped filesystem, sensitive path blocking.
    On,
    /// Relaxed mode: blocks sensitive paths but allows broader workspace access.
    Permissive,
}

impl SandboxMode {
    pub fn from_str_loose(s: &str) -> Result<Self, SandboxError> {
        match s.to_lowercase().as_str() {
            "off" => Ok(Self::Off),
            "on" => Ok(Self::On),
            "permissive" | "strict" => Ok(Self::Permissive),
            _ => Err(SandboxError::InvalidMode(s.to_string())),
        }
    }
}

impl std::fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => write!(f, "off"),
            Self::On => write!(f, "on"),
            Self::Permissive => write!(f, "permissive"),
        }
    }
}

// ── Path check result ───────────────────────────────────────────────────────

/// Result of a path policy check.
#[derive(Debug, Clone)]
pub struct PathCheckResult {
    pub allowed: bool,
    pub reason: Option<String>,
}

impl PathCheckResult {
    fn allow() -> Self {
        Self {
            allowed: true,
            reason: None,
        }
    }

    fn deny(reason: impl Into<String>) -> Self {
        Self {
            allowed: false,
            reason: Some(reason.into()),
        }
    }
}

// ── Sensitive paths deny-list ───────────────────────────────────────────────
// These paths (relative to $HOME) are blocked even inside a generous workspace.

const SENSITIVE_PATHS: &[&str] = &[
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

/// System paths that should never be written to.
const SYSTEM_DENY_WRITE: &[&str] = &[
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev",
    "/var/run", "/var/lock", "/var/spool", "/root",
];

// ── Symlink policy ──────────────────────────────────────────────────────────

/// How symlinks are handled during path checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymlinkPolicy {
    /// Follow symlinks and verify the resolved target is within workspace.
    Resolve,
    /// Reject any path that is a symlink.
    Block,
    /// No symlink checking.
    Allow,
}

impl Default for SymlinkPolicy {
    fn default() -> Self {
        Self::Resolve
    }
}

// ── Sandbox ─────────────────────────────────────────────────────────────────

/// Filesystem sandbox enforcing workspace-scoped path policies.
///
/// Checks whether file paths are allowed for read/write operations based on
/// the active mode, sensitive path deny-lists, symlink policy, and custom
/// deny paths.
#[derive(Debug)]
pub struct Sandbox {
    mode: SandboxMode,
    workspace: PathBuf,
    symlink_policy: SymlinkPolicy,
    additional_deny_paths: Vec<PathBuf>,
    home_dir: PathBuf,
}

impl Sandbox {
    /// Create a new Sandbox with the given mode and workspace path.
    pub fn new(mode: SandboxMode, workspace: impl Into<PathBuf>) -> Self {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs_home().unwrap_or_else(|| PathBuf::from("/root"))
            });

        Self {
            mode,
            workspace: workspace.into(),
            symlink_policy: SymlinkPolicy::default(),
            additional_deny_paths: Vec::new(),
            home_dir: home,
        }
    }

    /// Whether sandboxing is active (mode != Off).
    pub fn enabled(&self) -> bool {
        self.mode != SandboxMode::Off
    }

    /// Get the current sandbox mode.
    pub fn mode(&self) -> SandboxMode {
        self.mode
    }

    /// Get the workspace path.
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// Set the workspace path.
    pub fn set_workspace(&mut self, workspace: impl Into<PathBuf>) {
        self.workspace = workspace.into();
    }

    /// Set the sandbox mode.
    pub fn set_mode(&mut self, mode: SandboxMode) {
        self.mode = mode;
    }

    /// Set the symlink policy.
    pub fn set_symlink_policy(&mut self, policy: SymlinkPolicy) {
        self.symlink_policy = policy;
    }

    /// Add extra paths to the deny list.
    pub fn add_deny_paths(&mut self, paths: impl IntoIterator<Item = PathBuf>) {
        self.additional_deny_paths.extend(paths);
    }

    /// Override the home directory used for sensitive path resolution (useful for testing).
    pub fn set_home_dir(&mut self, home: impl Into<PathBuf>) {
        self.home_dir = home.into();
    }

    // ── Core path checking ──────────────────────────────────────────────

    /// Check if a file path is allowed for a given operation.
    ///
    /// Evaluation order:
    /// 1. Reject null bytes
    /// 2. If sandbox is off, allow
    /// 3. Check sensitive paths (always blocked, read or write)
    /// 4. Check additional custom deny paths
    /// 5. For writes, check system deny paths
    /// 6. Check workspace boundary (On/Permissive modes)
    pub fn check_path(&self, file_path: &str, operation: Operation) -> PathCheckResult {
        // Reject null bytes
        if file_path.contains('\0') {
            return PathCheckResult::deny("Sandbox: path contains null bytes");
        }

        if !self.enabled() {
            return PathCheckResult::allow();
        }

        let resolved = self.normalize_path(Path::new(file_path));
        let workspace_root = self.normalize_path(&self.workspace);

        // Check sensitive paths (both read and write)
        if let Some(reason) = self.check_sensitive_path(&resolved) {
            return PathCheckResult::deny(reason);
        }

        // Check additional deny paths
        for deny_path in &self.additional_deny_paths {
            let deny_abs = self.normalize_path(deny_path);
            if is_path_within(&resolved, &deny_abs) {
                return PathCheckResult::deny(format!(
                    "Sandbox: access to {} is blocked (custom deny rule)",
                    deny_path.display()
                ));
            }
        }

        let in_workspace = is_path_within(&resolved, &workspace_root);
        let in_tmp = is_path_within(&resolved, &self.normalize_path(Path::new("/tmp")));

        // For writes, check system paths
        if operation == Operation::Write {
            for sys_path_str in SYSTEM_DENY_WRITE {
                let sys_resolved = self.normalize_path(Path::new(sys_path_str));
                let workspace_nested = workspace_root != sys_resolved
                    && is_path_within(&workspace_root, &sys_resolved);

                if is_path_within(&resolved, &sys_resolved)
                    && !(in_workspace && workspace_nested)
                {
                    return PathCheckResult::deny(format!(
                        "Sandbox: writes to {} are blocked (system path)",
                        sys_path_str
                    ));
                }
            }
        }

        // Workspace boundary enforcement for On/Permissive modes
        let in_allowed_root = match operation {
            Operation::Read => in_workspace || in_tmp,
            Operation::Write => in_workspace,
        };

        if (self.mode == SandboxMode::On || self.mode == SandboxMode::Permissive)
            && !in_allowed_root
        {
            return PathCheckResult::deny(format!(
                "Sandbox: {}s outside the workspace or temp directory are blocked: {}",
                operation,
                resolved.display()
            ));
        }

        PathCheckResult::allow()
    }

    /// Check whether a path is allowed (convenience returning bool).
    pub fn is_path_allowed(&self, file_path: &str, operation: Operation) -> bool {
        self.check_path(file_path, operation).allowed
    }

    /// Normalize a path: resolve to absolute, resolve symlinks where possible,
    /// fall back to ancestor resolution for non-existent paths.
    pub fn normalize_path(&self, file_path: &Path) -> PathBuf {
        let absolute = if file_path.is_absolute() {
            file_path.to_path_buf()
        } else {
            self.workspace.join(file_path)
        };

        // Try real canonicalization first (follows symlinks)
        match std::fs::canonicalize(&absolute) {
            Ok(real) => real,
            Err(_) => resolve_via_ancestor(&absolute),
        }
    }

    /// Check whether the resolved path falls under a sensitive path.
    /// Returns Some(reason) if blocked, None if allowed.
    pub fn is_sensitive_path(&self, file_path: &Path) -> bool {
        let resolved = self.normalize_path(file_path);
        self.check_sensitive_path(&resolved).is_some()
    }

    /// Internal: check a pre-resolved path against the sensitive paths list.
    fn check_sensitive_path(&self, resolved: &Path) -> Option<String> {
        for sensitive_rel in SENSITIVE_PATHS {
            let sensitive_abs = self.normalize_path(&self.home_dir.join(sensitive_rel));
            if is_path_within(resolved, &sensitive_abs) {
                return Some(format!(
                    "Sandbox: access to {} is blocked (sensitive credentials path)",
                    sensitive_rel
                ));
            }
        }
        None
    }

    /// Check a path against the symlink policy.
    /// Returns Ok(resolved_path) on success, Err on blocked.
    pub fn check_symlink(&self, file_path: &Path) -> Result<PathBuf, SandboxError> {
        if !self.enabled() {
            return Ok(file_path.to_path_buf());
        }

        match self.symlink_policy {
            SymlinkPolicy::Allow => Ok(file_path.to_path_buf()),
            SymlinkPolicy::Block => {
                // Check if path is a symlink
                match std::fs::symlink_metadata(file_path) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        Err(SandboxError::PathBlocked {
                            reason: format!(
                                "symlinks are blocked by policy (path: {})",
                                file_path.display()
                            ),
                        })
                    }
                    Ok(_) => Ok(file_path.to_path_buf()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Non-existent path: allow (no symlink to block)
                        Ok(file_path.to_path_buf())
                    }
                    Err(e) => Err(SandboxError::Io(e)),
                }
            }
            SymlinkPolicy::Resolve => {
                let resolved = self.normalize_path(file_path);
                let workspace_root = self.normalize_path(&self.workspace);
                let tmp_root = self.normalize_path(Path::new("/tmp"));

                if !is_path_within(&resolved, &workspace_root)
                    && !is_path_within(&resolved, &tmp_root)
                {
                    // Check if it's actually a symlink (vs just an outside path)
                    let is_symlink = std::fs::symlink_metadata(file_path)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false);

                    if is_symlink {
                        return Err(SandboxError::PathBlocked {
                            reason: format!(
                                "symlink target {} is outside workspace (escape attempt)",
                                resolved.display()
                            ),
                        });
                    }
                }
                Ok(resolved)
            }
        }
    }
}

// ── Operation type ──────────────────────────────────────────────────────────

/// File operation type for path checking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Read,
    Write,
}

impl std::fmt::Display for Operation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read => write!(f, "read"),
            Self::Write => write!(f, "write"),
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Check if `target` is within `root` (proper path prefix check).
fn is_path_within(target: &Path, root: &Path) -> bool {
    target == root || target.starts_with(root)
}

/// Fallback home directory detection.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_sandbox(tmp: &TempDir) -> Sandbox {
        let ws = tmp.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        let mut sb = Sandbox::new(SandboxMode::On, &ws);
        sb.set_home_dir(tmp.path().join("fakehome"));
        fs::create_dir_all(tmp.path().join("fakehome")).unwrap();
        sb
    }

    // ── Mode basics ─────────────────────────────────────────────────────

    #[test]
    fn test_mode_off_allows_everything() {
        let tmp = TempDir::new().unwrap();
        let sb = Sandbox::new(SandboxMode::Off, tmp.path());
        assert!(!sb.enabled());
        assert!(sb.is_path_allowed("/etc/passwd", Operation::Read));
        assert!(sb.is_path_allowed("/etc/passwd", Operation::Write));
    }

    #[test]
    fn test_mode_on_blocks_outside_workspace() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        let outside = tmp.path().join("other/file.txt");
        assert!(!sb.is_path_allowed(outside.to_str().unwrap(), Operation::Read));
        assert!(!sb.is_path_allowed(outside.to_str().unwrap(), Operation::Write));
    }

    #[test]
    fn test_mode_on_allows_workspace_paths() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        let inside = sb.workspace().join("src/main.rs");
        fs::create_dir_all(sb.workspace().join("src")).unwrap();
        fs::write(&inside, "fn main() {}").unwrap();
        assert!(sb.is_path_allowed(inside.to_str().unwrap(), Operation::Read));
        assert!(sb.is_path_allowed(inside.to_str().unwrap(), Operation::Write));
    }

    #[test]
    fn test_read_allowed_in_tmp() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        // /tmp is always allowed for reads
        assert!(sb.is_path_allowed("/tmp/somefile.txt", Operation::Read));
    }

    #[test]
    fn test_write_blocked_in_tmp() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        // /tmp is NOT allowed for writes in On mode
        assert!(!sb.is_path_allowed("/tmp/somefile.txt", Operation::Write));
    }

    // ── Sensitive paths ─────────────────────────────────────────────────

    #[test]
    fn test_sensitive_ssh_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        sb.set_home_dir(&home);

        let ssh_key = home.join(".ssh/id_rsa");
        assert!(!sb.is_path_allowed(ssh_key.to_str().unwrap(), Operation::Read));
        assert!(!sb.is_path_allowed(ssh_key.to_str().unwrap(), Operation::Write));
    }

    #[test]
    fn test_sensitive_aws_credentials_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(home.join(".aws")).unwrap();
        fs::write(home.join(".aws/credentials"), "secret").unwrap();
        sb.set_home_dir(&home);

        let creds = home.join(".aws/credentials");
        assert!(!sb.is_path_allowed(creds.to_str().unwrap(), Operation::Read));
    }

    #[test]
    fn test_sensitive_gitconfig_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".gitconfig"), "[user]").unwrap();
        sb.set_home_dir(&home);

        let gitconfig = home.join(".gitconfig");
        assert!(!sb.is_path_allowed(gitconfig.to_str().unwrap(), Operation::Read));
    }

    #[test]
    fn test_sensitive_env_file_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".env"), "SECRET=x").unwrap();
        sb.set_home_dir(&home);

        assert!(!sb.is_path_allowed(
            home.join(".env").to_str().unwrap(),
            Operation::Read
        ));
        assert!(!sb.is_path_allowed(
            home.join(".env.local").to_str().unwrap(),
            Operation::Read
        ));
    }

    #[test]
    fn test_sensitive_shell_history_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".bash_history"), "secret commands").unwrap();
        sb.set_home_dir(&home);

        let hist = home.join(".bash_history");
        assert!(!sb.is_path_allowed(hist.to_str().unwrap(), Operation::Read));
    }

    #[test]
    fn test_sensitive_kube_config_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(home.join(".kube")).unwrap();
        fs::write(home.join(".kube/config"), "").unwrap();
        sb.set_home_dir(&home);

        assert!(!sb.is_path_allowed(
            home.join(".kube/config").to_str().unwrap(),
            Operation::Read
        ));
    }

    #[test]
    fn test_sensitive_shell_rc_blocked() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(&home).unwrap();
        sb.set_home_dir(&home);

        for rc in &[".bashrc", ".zshrc", ".profile", ".bash_profile"] {
            assert!(
                !sb.is_path_allowed(home.join(rc).to_str().unwrap(), Operation::Write),
                "{} should be blocked for write",
                rc
            );
        }
    }

    #[test]
    fn test_is_sensitive_path_method() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let home = tmp.path().join("fakehome");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        sb.set_home_dir(&home);

        assert!(sb.is_sensitive_path(&home.join(".ssh/id_rsa")));
        assert!(!sb.is_sensitive_path(sb.workspace().join("src/lib.rs").as_path()));
    }

    // ── System path write protection ────────────────────────────────────

    #[test]
    fn test_system_write_denied() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        assert!(!sb.is_path_allowed("/etc/passwd", Operation::Write));
        assert!(!sb.is_path_allowed("/usr/bin/ls", Operation::Write));
        assert!(!sb.is_path_allowed("/bin/sh", Operation::Write));
    }

    // ── Null bytes ──────────────────────────────────────────────────────

    #[test]
    fn test_null_byte_rejected() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        assert!(!sb.is_path_allowed("/tmp/test\0evil", Operation::Read));
    }

    // ── Path traversal ──────────────────────────────────────────────────

    #[test]
    fn test_path_traversal_blocked() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        let traversal = sb.workspace().join("../../etc/passwd");
        assert!(!sb.is_path_allowed(traversal.to_str().unwrap(), Operation::Read));
    }

    // ── Normalize path ──────────────────────────────────────────────────

    #[test]
    fn test_normalize_path_relative() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        let normalized = sb.normalize_path(Path::new("src/main.rs"));
        assert!(normalized.is_absolute());
        // Should be rooted under workspace
        assert!(normalized.starts_with(sb.workspace()));
    }

    #[test]
    fn test_normalize_path_absolute() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        let abs = sb.workspace().join("test.txt");
        fs::write(&abs, "hello").unwrap();
        let normalized = sb.normalize_path(&abs);
        assert!(normalized.is_absolute());
    }

    // ── Custom deny paths ───────────────────────────────────────────────

    #[test]
    fn test_additional_deny_paths() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        let secret_dir = sb.workspace().join("secrets");
        fs::create_dir_all(&secret_dir).unwrap();
        sb.add_deny_paths(vec![secret_dir.clone()]);

        let secret_file = secret_dir.join("api_key.txt");
        assert!(!sb.is_path_allowed(secret_file.to_str().unwrap(), Operation::Read));
    }

    // ── Symlink handling ────────────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn test_symlink_resolve_escape_blocked() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);

        let outside = tmp.path().join("outside_target");
        fs::create_dir_all(&outside).unwrap();

        let link = sb.workspace().join("evil-link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let result = sb.check_symlink(&link);
        assert!(result.is_err(), "symlink escaping workspace should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_block_policy() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        sb.set_symlink_policy(SymlinkPolicy::Block);

        let target = sb.workspace().join("real_file.txt");
        fs::write(&target, "content").unwrap();
        let link = sb.workspace().join("link_to_file");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = sb.check_symlink(&link);
        assert!(result.is_err(), "all symlinks should be blocked in Block policy");
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_allow_policy() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        sb.set_symlink_policy(SymlinkPolicy::Allow);

        let outside = tmp.path().join("outside_target");
        fs::create_dir_all(&outside).unwrap();
        let link = sb.workspace().join("link_outside");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let result = sb.check_symlink(&link);
        assert!(result.is_ok(), "Allow policy should permit all symlinks");
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_resolve_within_workspace_ok() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);

        let target = sb.workspace().join("real_dir");
        fs::create_dir_all(&target).unwrap();
        let link = sb.workspace().join("safe-link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = sb.check_symlink(&link);
        assert!(result.is_ok(), "symlink within workspace should be allowed");
    }

    // ── Mode transitions ────────────────────────────────────────────────

    #[test]
    fn test_set_mode() {
        let tmp = TempDir::new().unwrap();
        let mut sb = make_sandbox(&tmp);
        assert_eq!(sb.mode(), SandboxMode::On);

        sb.set_mode(SandboxMode::Off);
        assert_eq!(sb.mode(), SandboxMode::Off);
        assert!(!sb.enabled());

        sb.set_mode(SandboxMode::Permissive);
        assert_eq!(sb.mode(), SandboxMode::Permissive);
        assert!(sb.enabled());
    }

    #[test]
    fn test_mode_display() {
        assert_eq!(SandboxMode::Off.to_string(), "off");
        assert_eq!(SandboxMode::On.to_string(), "on");
        assert_eq!(SandboxMode::Permissive.to_string(), "permissive");
    }

    #[test]
    fn test_mode_from_str() {
        assert_eq!(SandboxMode::from_str_loose("off").unwrap(), SandboxMode::Off);
        assert_eq!(SandboxMode::from_str_loose("on").unwrap(), SandboxMode::On);
        assert_eq!(
            SandboxMode::from_str_loose("permissive").unwrap(),
            SandboxMode::Permissive
        );
        assert!(SandboxMode::from_str_loose("invalid").is_err());
    }

    // ── Workspace boundary ──────────────────────────────────────────────

    #[test]
    fn test_workspace_itself_is_allowed() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        assert!(sb.is_path_allowed(sb.workspace().to_str().unwrap(), Operation::Read));
        assert!(sb.is_path_allowed(sb.workspace().to_str().unwrap(), Operation::Write));
    }

    #[test]
    fn test_deeply_nested_workspace_path() {
        let tmp = TempDir::new().unwrap();
        let sb = make_sandbox(&tmp);
        let deep = sb.workspace().join("a/b/c/d/e/f/g/file.txt");
        assert!(sb.is_path_allowed(deep.to_str().unwrap(), Operation::Write));
    }
}
