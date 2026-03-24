// Mercury Code - Rollback / Undo System
// Tracks checkpoints at each user message and enables time-travel rollback.
// Ported from: src/rollback.js

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

use crate::utils::debug_log;

/// Maximum number of checkpoints to retain.
const MAX_CHECKPOINTS: usize = 10;

/// A checkpoint snapshot at a specific point in the conversation.
#[derive(Debug, Clone)]
pub struct Checkpoint {
    /// Unique checkpoint ID.
    pub id: String,
    /// Sequential checkpoint index.
    pub index: usize,
    /// Timestamp (milliseconds since epoch).
    pub timestamp: i64,
    /// The user's message text (truncated for display).
    pub user_message: String,
    /// Number of messages at this point (slice boundary).
    pub message_count: usize,
    /// Git commit hash for file state (if available).
    pub git_hash: Option<String>,
    /// Hash of last message for integrity verification.
    pub message_fingerprint: Option<String>,
}

/// Result of a rollback operation.
#[derive(Debug)]
pub struct RollbackResult {
    /// The restored message count (slice boundary for the live array).
    pub message_count: Option<usize>,
    /// Whether the rollback succeeded.
    pub restored: bool,
    /// Whether git file state was restored.
    pub file_restored: bool,
}

/// RollbackManager tracks conversation checkpoints and enables undo.
pub struct RollbackManager {
    cwd: PathBuf,
    pub checkpoints: Vec<Checkpoint>,
    use_git: bool,
}

impl RollbackManager {
    pub fn new(cwd: &Path) -> Self {
        let use_git = detect_git(cwd);
        Self {
            cwd: cwd.to_path_buf(),
            checkpoints: Vec::new(),
            use_git,
        }
    }

    /// Create a checkpoint at the current state.
    /// Called before each user message is processed.
    pub fn create_checkpoint(
        &mut self,
        user_message: &str,
        message_count: usize,
        last_message: Option<&serde_json::Value>,
    ) -> &Checkpoint {
        // Enforce maximum checkpoint count -- evict the oldest
        if self.checkpoints.len() >= MAX_CHECKPOINTS {
            self.checkpoints.remove(0);
            // Re-index remaining checkpoints
            for (i, cp) in self.checkpoints.iter_mut().enumerate() {
                cp.index = i;
            }
        }

        let cp = Checkpoint {
            id: Uuid::new_v4().to_string(),
            index: self.checkpoints.len(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            user_message: user_message.chars().take(120).collect(),
            message_count,
            git_hash: self.get_git_hash(),
            message_fingerprint: fingerprint_message(last_message),
        };
        self.checkpoints.push(cp);
        self.checkpoints.last().unwrap()
    }

    /// Get list of all checkpoints for display.
    pub fn get_checkpoints(&self) -> Vec<CheckpointInfo> {
        self.checkpoints
            .iter()
            .map(|cp| CheckpointInfo {
                index: cp.index,
                timestamp: cp.timestamp,
                date: chrono::DateTime::from_timestamp_millis(cp.timestamp)
                    .map(|dt| dt.format("%H:%M:%S").to_string())
                    .unwrap_or_default(),
                user_message: cp.user_message.clone(),
            })
            .collect()
    }

    /// Perform a full rollback: restore both files AND conversation.
    pub fn full_rollback(
        &mut self,
        checkpoint_index: usize,
        _live_message_count: usize,
        messages: &[serde_json::Value],
    ) -> RollbackResult {
        let cp = match self.checkpoints.get(checkpoint_index) {
            Some(cp) => cp.clone(),
            None => return RollbackResult { message_count: None, restored: false, file_restored: false },
        };

        let mut file_restored = false;

        // Attempt to restore git state
        if self.use_git {
            if let Some(ref git_hash) = cp.git_hash {
                if mercury_safety::is_valid_git_hash(git_hash) {
                    // Stash current changes first (safety net)
                    let _ = Command::new("git")
                        .args(["stash", "push", "-m", "mercury-rollback-backup", "--include-untracked"])
                        .current_dir(&self.cwd)
                        .output();

                    // Restore files to the checkpoint's commit state
                    match Command::new("git")
                        .args(["checkout", git_hash, "--", "."])
                        .current_dir(&self.cwd)
                        .output()
                    {
                        Ok(output) if output.status.success() => {
                            file_restored = true;
                        }
                        Ok(output) => {
                            debug_log(
                                "RollbackManager.full_rollback.checkout",
                                &String::from_utf8_lossy(&output.stderr),
                            );
                        }
                        Err(e) => {
                            debug_log("RollbackManager.full_rollback.checkout", &e);
                        }
                    }
                }
            }
        }

        // Remove checkpoints after this one
        self.checkpoints.truncate(checkpoint_index + 1);

        // Find the correct rollback position
        let rollback_pos = self.find_rollback_position(&cp, messages);

        RollbackResult {
            message_count: Some(rollback_pos),
            restored: true,
            file_restored,
        }
    }

    /// Context-only rollback: restore conversation but keep files as-is.
    pub fn context_rollback(
        &mut self,
        checkpoint_index: usize,
        messages: &[serde_json::Value],
    ) -> RollbackResult {
        let cp = match self.checkpoints.get(checkpoint_index) {
            Some(cp) => cp.clone(),
            None => return RollbackResult { message_count: None, restored: false, file_restored: false },
        };

        // Remove checkpoints after this one
        self.checkpoints.truncate(checkpoint_index + 1);

        let rollback_pos = self.find_rollback_position(&cp, messages);

        RollbackResult {
            message_count: Some(rollback_pos),
            restored: true,
            file_restored: false,
        }
    }

    /// Get current git HEAD hash (if in a git repo).
    fn get_git_hash(&self) -> Option<String> {
        if !self.use_git {
            return None;
        }
        match Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&self.cwd)
            .output()
        {
            Ok(output) if output.status.success() => {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            }
            _ => None,
        }
    }

    /// Find the correct rollback position using fingerprint verification.
    fn find_rollback_position(
        &self,
        cp: &Checkpoint,
        messages: &[serde_json::Value],
    ) -> usize {
        let count = cp.message_count;
        let fp = match &cp.message_fingerprint {
            Some(fp) => fp,
            None => return count.min(messages.len()),
        };

        // Verify the message at position messageCount - 1 matches the fingerprint
        if count > 0 && count <= messages.len() {
            if let Some(candidate_fp) = fingerprint_message(Some(&messages[count - 1])) {
                if &candidate_fp == fp {
                    return count;
                }
            }
        }

        // Fingerprint mismatch -- scan nearby positions
        let max_scan = 20.min(messages.len());
        for offset in 1..=max_scan {
            // Check position before
            if count > offset {
                let before = count - 1 - offset;
                if before < messages.len() {
                    if let Some(ref candidate_fp) = fingerprint_message(Some(&messages[before])) {
                        if candidate_fp == fp {
                            return before + 1;
                        }
                    }
                }
            }
            // Check position after
            let after = count - 1 + offset;
            if after < messages.len() {
                if let Some(ref candidate_fp) = fingerprint_message(Some(&messages[after])) {
                    if candidate_fp == fp {
                        return after + 1;
                    }
                }
            }
        }

        // Could not find matching fingerprint -- fall back to messageCount
        count.min(messages.len())
    }

    /// Total number of checkpoints.
    pub fn count(&self) -> usize {
        self.checkpoints.len()
    }
}

/// Checkpoint info for display purposes.
#[derive(Debug, Clone)]
pub struct CheckpointInfo {
    pub index: usize,
    pub timestamp: i64,
    pub date: String,
    pub user_message: String,
}

/// Detect if we're in a git repository.
fn detect_git(cwd: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Compute a fingerprint of a message for integrity verification.
fn fingerprint_message(message: Option<&serde_json::Value>) -> Option<String> {
    let msg = message?;
    let role = msg.get("role")?.as_str()?;
    let content = msg
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let truncated: String = content.chars().take(200).collect();

    let data = serde_json::json!({
        "role": role,
        "content": truncated,
    });
    let serialized = serde_json::to_string(&data).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let hash = hasher.finalize();
    Some(hex::encode(&hash[..8]))
}

/// Hex encoding helper (inline, avoids adding hex crate dependency).
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_fingerprint_message() {
        let msg = json!({"role": "user", "content": "hello world"});
        let fp = fingerprint_message(Some(&msg));
        assert!(fp.is_some());
        assert_eq!(fp.as_ref().unwrap().len(), 16); // 8 bytes = 16 hex chars
    }

    #[test]
    fn test_fingerprint_consistency() {
        let msg = json!({"role": "user", "content": "hello world"});
        let fp1 = fingerprint_message(Some(&msg));
        let fp2 = fingerprint_message(Some(&msg));
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn test_fingerprint_none() {
        assert!(fingerprint_message(None).is_none());
    }

    #[test]
    fn test_rollback_manager_new() {
        let tmp = tempfile::TempDir::new().unwrap();
        let rm = RollbackManager::new(tmp.path());
        assert_eq!(rm.count(), 0);
    }

    #[test]
    fn test_create_checkpoint() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut rm = RollbackManager::new(tmp.path());
        rm.create_checkpoint("test message", 5, None);
        assert_eq!(rm.count(), 1);
        assert_eq!(rm.checkpoints[0].message_count, 5);
    }

    #[test]
    fn test_max_checkpoints() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut rm = RollbackManager::new(tmp.path());
        for i in 0..15 {
            rm.create_checkpoint(&format!("msg {}", i), i, None);
        }
        assert_eq!(rm.count(), MAX_CHECKPOINTS);
    }
}
