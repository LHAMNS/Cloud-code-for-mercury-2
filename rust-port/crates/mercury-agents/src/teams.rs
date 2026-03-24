// Multi-agent team coordination
//
// Provides a system for organizing multiple agents into teams with task
// dependencies, message passing, and signal broadcasting. Tasks can depend
// on other tasks, and agents claim and complete tasks from a shared queue.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

/// Global registry of active teams.
static TEAMS: Lazy<Mutex<HashMap<String, AgentTeam>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Status of a task within a team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

/// Signals that can be broadcast to team members.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Signal {
    Start,
    Pause,
    Resume,
    Cancel,
    Complete,
}

/// A task managed by a team, with optional dependencies on other tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// Unique task ID within the team.
    pub id: u64,
    /// Human-readable description of what needs to be done.
    pub description: String,
    /// Current status.
    pub status: TaskStatus,
    /// Agent name that has claimed this task, if any.
    pub assignee: Option<String>,
    /// IDs of tasks that must complete before this one can start.
    pub depends_on: Vec<u64>,
    /// Result output once the task is completed.
    pub result: Option<String>,
}

/// A message sent between agents within a team.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMessage {
    /// Sender agent name.
    pub from: String,
    /// Recipient agent name.
    pub to: String,
    /// Message content.
    pub content: String,
    /// When the message was sent.
    pub timestamp: DateTime<Utc>,
}

/// A team of agents coordinating on a set of tasks with message passing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTeam {
    /// Team name / identifier.
    pub name: String,
    /// All tasks in this team.
    pub tasks: Vec<Task>,
    /// Counter for generating unique task IDs.
    next_task_id: u64,
    /// Per-agent mailboxes for inter-agent messaging.
    pub mailbox: HashMap<String, Vec<TeamMessage>>,
}

impl AgentTeam {
    /// Create a new empty team with the given name.
    pub fn new(name: String) -> Self {
        Self {
            name,
            tasks: Vec::new(),
            next_task_id: 1,
            mailbox: HashMap::new(),
        }
    }

    /// Add a new task to the team, returning its assigned ID.
    pub fn add_task(&mut self, description: String, depends_on: Vec<u64>) -> u64 {
        let id = self.next_task_id;
        self.next_task_id += 1;

        self.tasks.push(Task {
            id,
            description,
            status: TaskStatus::Pending,
            assignee: None,
            depends_on,
            result: None,
        });

        id
    }

    /// Get the next available task that has all dependencies satisfied.
    /// Returns the task ID and description if one is available.
    pub fn get_next_task(&self) -> Option<&Task> {
        let completed_ids: Vec<u64> = self
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Completed)
            .map(|t| t.id)
            .collect();

        self.tasks.iter().find(|task| {
            task.status == TaskStatus::Pending
                && task
                    .depends_on
                    .iter()
                    .all(|dep| completed_ids.contains(dep))
        })
    }

    /// Claim a task for a specific agent. Returns true if successful,
    /// false if the task doesn't exist, is already claimed, or has
    /// unsatisfied dependencies.
    pub fn claim_task(&mut self, task_id: u64, agent_name: &str) -> bool {
        let completed_ids: Vec<u64> = self
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Completed)
            .map(|t| t.id)
            .collect();

        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == task_id) {
            if task.status != TaskStatus::Pending {
                return false;
            }
            if !task.depends_on.iter().all(|dep| completed_ids.contains(dep)) {
                return false;
            }
            task.status = TaskStatus::InProgress;
            task.assignee = Some(agent_name.to_string());
            true
        } else {
            false
        }
    }

    /// Mark a task as completed with the given result.
    pub fn complete_task(&mut self, task_id: u64, result: String) -> bool {
        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == task_id) {
            if task.status != TaskStatus::InProgress {
                return false;
            }
            task.status = TaskStatus::Completed;
            task.result = Some(result);
            true
        } else {
            false
        }
    }

    /// Send a message from one agent to another within the team.
    pub fn send_message(&mut self, from: String, to: String, content: String) {
        let message = TeamMessage {
            from,
            to: to.clone(),
            content,
            timestamp: Utc::now(),
        };

        self.mailbox
            .entry(to)
            .or_insert_with(Vec::new)
            .push(message);
    }

    /// Retrieve and drain all messages for a given agent.
    pub fn get_mailbox(&mut self, agent_name: &str) -> Vec<TeamMessage> {
        self.mailbox
            .remove(agent_name)
            .unwrap_or_default()
    }

    /// Get a summary of all tasks and their current status.
    pub fn task_summary(&self) -> String {
        let mut summary = format!("Team '{}' - {} tasks:\n", self.name, self.tasks.len());

        for task in &self.tasks {
            let status = match task.status {
                TaskStatus::Pending => "PENDING",
                TaskStatus::InProgress => "IN PROGRESS",
                TaskStatus::Completed => "COMPLETED",
            };
            let assignee = task
                .assignee
                .as_deref()
                .unwrap_or("unassigned");
            summary.push_str(&format!(
                "  [{}] #{}: {} ({})\n",
                status, task.id, task.description, assignee
            ));
        }

        summary
    }

    /// Broadcast a signal to all agents in the team by sending a message
    /// to every known mailbox recipient.
    pub fn broadcast_signal(&mut self, signal: Signal) {
        let agent_names: Vec<String> = self.mailbox.keys().cloned().collect();
        let signal_str = format!("{:?}", signal);

        // Also include any assignees
        let mut all_agents: Vec<String> = agent_names;
        for task in &self.tasks {
            if let Some(ref assignee) = task.assignee {
                if !all_agents.contains(assignee) {
                    all_agents.push(assignee.clone());
                }
            }
        }

        for agent in all_agents {
            self.send_message(
                "system".to_string(),
                agent,
                format!("SIGNAL: {}", signal_str),
            );
        }
    }

    /// Check if all tasks in the team are completed.
    pub fn is_complete(&self) -> bool {
        self.tasks.iter().all(|t| t.status == TaskStatus::Completed)
    }
}

/// Execute agent teams by processing all registered teams.
/// This is a placeholder that would normally orchestrate actual agent execution.
pub async fn execute_agent_teams() -> anyhow::Result<HashMap<String, String>> {
    let team_names: Vec<String> = {
        let teams = TEAMS
            .lock()
            .map_err(|e| anyhow::anyhow!("Failed to lock teams: {}", e))?;
        teams.keys().cloned().collect()
    };

    let mut results = HashMap::new();

    for name in team_names {
        // TODO: Actually spawn agents and execute tasks.
        // For now, return the task summary for each team.
        let summary = {
            let teams = TEAMS
                .lock()
                .map_err(|e| anyhow::anyhow!("Failed to lock teams: {}", e))?;
            teams
                .get(&name)
                .map(|t| t.task_summary())
                .unwrap_or_default()
        };
        results.insert(name, summary);
    }

    Ok(results)
}

/// Get a clone of a team by name from the global registry.
pub fn get_team(name: &str) -> Option<AgentTeam> {
    let teams = TEAMS.lock().ok()?;
    teams.get(name).cloned()
}

/// Register or update a team in the global registry.
pub fn register_team(team: AgentTeam) {
    if let Ok(mut teams) = TEAMS.lock() {
        teams.insert(team.name.clone(), team);
    }
}

/// List all registered team names.
pub fn list_teams() -> Vec<String> {
    match TEAMS.lock() {
        Ok(teams) => teams.keys().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_team_and_add_tasks() {
        let mut team = AgentTeam::new("test-team".to_string());
        let id1 = team.add_task("First task".to_string(), vec![]);
        let id2 = team.add_task("Second task".to_string(), vec![id1]);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(team.tasks.len(), 2);
    }

    #[test]
    fn test_get_next_task_respects_dependencies() {
        let mut team = AgentTeam::new("test-team".to_string());
        let id1 = team.add_task("First task".to_string(), vec![]);
        let _id2 = team.add_task("Second task (depends on first)".to_string(), vec![id1]);

        // First available task should be task 1
        let next = team.get_next_task().unwrap();
        assert_eq!(next.id, id1);

        // Claim and complete task 1
        assert!(team.claim_task(id1, "agent-a"));
        assert!(team.complete_task(id1, "done".to_string()));

        // Now task 2 should be available
        let next = team.get_next_task().unwrap();
        assert_eq!(next.id, 2);
    }

    #[test]
    fn test_claim_task_fails_for_unmet_dependencies() {
        let mut team = AgentTeam::new("test-team".to_string());
        let id1 = team.add_task("First".to_string(), vec![]);
        let id2 = team.add_task("Second".to_string(), vec![id1]);

        // Cannot claim task 2 before task 1 is done
        assert!(!team.claim_task(id2, "agent-a"));

        // Can claim task 1
        assert!(team.claim_task(id1, "agent-a"));
    }

    #[test]
    fn test_complete_task_requires_in_progress() {
        let mut team = AgentTeam::new("test-team".to_string());
        let id1 = team.add_task("Task".to_string(), vec![]);

        // Cannot complete a pending task
        assert!(!team.complete_task(id1, "result".to_string()));

        // Claim it first
        assert!(team.claim_task(id1, "agent-a"));
        assert!(team.complete_task(id1, "result".to_string()));

        // Cannot complete again
        assert!(!team.complete_task(id1, "result2".to_string()));
    }

    #[test]
    fn test_messaging() {
        let mut team = AgentTeam::new("test-team".to_string());

        team.send_message(
            "agent-a".to_string(),
            "agent-b".to_string(),
            "Hello from A".to_string(),
        );
        team.send_message(
            "agent-a".to_string(),
            "agent-b".to_string(),
            "Another message".to_string(),
        );

        let messages = team.get_mailbox("agent-b");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "Hello from A");

        // Mailbox should be empty after retrieval
        let messages = team.get_mailbox("agent-b");
        assert!(messages.is_empty());
    }

    #[test]
    fn test_broadcast_signal() {
        let mut team = AgentTeam::new("test-team".to_string());
        let id1 = team.add_task("Task".to_string(), vec![]);
        team.claim_task(id1, "agent-a");

        // Send a message to create a mailbox entry for agent-b
        team.send_message("x".to_string(), "agent-b".to_string(), "init".to_string());
        let _ = team.get_mailbox("agent-b"); // drain init message

        // Re-send to register agent-b in mailbox keys
        team.send_message("x".to_string(), "agent-b".to_string(), "init".to_string());

        team.broadcast_signal(Signal::Cancel);

        // agent-a (assignee) should have a signal message
        let msgs_a = team.get_mailbox("agent-a");
        assert!(msgs_a.iter().any(|m| m.content.contains("Cancel")));
    }

    #[test]
    fn test_task_summary() {
        let mut team = AgentTeam::new("my-team".to_string());
        team.add_task("Do something".to_string(), vec![]);
        let summary = team.task_summary();
        assert!(summary.contains("my-team"));
        assert!(summary.contains("Do something"));
        assert!(summary.contains("PENDING"));
    }

    #[test]
    fn test_is_complete() {
        let mut team = AgentTeam::new("test".to_string());
        assert!(team.is_complete()); // empty team is complete

        let id = team.add_task("Task".to_string(), vec![]);
        assert!(!team.is_complete());

        team.claim_task(id, "agent");
        team.complete_task(id, "done".to_string());
        assert!(team.is_complete());
    }

    #[test]
    fn test_register_and_list_teams() {
        let team = AgentTeam::new("registered-team".to_string());
        register_team(team);

        let teams = list_teams();
        assert!(teams.contains(&"registered-team".to_string()));

        let retrieved = get_team("registered-team");
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "registered-team");
    }

    #[tokio::test]
    async fn test_execute_agent_teams() {
        let mut team = AgentTeam::new("exec-team".to_string());
        team.add_task("A task".to_string(), vec![]);
        register_team(team);

        let results = execute_agent_teams().await.unwrap();
        assert!(results.contains_key("exec-team"));
    }
}
