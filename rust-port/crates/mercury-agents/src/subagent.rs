// SubAgent system for spawning and managing sub-agents
//
// Provides the ability to spawn sub-agents that can execute tasks independently,
// either in the foreground (blocking) or background. Sub-agents have restricted
// tool access to prevent recursive agent spawning.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Global registry of background agents and their status.
static BACKGROUND_AGENTS: Lazy<Mutex<HashMap<String, SubAgentInfo>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Tools that sub-agents are not allowed to use, to prevent recursive agent spawning.
const RECURSIVE_TOOLS: &[&str] = &["SubAgent", "SubAgentTeam", "AgentTeams", "ContextSearch"];

/// Represents a sub-agent that can be spawned to handle a specific task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgent {
    /// Unique identifier for this sub-agent.
    pub id: String,
    /// Working directory for the sub-agent.
    pub workspace: PathBuf,
    /// Description of the task to perform.
    pub task: String,
    /// Model identifier to use (e.g. "claude-sonnet-4-20250514").
    pub model: String,
    /// List of tool names this agent is allowed to use.
    pub tools: Vec<String>,
    /// List of tool names explicitly disallowed for this agent.
    pub disallowed_tools: Vec<String>,
    /// Optional structured output format specification (JSON schema).
    pub output_format: Option<String>,
    /// Permission rules governing what the agent can do (e.g. file paths, commands).
    pub permission_rules: Vec<PermissionRule>,
}

/// A permission rule for constraining sub-agent behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    /// The tool or action this rule applies to.
    pub tool: String,
    /// Whether this action is allowed.
    pub allow: bool,
    /// Optional pattern (glob or regex) to further restrict scope.
    pub pattern: Option<String>,
}

/// Tracks the status and metadata of a running or completed sub-agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentInfo {
    /// Unique identifier matching the SubAgent id.
    pub id: String,
    /// The task description.
    pub task: String,
    /// The model being used.
    pub model: String,
    /// Current execution status.
    pub status: SubAgentStatus,
    /// When the sub-agent was created.
    pub created_at: DateTime<Utc>,
    /// Result output, if completed.
    pub result: Option<String>,
}

/// Execution status of a sub-agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubAgentStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl SubAgent {
    /// Create a new sub-agent with the given parameters.
    pub fn new(
        workspace: PathBuf,
        task: String,
        model: String,
        tools: Vec<String>,
        permission_rules: Vec<PermissionRule>,
    ) -> Self {
        let id = Uuid::new_v4().to_string();

        // Filter out recursive tools from the provided tool list
        let filtered_tools: Vec<String> = tools
            .into_iter()
            .filter(|t| !Self::is_recursive_tool(t))
            .collect();

        Self {
            id,
            workspace,
            task,
            model,
            tools: filtered_tools,
            disallowed_tools: RECURSIVE_TOOLS.iter().map(|s| s.to_string()).collect(),
            output_format: None,
            permission_rules,
        }
    }

    /// Check whether a tool name is in the recursive tools blocklist.
    pub fn is_recursive_tool(tool_name: &str) -> bool {
        RECURSIVE_TOOLS
            .iter()
            .any(|&t| t.eq_ignore_ascii_case(tool_name))
    }

    /// Run this sub-agent's task. Currently a placeholder that registers
    /// the agent and simulates execution.
    pub async fn run(&self) -> anyhow::Result<String> {
        tracing::info!(id = %self.id, task = %self.task, "Starting sub-agent");

        // Register in background agents
        let info = SubAgentInfo {
            id: self.id.clone(),
            task: self.task.clone(),
            model: self.model.clone(),
            status: SubAgentStatus::Running,
            created_at: Utc::now(),
            result: None,
        };

        {
            let mut agents = BACKGROUND_AGENTS
                .lock()
                .map_err(|e| anyhow::anyhow!("Failed to lock background agents: {}", e))?;
            agents.insert(self.id.clone(), info);
        }

        // TODO: Implement actual agent execution loop:
        // 1. Build system prompt with task context
        // 2. Create message stream with the configured model
        // 3. Process tool calls in a loop until task is complete
        // 4. Collect and return the final output

        let result = format!("SubAgent {} completed task: {}", self.id, self.task);

        // Update status to completed
        {
            let mut agents = BACKGROUND_AGENTS
                .lock()
                .map_err(|e| anyhow::anyhow!("Failed to lock background agents: {}", e))?;
            if let Some(agent_info) = agents.get_mut(&self.id) {
                agent_info.status = SubAgentStatus::Completed;
                agent_info.result = Some(result.clone());
            }
        }

        Ok(result)
    }

    /// Harden the transcript by stripping sensitive data and tool call details
    /// that should not be returned to the parent agent.
    pub fn harden_transcript(transcript: &str) -> String {
        // Strip any tool invocation blocks and keep only textual output.
        // This is a simplified version; a full implementation would parse
        // structured messages and redact tool_use / tool_result blocks.
        let mut hardened = String::new();
        let mut in_tool_block = false;

        for line in transcript.lines() {
            if line.contains("<tool_use>") || line.contains("<tool_call>") {
                in_tool_block = true;
                continue;
            }
            if line.contains("</tool_use>") || line.contains("</tool_call>") {
                in_tool_block = false;
                continue;
            }
            if !in_tool_block {
                hardened.push_str(line);
                hardened.push('\n');
            }
        }

        hardened.trim().to_string()
    }
}

/// Run a team of sub-agents in parallel, collecting their results.
///
/// Each sub-agent runs concurrently via tokio tasks. Results are collected
/// and returned in the same order as the input agents.
pub async fn run_sub_agent_team(agents: Vec<SubAgent>) -> anyhow::Result<Vec<String>> {
    use tokio::task::JoinSet;

    let mut join_set = JoinSet::new();
    let mut order: Vec<String> = Vec::new();

    for agent in agents {
        order.push(agent.id.clone());
        join_set.spawn(async move { (agent.id.clone(), agent.run().await) });
    }

    let mut results_map: HashMap<String, String> = HashMap::new();

    while let Some(res) = join_set.join_next().await {
        match res {
            Ok((id, Ok(output))) => {
                results_map.insert(id, output);
            }
            Ok((id, Err(e))) => {
                tracing::error!(agent_id = %id, error = %e, "Sub-agent failed");
                results_map.insert(id, format!("Error: {}", e));
            }
            Err(e) => {
                tracing::error!(error = %e, "Sub-agent task panicked");
            }
        }
    }

    let results = order
        .iter()
        .map(|id| {
            results_map
                .remove(id)
                .unwrap_or_else(|| "No result (task may have panicked)".to_string())
        })
        .collect();

    Ok(results)
}

/// Look up a background agent by its ID.
pub fn get_background_agent(id: &str) -> Option<SubAgentInfo> {
    let agents = BACKGROUND_AGENTS.lock().ok()?;
    agents.get(id).cloned()
}

/// List all tracked background agents.
pub fn list_background_agents() -> Vec<SubAgentInfo> {
    match BACKGROUND_AGENTS.lock() {
        Ok(agents) => agents.values().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_is_recursive_tool() {
        assert!(SubAgent::is_recursive_tool("SubAgent"));
        assert!(SubAgent::is_recursive_tool("subagent"));
        assert!(SubAgent::is_recursive_tool("AgentTeams"));
        assert!(!SubAgent::is_recursive_tool("Bash"));
        assert!(!SubAgent::is_recursive_tool("Read"));
    }

    #[test]
    fn test_new_filters_recursive_tools() {
        let agent = SubAgent::new(
            PathBuf::from("/tmp"),
            "test task".to_string(),
            "test-model".to_string(),
            vec![
                "Bash".to_string(),
                "SubAgent".to_string(),
                "Read".to_string(),
                "AgentTeams".to_string(),
            ],
            vec![],
        );

        assert!(agent.tools.contains(&"Bash".to_string()));
        assert!(agent.tools.contains(&"Read".to_string()));
        assert!(!agent.tools.contains(&"SubAgent".to_string()));
        assert!(!agent.tools.contains(&"AgentTeams".to_string()));
    }

    #[test]
    fn test_harden_transcript() {
        let transcript = "Hello\n<tool_use>\nsome tool data\n</tool_use>\nWorld";
        let hardened = SubAgent::harden_transcript(transcript);
        assert_eq!(hardened, "Hello\nWorld");
    }

    #[tokio::test]
    async fn test_run_sub_agent() {
        let agent = SubAgent::new(
            PathBuf::from("/tmp"),
            "test task".to_string(),
            "test-model".to_string(),
            vec!["Bash".to_string()],
            vec![],
        );
        let id = agent.id.clone();

        let result = agent.run().await.unwrap();
        assert!(result.contains("completed task"));

        let info = get_background_agent(&id).unwrap();
        assert_eq!(info.status, SubAgentStatus::Completed);
    }

    #[tokio::test]
    async fn test_run_sub_agent_team() {
        let agents = vec![
            SubAgent::new(
                PathBuf::from("/tmp"),
                "task 1".to_string(),
                "model".to_string(),
                vec![],
                vec![],
            ),
            SubAgent::new(
                PathBuf::from("/tmp"),
                "task 2".to_string(),
                "model".to_string(),
                vec![],
                vec![],
            ),
        ];

        let results = run_sub_agent_team(agents).await.unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].contains("task 1"));
        assert!(results[1].contains("task 2"));
    }

    #[test]
    fn test_list_background_agents() {
        // Just verify it doesn't panic
        let _ = list_background_agents();
    }
}
