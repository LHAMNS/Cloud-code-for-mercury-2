// Mercury Code - Session History Manager
// Saves and restores complete conversation sessions for backup and time-travel.
// Ported from: src/history.js

use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::utils::debug_log;

/// Maximum number of sessions to keep on disk.
const MAX_SESSIONS: usize = 50;

/// Redact common secret patterns from session summary text.
/// Prevents API keys, tokens, passwords, and other credentials
/// from being exposed in the /history list.
fn sanitize_summary(text: &str) -> String {
    use once_cell::sync::Lazy;

    static RE_GENERIC: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)(?:sk|pk|api|key|token|secret|password|bearer)[-_]?[a-zA-Z0-9]{16,}")
            .unwrap()
    });
    static RE_JWT: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?:eyJ)[A-Za-z0-9+/=]{20,}").unwrap());
    static RE_GITHUB: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}").unwrap());
    static RE_SLACK: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?:xox[bpsa])-[A-Za-z0-9-]{10,}").unwrap());

    let s = RE_GENERIC.replace_all(text, "[REDACTED]");
    let s = RE_JWT.replace_all(&s, "[JWT-REDACTED]");
    let s = RE_GITHUB.replace_all(&s, "[GITHUB-TOKEN-REDACTED]");
    let s = RE_SLACK.replace_all(&s, "[SLACK-TOKEN-REDACTED]");
    s.into_owned()
}

/// Saved session data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub id: String,
    pub cwd: String,
    pub timestamp: i64,
    pub date: String,
    #[serde(rename = "messageCount")]
    pub message_count: usize,
    pub summary: String,
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default, rename = "trustMode")]
    pub trust_mode: Option<String>,
    #[serde(default, rename = "planMode")]
    pub plan_mode: bool,
    #[serde(default)]
    pub sandbox: Option<serde_json::Value>,
}

/// Session listing entry (metadata only, no messages).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    pub id: String,
    pub date: String,
    pub timestamp: i64,
    pub message_count: usize,
    pub summary: String,
    pub cwd: String,
    pub filename: String,
}

/// SessionHistory manages saved conversation sessions.
/// Each session is stored as a JSON file in ~/.mercury/sessions/
pub struct SessionHistory {
    dir: PathBuf,
}

impl SessionHistory {
    pub fn new(dir: Option<PathBuf>) -> Self {
        let dir = dir.unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".mercury")
                .join("sessions")
        });
        Self { dir }
    }

    /// Ensure the sessions directory exists.
    async fn ensure_dir(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir).await
    }

    /// Save the current session to a file.
    pub async fn save(&self, session: &SessionData) -> anyhow::Result<String> {
        self.ensure_dir().await?;

        let ts = Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let filename = format!("{}_{}.json", ts, session.id);
        let filepath = self.dir.join(&filename);

        let data = SessionData {
            id: session.id.clone(),
            cwd: session.cwd.clone(),
            timestamp: Utc::now().timestamp_millis(),
            date: Utc::now().to_rfc3339(),
            message_count: session.messages.len(),
            summary: if session.summary.is_empty() {
                self.auto_summary(&session.messages)
            } else {
                session.summary.clone()
            },
            messages: session.messages.clone(),
            config: session.config.clone(),
            trust_mode: session.trust_mode.clone(),
            plan_mode: session.plan_mode,
            sandbox: session.sandbox.clone(),
        };

        let json = serde_json::to_string_pretty(&data)?;

        // Atomic write: write to tmp file, then rename
        let tmp_path = filepath.with_extension(format!("tmp-{}", Utc::now().timestamp_millis()));
        match fs::write(&tmp_path, &json).await {
            Ok(()) => {
                if let Err(e) = fs::rename(&tmp_path, &filepath).await {
                    let _ = fs::remove_file(&tmp_path).await;
                    return Err(e.into());
                }
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp_path).await;
                return Err(e.into());
            }
        }

        self.prune_old().await;
        Ok(filepath.to_string_lossy().to_string())
    }

    /// Auto-generate a short summary from the first user message.
    fn auto_summary(&self, messages: &[serde_json::Value]) -> String {
        let first_user = messages.iter().find(|m| {
            m.get("role")
                .and_then(|r| r.as_str())
                .map_or(false, |r| r == "user")
        });

        match first_user {
            Some(msg) => {
                let content = msg
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                let text: String = content.chars().take(80).collect();
                let raw = if text.len() < content.len() {
                    format!("{}...", text)
                } else {
                    text
                };
                sanitize_summary(&raw)
            }
            None => "(empty session)".to_string(),
        }
    }

    /// List all saved sessions, sorted by most recent first.
    pub async fn list(&self) -> Vec<SessionEntry> {
        if self.ensure_dir().await.is_err() {
            return Vec::new();
        }

        let mut entries = Vec::new();
        let mut read_dir = match fs::read_dir(&self.dir).await {
            Ok(rd) => rd,
            Err(e) => {
                debug_log("SessionHistory.list.read_dir", &e);
                return Vec::new();
            }
        };

        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let filename = entry.file_name().to_string_lossy().to_string();
            if !filename.ends_with(".json") {
                continue;
            }
            match fs::read_to_string(entry.path()).await {
                Ok(raw) => match serde_json::from_str::<SessionData>(&raw) {
                    Ok(data) => {
                        entries.push(SessionEntry {
                            id: data.id,
                            date: data.date,
                            timestamp: data.timestamp,
                            message_count: data.message_count,
                            summary: data.summary,
                            cwd: data.cwd,
                            filename,
                        });
                    }
                    Err(e) => {
                        debug_log("SessionHistory.list.parse", &e);
                    }
                },
                Err(e) => {
                    debug_log("SessionHistory.list.read", &e);
                }
            }
        }

        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        entries
    }

    /// Load a session by index (1-based from the list) or by filename/id.
    pub async fn load(&self, identifier: &str) -> Option<SessionData> {
        let sessions = self.list().await;

        let session = if let Ok(idx) = identifier.parse::<usize>() {
            if idx >= 1 && idx <= sessions.len() {
                sessions.get(idx - 1)
            } else {
                None
            }
        } else {
            sessions
                .iter()
                .find(|s| s.filename == identifier || s.id == identifier)
        };

        let session = session?;
        let filepath = self.dir.join(&session.filename);

        match fs::read_to_string(&filepath).await {
            Ok(raw) => match serde_json::from_str::<SessionData>(&raw) {
                Ok(data) => Some(data),
                Err(e) => {
                    debug_log("SessionHistory.load.parse", &e);
                    None
                }
            },
            Err(e) => {
                debug_log("SessionHistory.load.read", &e);
                None
            }
        }
    }

    /// Delete old sessions beyond MAX_SESSIONS.
    async fn prune_old(&self) {
        let sessions = self.list().await;
        if sessions.len() <= MAX_SESSIONS {
            return;
        }

        for s in sessions.iter().skip(MAX_SESSIONS) {
            let path = self.dir.join(&s.filename);
            if let Err(e) = fs::remove_file(&path).await {
                debug_log("SessionHistory.prune_old", &e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_summary_redacts_api_key() {
        let text = "Set key to sk-abc1234567890abcdef";
        let sanitized = sanitize_summary(text);
        assert!(sanitized.contains("[REDACTED]"));
        assert!(!sanitized.contains("sk-abc"));
    }

    #[test]
    fn test_sanitize_summary_redacts_jwt() {
        let text = "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef";
        let sanitized = sanitize_summary(text);
        assert!(sanitized.contains("[JWT-REDACTED]"));
    }

    #[test]
    fn test_sanitize_summary_redacts_github() {
        let text = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
        let sanitized = sanitize_summary(text);
        assert!(sanitized.contains("[GITHUB-TOKEN-REDACTED]"));
    }

    #[test]
    fn test_sanitize_summary_passthrough() {
        let text = "normal conversation about code";
        let sanitized = sanitize_summary(text);
        assert_eq!(sanitized, text);
    }

    #[tokio::test]
    async fn test_session_history_new() {
        let tmp = tempfile::TempDir::new().unwrap();
        let history = SessionHistory::new(Some(tmp.path().to_path_buf()));
        let sessions = history.list().await;
        assert!(sessions.is_empty());
    }
}
