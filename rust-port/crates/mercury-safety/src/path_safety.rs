// Mercury Code - Shared Path Safety Utilities
// Unified workspace boundary checks, symlink-safe resolution, and git ref validation.
// Ported from: src/utils/path-safety.js

use std::path::{Path, PathBuf};

/// Normalize a path for comparison: resolve to absolute, normalize separators.
/// On Windows, lowercases the path for case-insensitive comparison.
fn norm_for_compare(p: &Path) -> PathBuf {
    let resolved = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(p)
    };
    // Normalize the path by resolving . and .. components lexically
    let normalized = lexical_normalize(&resolved);
    if cfg!(windows) {
        PathBuf::from(normalized.to_string_lossy().to_lowercase())
    } else {
        normalized
    }
}

/// Lexically normalize a path (resolve `.` and `..` without filesystem access).
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in p.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if let Some(last) = components.last() {
                    let is_root = matches!(last, std::path::Component::RootDir)
                        || matches!(last, std::path::Component::Prefix(_));
                    if !is_root {
                        components.pop();
                        continue;
                    }
                }
                // Keep ParentDir if we can't go up further
            }
            _ => {}
        }
        components.push(component);
    }
    if components.is_empty() {
        PathBuf::from(".")
    } else {
        components.iter().collect()
    }
}

/// Unified workspace boundary check (symlink-safe).
/// Uses `std::fs::canonicalize` to resolve symlinks before comparison.
/// Falls back to lexical normalization if canonicalization fails.
///
/// # Arguments
/// * `file_path` - Path to check
/// * `workspace` - Workspace root directory
///
/// # Returns
/// `true` if `file_path` is within `workspace`
pub fn is_in_workspace(file_path: &Path, workspace: &Path) -> bool {
    // Try to canonicalize both paths (resolves symlinks)
    let resolved_workspace = match std::fs::canonicalize(workspace) {
        Ok(p) => norm_for_compare(&p),
        Err(_) => {
            // Workspace doesn't exist - fall back to lexical normalization
            let resolved_path = norm_for_compare(file_path);
            let resolved_ws = norm_for_compare(workspace);
            return is_path_within(&resolved_path, &resolved_ws);
        }
    };

    let resolved_path = match std::fs::canonicalize(file_path) {
        Ok(p) => norm_for_compare(&p),
        Err(_) => {
            // File doesn't exist yet - resolve via ancestor
            norm_for_compare(&resolve_via_ancestor(file_path))
        }
    };

    is_path_within(&resolved_path, &resolved_workspace)
}

/// Check if `target` is within `root` (path prefix check).
fn is_path_within(target: &Path, root: &Path) -> bool {
    if target == root {
        return true;
    }
    // Use starts_with which properly handles path components
    target.starts_with(root)
}

/// Resolve a non-existent path by finding the nearest existing ancestor,
/// resolving it through `canonicalize` (following symlinks), then appending
/// the remaining path segments.
///
/// This prevents symlink escape attacks where a symlink inside the workspace
/// points outside it.
///
/// Example: `/workspace/evil-link/file.txt` where `evil-link -> /etc`
///   -> ancestor = `/workspace/evil-link`, realpath = `/etc`
///   -> result = `/etc/file.txt` (correctly detected as outside workspace)
pub fn resolve_via_ancestor(target_path: &Path) -> PathBuf {
    let absolute = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(target_path)
    };

    let mut current = absolute.clone();
    let mut trailing: Vec<std::ffi::OsString> = Vec::new();
    let mut visited = std::collections::HashSet::new();
    const MAX_DEPTH: usize = 40;

    loop {
        if trailing.len() >= MAX_DEPTH {
            return absolute;
        }

        let parent = match current.parent() {
            Some(p) if p != current => p.to_path_buf(),
            _ => return absolute, // Reached root
        };

        // Circular symlink detection
        if !visited.insert(current.clone()) {
            return absolute;
        }

        match std::fs::canonicalize(&current) {
            Ok(real) => {
                if trailing.is_empty() {
                    return real;
                }
                let mut resolved = real;
                for component in trailing.into_iter().rev() {
                    resolved.push(component);
                }
                return resolved;
            }
            Err(_) => {
                if let Some(file_name) = current.file_name() {
                    trailing.push(file_name.to_os_string());
                }
                current = parent;
            }
        }
    }
}

/// Validate a git ref (loose version for branch names and common refs).
/// Allows hex hashes (7-40 chars), branch-like names (with `/` and `-`),
/// and common refs like HEAD, refs/heads/main, etc.
pub fn is_valid_git_ref(git_ref: &str) -> bool {
    if git_ref.is_empty() {
        return false;
    }

    // Pure hex hash (7-40 chars)
    if git_ref.len() >= 7
        && git_ref.len() <= 40
        && git_ref.chars().all(|c| c.is_ascii_hexdigit())
    {
        return true;
    }

    // Special refs
    if matches!(
        git_ref,
        "HEAD" | "FETCH_HEAD" | "ORIG_HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD"
    ) {
        return true;
    }

    // Branch-like names: alphanumeric, hyphens, slashes, dots, underscores
    // Must not start/end with . or contain .. or end with .lock
    if git_ref.len() >= 4
        && git_ref
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
        && git_ref
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && git_ref
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && !git_ref.contains("..")
        && !git_ref.ends_with(".lock")
    {
        return true;
    }

    false
}

/// Validate a git hash (strict version - only pure SHA hex).
/// Only allows hexadecimal strings of 7-40 characters.
pub fn is_valid_git_hash(git_ref: &str) -> bool {
    if git_ref.is_empty() {
        return false;
    }
    git_ref.len() >= 7
        && git_ref.len() <= 40
        && git_ref.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_is_in_workspace_basic() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        let file = ws.join("src/main.rs");
        fs::create_dir_all(ws.join("src")).unwrap();
        fs::write(&file, "fn main() {}").unwrap();

        assert!(is_in_workspace(&file, ws));
        assert!(is_in_workspace(ws, ws));
    }

    #[test]
    fn test_is_in_workspace_outside() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().join("project");
        fs::create_dir_all(&ws).unwrap();

        let outside = tmp.path().join("other/file.txt");
        assert!(!is_in_workspace(&outside, &ws));
    }

    #[test]
    fn test_is_in_workspace_traversal() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().join("project");
        fs::create_dir_all(&ws).unwrap();

        // Attempt path traversal
        let traversal = ws.join("../other/file.txt");
        assert!(!is_in_workspace(&traversal, &ws));
    }

    #[test]
    fn test_resolve_via_ancestor_existing() {
        let tmp = TempDir::new().unwrap();
        let existing = tmp.path().join("exists");
        fs::create_dir_all(&existing).unwrap();

        let non_existing = existing.join("new_file.txt");
        let resolved = resolve_via_ancestor(&non_existing);
        assert!(resolved.starts_with(std::fs::canonicalize(&existing).unwrap()));
    }

    #[test]
    fn test_is_valid_git_ref() {
        // Valid hex hashes
        assert!(is_valid_git_ref("abc1234"));
        assert!(is_valid_git_ref("abc1234567890abcdef1234567890abcdef12345"));

        // Special refs
        assert!(is_valid_git_ref("HEAD"));
        assert!(is_valid_git_ref("FETCH_HEAD"));

        // Branch names
        assert!(is_valid_git_ref("main"));
        assert!(is_valid_git_ref("feature/my-branch"));
        assert!(is_valid_git_ref("refs/heads/main"));

        // Invalid
        assert!(!is_valid_git_ref(""));
        assert!(!is_valid_git_ref("abc")); // too short for hash, too short for branch
        assert!(!is_valid_git_ref("..bad"));
        assert!(!is_valid_git_ref("branch.lock"));
    }

    #[test]
    fn test_is_valid_git_hash() {
        assert!(is_valid_git_hash("abc1234"));
        assert!(is_valid_git_hash("abc1234567890abcdef1234567890abcdef12345"));
        assert!(!is_valid_git_hash("abc123")); // too short
        assert!(!is_valid_git_hash("main")); // not hex
        assert!(!is_valid_git_hash("")); // empty
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_escape_detection() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();

        let target_dir = tmp.path().join("outside");
        fs::create_dir_all(&target_dir).unwrap();

        // Create symlink inside workspace pointing outside
        let link = ws.join("evil-link");
        std::os::unix::fs::symlink(&target_dir, &link).unwrap();

        let file_via_link = link.join("secret.txt");
        // resolve_via_ancestor should resolve through symlink
        let resolved = resolve_via_ancestor(&file_via_link);
        // The resolved path should be under target_dir, not workspace
        assert!(!is_in_workspace(&resolved, &ws));
    }
}
