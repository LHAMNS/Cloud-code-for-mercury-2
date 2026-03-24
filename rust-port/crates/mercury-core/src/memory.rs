// Mercury Code - Persistent Memory Manager
// Manages .mercury/memory.md for long-term knowledge retention across compressions.
// Rust port of src/memory.js

use std::path::{Path, PathBuf};

use chrono::Utc;
use tokio::fs;
use tokio::sync::Mutex;
use tracing::debug;
use uuid::Uuid;

const MEMORY_DIR: &str = ".mercury";
const MEMORY_FILE: &str = "memory.md";
const MAX_MEMORY_SIZE: usize = 80_000; // ~22K tokens max for memory file

const SECTION_SEPARATOR: &str = "\n\n---\n\n";

/// File-based persistent memory manager.
///
/// Stores long-term knowledge in `.mercury/memory.md` with atomic writes
/// (write to temp file, then rename) to prevent corruption on crash.
pub struct MemoryManager {
    dir: PathBuf,
    file_path: PathBuf,
    /// Serializes write operations so concurrent appends don't race.
    write_lock: Mutex<()>,
}

impl MemoryManager {
    /// Create a new MemoryManager.
    ///
    /// * `cwd` - Working directory
    /// * `dir` - If `Some`, use this as the direct directory path (skips appending `.mercury`)
    pub fn new(cwd: &Path, dir: Option<&Path>) -> Self {
        let dir = match dir {
            Some(d) => d.to_path_buf(),
            None => cwd.join(MEMORY_DIR),
        };
        let file_path = dir.join(MEMORY_FILE);
        Self {
            dir,
            file_path,
            write_lock: Mutex::new(()),
        }
    }

    /// Read the current memory file content. Returns empty string if the file does not exist.
    pub async fn read(&self) -> String {
        match fs::read_to_string(&self.file_path).await {
            Ok(content) => content,
            Err(e) => {
                debug!("MemoryManager.read: {}", e);
                String::new()
            }
        }
    }

    /// Append new facts to the memory file.
    ///
    /// Deduplicates by skipping content that is already present verbatim.
    /// Trims the oldest section when the file would exceed `MAX_MEMORY_SIZE`.
    pub async fn append(&self, new_content: &str) -> std::io::Result<()> {
        let trimmed = new_content.trim();
        if trimmed.is_empty() {
            return Ok(());
        }

        let _guard = self.write_lock.lock().await;
        fs::create_dir_all(&self.dir).await?;

        let mut existing = self.read().await;

        // Deduplicate
        if existing.contains(trimmed) {
            return Ok(());
        }

        // Trim oldest if we'd exceed budget
        if existing.len() + trimmed.len() > MAX_MEMORY_SIZE {
            existing = Self::trim_oldest(&existing, trimmed.len());
        }

        let separator = if existing.is_empty() { "" } else { SECTION_SEPARATOR };
        let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let block = format!("<!-- {} -->\n{}", timestamp, trimmed);
        let full = format!("{}{}{}", existing, separator, block);

        self.atomic_write(&self.file_path, &full).await
    }

    /// Replace the entire memory file with new content.
    pub async fn write(&self, content: &str) -> std::io::Result<()> {
        let _guard = self.write_lock.lock().await;
        fs::create_dir_all(&self.dir).await?;
        self.atomic_write(&self.file_path, content).await
    }

    /// Write to a temp file then atomically rename -- prevents corruption on crash / disk-full.
    async fn atomic_write(&self, file_path: &Path, content: &str) -> std::io::Result<()> {
        let hex = Uuid::new_v4().simple().to_string();
        let tmp_name = format!(
            "{}.tmp.{}",
            file_path.file_name().unwrap_or_default().to_string_lossy(),
            &hex[..8]
        );
        let tmp_path = file_path.with_file_name(tmp_name);
        match fs::write(&tmp_path, content).await {
            Ok(()) => fs::rename(&tmp_path, file_path).await,
            Err(e) => {
                // Best-effort cleanup
                let _ = fs::remove_file(&tmp_path).await;
                Err(e)
            }
        }
    }

    /// Trim the oldest entries to make room for `need_space` bytes of new content.
    fn trim_oldest(existing: &str, need_space: usize) -> String {
        let mut sections: Vec<&str> = existing.split(SECTION_SEPARATOR).collect();
        while sections.len() > 1 {
            let current_len: usize = sections
                .iter()
                .map(|s| s.len())
                .sum::<usize>()
                + SECTION_SEPARATOR.len() * sections.len().saturating_sub(1);
            if current_len + need_space <= MAX_MEMORY_SIZE {
                break;
            }
            sections.remove(0);
        }
        sections.join(SECTION_SEPARATOR)
    }
}

// ── Conversation Log ──────────────────────────────────────────────────────────

/// Trust mode controls whether the conversation log is enabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustMode {
    Full,
    Readonly,
    Plan,
}

/// Conversation log -- saves full raw conversation to `.mercury/conversation.jsonl`.
///
/// The model can Read this file to recover exact details from earlier turns.
/// In `Readonly` or `Plan` trust modes, logging is silently disabled to avoid
/// dirtying the repository.
pub struct ConversationLog {
    dir: PathBuf,
    file_path: PathBuf,
    log_enabled: bool,
    write_lock: Mutex<()>,
}

impl ConversationLog {
    /// Create a new ConversationLog.
    ///
    /// * `cwd` - Working directory
    /// * `dir` - If `Some`, use this as the direct directory path (skips appending `.mercury`)
    /// * `trust_mode` - Controls whether logging is enabled
    pub fn new(cwd: &Path, dir: Option<&Path>, trust_mode: TrustMode) -> Self {
        let dir = match dir {
            Some(d) => d.to_path_buf(),
            None => cwd.join(MEMORY_DIR),
        };
        let file_path = dir.join("conversation.jsonl");
        let log_enabled = trust_mode != TrustMode::Readonly && trust_mode != TrustMode::Plan;
        Self {
            dir,
            file_path,
            log_enabled,
            write_lock: Mutex::new(()),
        }
    }

    /// Append a message to the log file. Each line is a JSON object with a `ts` timestamp.
    ///
    /// In readonly/plan mode, logging is silently skipped.
    pub async fn append(&self, message: &serde_json::Value) -> std::io::Result<()> {
        if !self.log_enabled {
            return Ok(());
        }

        let _guard = self.write_lock.lock().await;
        fs::create_dir_all(&self.dir).await?;

        let ts = Utc::now().timestamp_millis();
        let mut entry = message.clone();
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("ts".to_string(), serde_json::json!(ts));
        }
        let line = format!("{}\n", serde_json::to_string(&entry).unwrap_or_default());

        match fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .await
        {
            Ok(mut file) => {
                use tokio::io::AsyncWriteExt;
                if let Err(e) = file.write_all(line.as_bytes()).await {
                    debug!("ConversationLog.append: {}", e);
                }
                Ok(())
            }
            Err(e) => {
                debug!("ConversationLog.append: {}", e);
                Ok(())
            }
        }
    }

    /// Clear the log (e.g. on /clear). Uses atomic write.
    pub async fn clear(&self) -> std::io::Result<()> {
        let _guard = self.write_lock.lock().await;
        let hex = Uuid::new_v4().simple().to_string();
        let tmp_name = format!(
            "{}.tmp.{}",
            self.file_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            &hex[..8]
        );
        let tmp_path = self.file_path.with_file_name(tmp_name);
        match fs::write(&tmp_path, "").await {
            Ok(()) => fs::rename(&tmp_path, &self.file_path).await,
            Err(e) => {
                debug!("ConversationLog.clear: {}", e);
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_memory_read_empty() {
        let tmp = TempDir::new().unwrap();
        let mgr = MemoryManager::new(tmp.path(), None);
        let content = mgr.read().await;
        assert!(content.is_empty());
    }

    #[tokio::test]
    async fn test_memory_write_and_read() {
        let tmp = TempDir::new().unwrap();
        let mgr = MemoryManager::new(tmp.path(), None);
        mgr.write("hello world").await.unwrap();
        let content = mgr.read().await;
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn test_memory_append() {
        let tmp = TempDir::new().unwrap();
        let mgr = MemoryManager::new(tmp.path(), None);
        mgr.append("fact one").await.unwrap();
        mgr.append("fact two").await.unwrap();
        let content = mgr.read().await;
        assert!(content.contains("fact one"));
        assert!(content.contains("fact two"));
        assert!(content.contains("---"));
    }

    #[tokio::test]
    async fn test_memory_append_dedup() {
        let tmp = TempDir::new().unwrap();
        let mgr = MemoryManager::new(tmp.path(), None);
        mgr.append("same fact").await.unwrap();
        mgr.append("same fact").await.unwrap();
        let content = mgr.read().await;
        // Should only appear once (the timestamped block)
        let count = content.matches("same fact").count();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn test_memory_append_empty_skipped() {
        let tmp = TempDir::new().unwrap();
        let mgr = MemoryManager::new(tmp.path(), None);
        mgr.append("").await.unwrap();
        mgr.append("   ").await.unwrap();
        let content = mgr.read().await;
        assert!(content.is_empty());
    }

    #[tokio::test]
    async fn test_memory_trim_oldest() {
        // Create content that would exceed MAX_MEMORY_SIZE
        let existing = "A".repeat(MAX_MEMORY_SIZE - 100);
        let trimmed = MemoryManager::trim_oldest(&existing, 200);
        // With a single section (no separator), trim_oldest keeps it
        assert!(!trimmed.is_empty());

        // With multiple sections
        let sec1 = "A".repeat(40_000);
        let sec2 = "B".repeat(40_000);
        let multi = format!("{}{}{}", sec1, SECTION_SEPARATOR, sec2);
        let trimmed = MemoryManager::trim_oldest(&multi, 10_000);
        // First section should have been removed
        assert!(!trimmed.contains(&sec1));
        assert!(trimmed.contains(&sec2));
    }

    #[tokio::test]
    async fn test_memory_atomic_write() {
        let tmp = TempDir::new().unwrap();
        let mgr = MemoryManager::new(tmp.path(), None);
        mgr.write("initial").await.unwrap();
        mgr.write("replaced").await.unwrap();
        let content = mgr.read().await;
        assert_eq!(content, "replaced");
    }

    #[tokio::test]
    async fn test_memory_custom_dir() {
        let tmp = TempDir::new().unwrap();
        let custom = tmp.path().join("custom_mem");
        let mgr = MemoryManager::new(tmp.path(), Some(&custom));
        mgr.append("custom dir fact").await.unwrap();
        let content = mgr.read().await;
        assert!(content.contains("custom dir fact"));
    }

    #[tokio::test]
    async fn test_conversation_log_append_and_clear() {
        let tmp = TempDir::new().unwrap();
        let log = ConversationLog::new(tmp.path(), None, TrustMode::Full);
        let msg = serde_json::json!({"role": "user", "content": "hello"});
        log.append(&msg).await.unwrap();

        let content = fs::read_to_string(tmp.path().join(MEMORY_DIR).join("conversation.jsonl"))
            .await
            .unwrap();
        assert!(content.contains("hello"));
        assert!(content.contains("\"ts\""));

        log.clear().await.unwrap();
        let content = fs::read_to_string(tmp.path().join(MEMORY_DIR).join("conversation.jsonl"))
            .await
            .unwrap();
        assert!(content.is_empty());
    }

    #[tokio::test]
    async fn test_conversation_log_disabled_in_readonly() {
        let tmp = TempDir::new().unwrap();
        let log = ConversationLog::new(tmp.path(), None, TrustMode::Readonly);
        let msg = serde_json::json!({"role": "user", "content": "secret"});
        log.append(&msg).await.unwrap();

        // File should not exist because logging is disabled
        let exists = tmp
            .path()
            .join(MEMORY_DIR)
            .join("conversation.jsonl")
            .exists();
        assert!(!exists);
    }

    #[tokio::test]
    async fn test_conversation_log_disabled_in_plan() {
        let tmp = TempDir::new().unwrap();
        let log = ConversationLog::new(tmp.path(), None, TrustMode::Plan);
        let msg = serde_json::json!({"role": "user", "content": "plan stuff"});
        log.append(&msg).await.unwrap();

        let exists = tmp
            .path()
            .join(MEMORY_DIR)
            .join("conversation.jsonl")
            .exists();
        assert!(!exists);
    }
}
