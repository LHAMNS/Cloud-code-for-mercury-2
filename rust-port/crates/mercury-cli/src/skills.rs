// Mercury Code - Skills System
// Skills are prompt-based extensions defined in SKILL.md files with YAML frontmatter.
// Ported from: src/skills.js

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::utils::debug_log;

// ── Skill ────────────────────────────────────────────────────────────────────

/// A skill definition loaded from a SKILL.md file.
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub argument_hint: String,
    pub user_invocable: bool,
    pub allowed_tools: Option<Vec<String>>,
    pub disallowed_tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub context: Option<String>,
    pub agent: Option<String>,
    pub disable_model_invocation: bool,
    pub source: String,
    pub is_project_level: bool,
}

impl Skill {
    /// Render the skill prompt with argument substitution.
    pub fn render(&self, argument: &str) -> String {
        self.prompt
            .replace("{{argument}}", argument)
            .replace("$ARGUMENTS", argument)
    }
}

// ── Frontmatter Parser ──────────────────────────────────────────────────────

/// Parse YAML frontmatter from a markdown string.
fn parse_frontmatter(content: &str) -> (HashMap<String, String>, String) {
    let re = regex::Regex::new(r"^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$").unwrap();
    let caps = match re.captures(content) {
        Some(c) => c,
        None => return (HashMap::new(), content.to_string()),
    };

    let yaml_str = &caps[1];
    let body = caps[2].to_string();
    let mut frontmatter = HashMap::new();

    for line in yaml_str.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(colon_idx) = trimmed.find(':') {
            let key = trimmed[..colon_idx].trim().to_string();
            let mut value = trimmed[colon_idx + 1..].trim().to_string();
            // Strip surrounding quotes
            if (value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\''))
            {
                value = value[1..value.len() - 1].to_string();
            }
            frontmatter.insert(key, value);
        }
    }

    (frontmatter, body)
}

/// Parse a comma-separated tool list string into a Vec.
fn parse_tool_list(tools: Option<&str>) -> Option<Vec<String>> {
    tools.map(|t| {
        t.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

// ── SkillManager ────────────────────────────────────────────────────────────

/// Discovers, loads, and manages skills.
pub struct SkillManager {
    skills: HashMap<String, Skill>,
    loaded: bool,
}

impl SkillManager {
    pub fn new() -> Self {
        Self {
            skills: HashMap::new(),
            loaded: false,
        }
    }

    /// Discover and load all skills from project and user directories.
    pub async fn discover(&mut self, workspace: &Path) {
        self.skills.clear();

        // 1. User-level skills: ~/.mercury/skills/*.md
        let user_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".mercury")
            .join("skills");
        self.load_from_directory(&user_dir, false).await;

        // 2. Project-level skills: .mercury/skills/*.md (override user-level)
        let project_dir = workspace.join(".mercury").join("skills");
        self.load_from_directory(&project_dir, true).await;

        self.loaded = true;
    }

    async fn load_from_directory(&mut self, dir_path: &Path, is_project_level: bool) {
        let mut entries = match fs::read_dir(dir_path).await {
            Ok(e) => e,
            Err(_) => return,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            let file_path = dir_path.join(&name);
            match fs::read_to_string(&file_path).await {
                Ok(content) => {
                    if let Some(mut skill) =
                        self.parse_skill_file(&content, &file_path.to_string_lossy())
                    {
                        // Security: strip unenforced fields from project-level skills
                        if is_project_level {
                            skill.is_project_level = true;
                            if skill.allowed_tools.is_some()
                                || skill.disallowed_tools.is_some()
                                || skill.model.is_some()
                                || skill.agent.is_some()
                            {
                                debug_log(
                                    "SkillManager.load_from_directory",
                                    &format!(
                                        "Stripping unenforced fields from project-level skill \"{}\"",
                                        skill.name
                                    ),
                                );
                            }
                            skill.allowed_tools = None;
                            skill.disallowed_tools = None;
                            skill.model = None;
                            skill.agent = None;
                        }
                        self.skills.insert(skill.name.clone(), skill);
                    }
                }
                Err(e) => {
                    debug_log("SkillManager.load_from_directory.read", &e);
                }
            }
        }
    }

    fn parse_skill_file(&self, content: &str, file_path: &str) -> Option<Skill> {
        let (frontmatter, body) = parse_frontmatter(content);

        let name = frontmatter
            .get("name")
            .cloned()
            .unwrap_or_else(|| {
                Path::new(file_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });

        if name.is_empty() {
            return None;
        }

        let user_invocable = frontmatter
            .get("user-invocable")
            .map(|v| v != "false")
            .unwrap_or(true);

        let disable_model_invocation = frontmatter
            .get("disable-model-invocation")
            .map(|v| v == "true")
            .unwrap_or(false);

        Some(Skill {
            name,
            description: frontmatter.get("description").cloned().unwrap_or_default(),
            prompt: body.trim().to_string(),
            argument_hint: frontmatter
                .get("argument-hint")
                .cloned()
                .unwrap_or_default(),
            user_invocable,
            allowed_tools: parse_tool_list(frontmatter.get("allowed-tools").map(|s| s.as_str())),
            disallowed_tools: parse_tool_list(
                frontmatter.get("disallowed-tools").map(|s| s.as_str()),
            ),
            model: frontmatter.get("model").cloned(),
            context: frontmatter.get("context").cloned(),
            agent: frontmatter.get("agent").cloned(),
            disable_model_invocation,
            source: file_path.to_string(),
            is_project_level: false,
        })
    }

    /// Get a skill by name.
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.get(name)
    }

    /// Check if a skill exists.
    pub fn has(&self, name: &str) -> bool {
        self.skills.contains_key(name)
    }

    /// Get all user-invocable skills.
    pub fn get_user_invocable(&self) -> Vec<&Skill> {
        self.skills
            .values()
            .filter(|s| s.user_invocable)
            .collect()
    }

    /// Get all skills.
    pub fn get_all(&self) -> Vec<&Skill> {
        self.skills.values().collect()
    }

    /// Get skill names for tab completion.
    pub fn get_completions(&self) -> Vec<String> {
        self.get_user_invocable()
            .iter()
            .map(|s| format!("/{}", s.name))
            .collect()
    }

    /// Generate a tool definition for invoking skills.
    pub fn get_tool_definition(
        &self,
        exclude_project_skills: bool,
    ) -> Option<serde_json::Value> {
        let invocable: Vec<&Skill> = self
            .skills
            .values()
            .filter(|s| {
                !s.disable_model_invocation
                    && (!exclude_project_skills || !s.is_project_level)
            })
            .collect();

        if invocable.is_empty() {
            return None;
        }

        let skill_names: Vec<&str> = invocable.iter().map(|s| s.name.as_str()).collect();
        let names_str = skill_names.join(", ");

        Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": "Skill",
                "description": format!(
                    "Invoke a skill (prompt-based extension). Available skills: {}.",
                    names_str
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "skill": {
                            "type": "string",
                            "description": format!("The skill name to invoke. Available: {}", names_str),
                        },
                        "args": {
                            "type": "string",
                            "description": "Optional arguments for the skill.",
                        }
                    },
                    "required": ["skill"]
                }
            }
        }))
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    pub fn count(&self) -> usize {
        self.skills.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter() {
        let content = r#"---
name: test-skill
description: A test skill
user-invocable: true
---
This is the prompt body.
"#;
        let (fm, body) = parse_frontmatter(content);
        assert_eq!(fm.get("name").unwrap(), "test-skill");
        assert_eq!(fm.get("description").unwrap(), "A test skill");
        assert!(body.contains("This is the prompt body."));
    }

    #[test]
    fn test_parse_frontmatter_no_frontmatter() {
        let content = "Just plain markdown";
        let (fm, body) = parse_frontmatter(content);
        assert!(fm.is_empty());
        assert_eq!(body, content);
    }

    #[test]
    fn test_skill_render() {
        let skill = Skill {
            name: "test".to_string(),
            description: String::new(),
            prompt: "Do {{argument}} for the user".to_string(),
            argument_hint: String::new(),
            user_invocable: true,
            allowed_tools: None,
            disallowed_tools: None,
            model: None,
            context: None,
            agent: None,
            disable_model_invocation: false,
            source: String::new(),
            is_project_level: false,
        };
        let rendered = skill.render("some task");
        assert_eq!(rendered, "Do some task for the user");
    }

    #[test]
    fn test_parse_tool_list() {
        let result = parse_tool_list(Some("Bash, Read, Grep"));
        assert_eq!(result.unwrap(), vec!["Bash", "Read", "Grep"]);
    }

    #[test]
    fn test_parse_tool_list_none() {
        assert!(parse_tool_list(None).is_none());
    }

    #[test]
    fn test_skill_manager_new() {
        let sm = SkillManager::new();
        assert_eq!(sm.count(), 0);
        assert!(!sm.is_loaded());
    }
}
