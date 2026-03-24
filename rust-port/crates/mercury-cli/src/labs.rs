// Mercury Code - Labs (Experimental Features)
// All new/advanced features live behind labs flags.
// Ported from: src/labs.js

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::fs;

use crate::utils::debug_log;

// ── Feature Definitions ───────────────────────────────────────────────────────

/// Definition of an experimental feature.
#[derive(Debug, Clone)]
pub struct LabsFeature {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub desc: &'static str,
    pub default_enabled: bool,
    /// Tool names this feature gates (empty = no tool gating).
    pub tools: &'static [&'static str],
    /// Other feature ids that must be enabled.
    pub requires: &'static [&'static str],
}

/// All registered experimental features.
pub static FEATURES: &[LabsFeature] = &[
    // ── Agent System ──
    LabsFeature {
        id: "subagent",
        name: "Sub-Agents",
        category: "Agents",
        desc: "Spawn autonomous sub-agents with isolated context",
        default_enabled: true,
        tools: &["SubAgent"],
        requires: &[],
    },
    LabsFeature {
        id: "subagent-team",
        name: "Agent Team (Parallel)",
        category: "Agents",
        desc: "Run up to 5 sub-agents in parallel on independent tasks",
        default_enabled: true,
        tools: &["SubAgentTeam"],
        requires: &["subagent"],
    },
    LabsFeature {
        id: "agent-resume",
        name: "Agent Resume",
        category: "Agents",
        desc: "Resume a previous sub-agent by agentId",
        default_enabled: false,
        tools: &[],
        requires: &["subagent"],
    },
    LabsFeature {
        id: "agent-background",
        name: "Agent Background",
        category: "Agents",
        desc: "Run sub-agents in background",
        default_enabled: false,
        tools: &[],
        requires: &["subagent"],
    },
    LabsFeature {
        id: "agent-worktree",
        name: "Agent Worktree Isolation",
        category: "Agents",
        desc: "Run sub-agents in isolated git worktrees",
        default_enabled: false,
        tools: &[],
        requires: &["subagent"],
    },
    LabsFeature {
        id: "agent-teams",
        name: "Agent Teams (Multi-Process)",
        category: "Agents",
        desc: "Collaborative agent teams with shared task list and messaging",
        default_enabled: false,
        tools: &["AgentTeams"],
        requires: &["subagent"],
    },
    // ── Context & Memory ──
    LabsFeature {
        id: "context-search",
        name: "Context Search",
        category: "Context & Memory",
        desc: "Search compressed conversation history for lost details",
        default_enabled: false,
        tools: &["ContextSearch"],
        requires: &[],
    },
    LabsFeature {
        id: "project-config",
        name: "Project Config (.mercury.md)",
        category: "Context & Memory",
        desc: "Load project-specific instructions from .mercury.md",
        default_enabled: true,
        tools: &[],
        requires: &[],
    },
    // ── Security & Isolation ──
    LabsFeature {
        id: "sandbox",
        name: "Sandbox",
        category: "Security",
        desc: "Sandboxed tool execution with namespace isolation and resource limits",
        default_enabled: false,
        tools: &[],
        requires: &[],
    },
];

// ── Persisted State ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct LabsState {
    enabled: bool,
    overrides: HashMap<String, bool>,
}

// ── Labs Manager ─────────────────────────────────────────────────────────────

/// Labs manages experimental feature flags.
pub struct Labs {
    /// Master switch -- must be ON for any feature to be active.
    pub enabled: bool,
    /// Per-feature overrides: feature_id -> bool.
    overrides: HashMap<String, bool>,
    /// Path to persist state.
    config_path: PathBuf,
}

impl Labs {
    pub fn new() -> Self {
        let config_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".mercury")
            .join("labs.json");
        Self {
            enabled: false,
            overrides: HashMap::new(),
            config_path,
        }
    }

    /// Get the full feature registry.
    pub fn get_features(&self) -> &'static [LabsFeature] {
        FEATURES
    }

    /// Get a single feature by ID.
    pub fn get_feature(&self, id: &str) -> Option<&'static LabsFeature> {
        FEATURES.iter().find(|f| f.id == id)
    }

    /// Check if a specific feature is currently active.
    /// Active = labs enabled + feature enabled + dependencies met.
    pub fn is_active(&self, feature_id: &str) -> bool {
        self.is_active_with_visited(feature_id, &mut HashSet::new())
    }

    fn is_active_with_visited(&self, feature_id: &str, visited: &mut HashSet<String>) -> bool {
        if !self.enabled {
            return false;
        }
        let feature = match self.get_feature(feature_id) {
            Some(f) => f,
            None => return false,
        };

        // Cycle detection
        if visited.contains(feature_id) {
            return false;
        }

        let feature_on = self
            .overrides
            .get(feature_id)
            .copied()
            .unwrap_or(feature.default_enabled);

        if !feature_on {
            return false;
        }

        // Check dependencies
        visited.insert(feature_id.to_string());
        for dep_id in feature.requires {
            if !self.is_active_with_visited(dep_id, visited) {
                return false;
            }
        }

        true
    }

    /// Check if a specific tool is allowed by labs configuration.
    /// Tools not gated by any feature are always allowed.
    pub fn is_tool_allowed(&self, tool_name: &str) -> bool {
        let feature = FEATURES.iter().find(|f| f.tools.contains(&tool_name));
        match feature {
            Some(f) => self.is_active(f.id),
            None => true, // Not gated -> always allowed
        }
    }

    /// Get list of all tool names currently blocked by labs.
    pub fn get_blocked_tools(&self) -> Vec<String> {
        let mut blocked = Vec::new();
        for feature in FEATURES {
            for tool in feature.tools {
                if !self.is_tool_allowed(tool) {
                    blocked.push(tool.to_string());
                }
            }
        }
        blocked
    }

    /// Toggle a feature on/off.
    pub async fn toggle(&mut self, feature_id: &str, value: Option<bool>) -> ToggleResult {
        let feature = match self.get_feature(feature_id) {
            Some(f) => f,
            None => {
                return ToggleResult {
                    ok: false,
                    message: format!("Unknown feature: \"{}\"", feature_id),
                }
            }
        };

        let current = self
            .overrides
            .get(feature_id)
            .copied()
            .unwrap_or(feature.default_enabled);
        let next = value.unwrap_or(!current);
        self.overrides.insert(feature_id.to_string(), next);

        // If disabling, also disable dependents
        if !next {
            let dependents: Vec<String> = FEATURES
                .iter()
                .filter(|f| f.requires.contains(&feature_id))
                .map(|f| f.id.to_string())
                .collect();
            for dep_id in dependents {
                self.overrides.insert(dep_id, false);
            }
        }

        self.save().await;
        ToggleResult {
            ok: true,
            message: format!("{}: {}", feature.name, if next { "ON" } else { "OFF" }),
        }
    }

    /// Enable labs master switch.
    pub async fn enable_labs(&mut self) {
        self.enabled = true;
        self.save().await;
    }

    /// Disable labs master switch.
    pub async fn disable_labs(&mut self) {
        self.enabled = false;
        self.save().await;
    }

    /// Load state from disk.
    pub async fn load(&mut self) {
        match fs::read_to_string(&self.config_path).await {
            Ok(data) => match serde_json::from_str::<LabsState>(&data) {
                Ok(state) => {
                    self.enabled = state.enabled;
                    self.overrides = state.overrides;
                }
                Err(e) => {
                    debug_log("Labs.load.parse", &e);
                }
            },
            Err(e) => {
                debug_log("Labs.load.read", &e);
            }
        }
    }

    /// Persist state to disk.
    async fn save(&self) {
        let state = LabsState {
            enabled: self.enabled,
            overrides: self.overrides.clone(),
        };
        if let Some(parent) = self.config_path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        match serde_json::to_string_pretty(&state) {
            Ok(json) => {
                if let Err(e) = fs::write(&self.config_path, json).await {
                    debug_log("Labs.save.write", &e);
                }
            }
            Err(e) => {
                debug_log("Labs.save.serialize", &e);
            }
        }
    }

    /// Get a snapshot of all features and their states for display.
    pub fn snapshot(&self) -> Vec<FeatureSnapshot> {
        FEATURES
            .iter()
            .map(|f| {
                let enabled = self
                    .overrides
                    .get(f.id)
                    .copied()
                    .unwrap_or(f.default_enabled);
                let active = self.is_active(f.id);
                let blocked = if !self.enabled {
                    Some("labs off".to_string())
                } else if !enabled {
                    Some("disabled".to_string())
                } else {
                    f.requires.iter().find_map(|dep_id| {
                        if !self.is_active(dep_id) {
                            Some(format!("requires {}", dep_id))
                        } else {
                            None
                        }
                    })
                };

                FeatureSnapshot {
                    id: f.id.to_string(),
                    name: f.name.to_string(),
                    category: f.category.to_string(),
                    desc: f.desc.to_string(),
                    active,
                    enabled,
                    blocked,
                    tools: f.tools.iter().map(|t| t.to_string()).collect(),
                }
            })
            .collect()
    }
}

/// Result of a feature toggle operation.
#[derive(Debug)]
pub struct ToggleResult {
    pub ok: bool,
    pub message: String,
}

/// Snapshot of a feature's state for display.
#[derive(Debug, Clone)]
pub struct FeatureSnapshot {
    pub id: String,
    pub name: String,
    pub category: String,
    pub desc: String,
    pub active: bool,
    pub enabled: bool,
    pub blocked: Option<String>,
    pub tools: Vec<String>,
}

/// Global singleton labs instance, protected by a mutex.
pub static LABS: Lazy<Mutex<Labs>> = Lazy::new(|| Mutex::new(Labs::new()));

/// Convenience: check if a tool is allowed via the global labs instance.
pub fn is_tool_allowed(tool_name: &str) -> bool {
    LABS.lock().unwrap().is_tool_allowed(tool_name)
}

/// Convenience: check if a feature is active via the global labs instance.
pub fn is_feature_active(feature_id: &str) -> bool {
    LABS.lock().unwrap().is_active(feature_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_labs_default_disabled() {
        let labs = Labs::new();
        assert!(!labs.enabled);
        assert!(!labs.is_active("subagent"));
    }

    #[test]
    fn test_labs_enabled_default_features() {
        let mut labs = Labs::new();
        labs.enabled = true;
        assert!(labs.is_active("subagent"));
        assert!(labs.is_active("subagent-team"));
        assert!(!labs.is_active("agent-resume")); // default false
    }

    #[test]
    fn test_labs_dependency_chain() {
        let mut labs = Labs::new();
        labs.enabled = true;
        // subagent-team requires subagent
        labs.overrides.insert("subagent".to_string(), false);
        assert!(!labs.is_active("subagent-team"));
    }

    #[test]
    fn test_tool_gating() {
        let mut labs = Labs::new();
        labs.enabled = true;
        assert!(labs.is_tool_allowed("SubAgent")); // subagent is default on
        assert!(!labs.is_tool_allowed("ContextSearch")); // context-search is default off
    }

    #[test]
    fn test_tool_not_gated() {
        let labs = Labs::new();
        assert!(labs.is_tool_allowed("Read")); // Not gated by any feature
    }

    #[test]
    fn test_cycle_detection() {
        // The real features don't have cycles, but verify no infinite loop
        let labs = Labs::new();
        assert!(!labs.is_active("nonexistent"));
    }

    #[test]
    fn test_snapshot() {
        let mut labs = Labs::new();
        labs.enabled = true;
        let snap = labs.snapshot();
        assert_eq!(snap.len(), FEATURES.len());
        // Check that subagent is active
        let subagent = snap.iter().find(|s| s.id == "subagent").unwrap();
        assert!(subagent.active);
        assert!(subagent.blocked.is_none());
    }
}
