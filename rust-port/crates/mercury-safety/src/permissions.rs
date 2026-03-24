//! Permission management for Mercury Code.
//! Implements a 6-mode permission system with rule-based access control.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Permission modes available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Readonly,
    Approval,
    AcceptEdits,
    Open,
    DontAsk,
    AiSafetyDecide,
}

impl PermissionMode {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "readonly" => Some(Self::Readonly),
            "approval" => Some(Self::Approval),
            "accept-edits" => Some(Self::AcceptEdits),
            "open" => Some(Self::Open),
            "dont-ask" | "dontask" => Some(Self::DontAsk),
            "ai-safety-decide" => Some(Self::AiSafetyDecide),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Readonly => "readonly",
            Self::Approval => "approval",
            Self::AcceptEdits => "accept-edits",
            Self::Open => "open",
            Self::DontAsk => "dont-ask",
            Self::AiSafetyDecide => "ai-safety-decide",
        }
    }
}

/// Trust levels for permission evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TrustLevel {
    None = 0,
    ReadOnly = 1,
    EditOnly = 2,
    Full = 3,
    Unrestricted = 4,
}

/// Permission rule action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleAction {
    Allow,
    Deny,
}

/// A permission rule with optional tool specifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    pub action: RuleAction,
    pub tool: String,
    pub specifier: Option<String>,
}

impl PermissionRule {
    pub fn allow(tool: &str) -> Self {
        Self {
            action: RuleAction::Allow,
            tool: tool.to_string(),
            specifier: None,
        }
    }

    pub fn deny(tool: &str) -> Self {
        Self {
            action: RuleAction::Deny,
            tool: tool.to_string(),
            specifier: None,
        }
    }

    pub fn allow_with_specifier(tool: &str, specifier: &str) -> Self {
        Self {
            action: RuleAction::Allow,
            tool: tool.to_string(),
            specifier: Some(specifier.to_string()),
        }
    }

    pub fn deny_with_specifier(tool: &str, specifier: &str) -> Self {
        Self {
            action: RuleAction::Deny,
            tool: tool.to_string(),
            specifier: Some(specifier.to_string()),
        }
    }

    /// Check if this rule matches a tool use.
    pub fn matches(&self, tool_name: &str, argument: Option<&str>) -> bool {
        // Wildcard matches everything
        if self.tool == "*" {
            return true;
        }
        if self.tool != tool_name {
            return false;
        }
        // If rule has no specifier, it matches any use of this tool
        if self.specifier.is_none() {
            return true;
        }
        // If rule has specifier, check against argument
        if let (Some(ref spec), Some(arg)) = (&self.specifier, argument) {
            return arg.contains(spec.as_str());
        }
        false
    }
}

/// Decision from permission evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Deny,
    Ask,         // Need user approval
    AiDecide,    // Let AI safety system decide
}

/// Read-only tools that are always allowed in non-readonly modes.
const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "ListDir", "Diff", "AstSearch", "Lsp"];
/// Write tools that modify files.
const WRITE_TOOLS: &[&str] = &["Write", "Edit", "Patch"];
/// Dangerous tools that need explicit permission.
const DANGEROUS_TOOLS: &[&str] = &["Bash", "Fetch"];

/// Shell operators that could be dangerous.
const SHELL_OPERATORS: &[&str] = &["|", "&&", "||", ";", ">", ">>", "<", "$(", "`"];

/// Permission manager.
pub struct PermissionManager {
    mode: PermissionMode,
    rules: Vec<PermissionRule>,
    dynamic_rules: Vec<PermissionRule>,
    audit_log: Vec<AuditEntry>,
    /// Callback for custom permission checks
    custom_check: Option<Box<dyn Fn(&str, Option<&str>) -> Option<PermissionDecision> + Send + Sync>>,
}

/// Audit log entry.
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub tool: String,
    pub argument: Option<String>,
    pub decision: String,
    pub mode: String,
}

impl PermissionManager {
    pub fn new(mode: PermissionMode) -> Self {
        Self {
            mode,
            rules: Vec::new(),
            dynamic_rules: Vec::new(),
            audit_log: Vec::new(),
            custom_check: None,
        }
    }

    pub fn mode(&self) -> PermissionMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: PermissionMode) {
        self.mode = mode;
    }

    pub fn add_rule(&mut self, rule: PermissionRule) {
        self.rules.push(rule);
    }

    pub fn add_dynamic_rule(&mut self, rule: PermissionRule) {
        self.dynamic_rules.push(rule);
    }

    pub fn clear_dynamic_rules(&mut self) {
        self.dynamic_rules.clear();
    }

    pub fn set_custom_check<F>(&mut self, check: F)
    where
        F: Fn(&str, Option<&str>) -> Option<PermissionDecision> + Send + Sync + 'static,
    {
        self.custom_check = Some(Box::new(check));
    }

    /// Decompose a shell command to find operators.
    pub fn decompose_shell_operators(command: &str) -> Vec<String> {
        let mut found = Vec::new();
        for op in SHELL_OPERATORS {
            if command.contains(op) {
                found.push(op.to_string());
            }
        }
        found
    }

    /// Evaluate if a tool use is permitted.
    pub fn can_use_tool(&mut self, tool_name: &str, argument: Option<&str>) -> PermissionDecision {
        // Check custom callback first
        if let Some(ref check) = self.custom_check {
            if let Some(decision) = check(tool_name, argument) {
                self.log_audit(tool_name, argument, &decision);
                return decision;
            }
        }

        // Check deny rules first (deny overrides allow)
        for rule in self.rules.iter().chain(self.dynamic_rules.iter()) {
            if rule.action == RuleAction::Deny && rule.matches(tool_name, argument) {
                self.log_audit(tool_name, argument, &PermissionDecision::Deny);
                return PermissionDecision::Deny;
            }
        }

        // Mode-based decision
        let decision = match self.mode {
            PermissionMode::Readonly => {
                if READ_TOOLS.contains(&tool_name) {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Deny
                }
            }
            PermissionMode::Approval => {
                // Check allow rules
                for rule in self.rules.iter().chain(self.dynamic_rules.iter()) {
                    if rule.action == RuleAction::Allow && rule.matches(tool_name, argument) {
                        return {
                            self.log_audit(tool_name, argument, &PermissionDecision::Allow);
                            PermissionDecision::Allow
                        };
                    }
                }
                // Read tools are auto-allowed
                if READ_TOOLS.contains(&tool_name) {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Ask
                }
            }
            PermissionMode::AcceptEdits => {
                if READ_TOOLS.contains(&tool_name) || WRITE_TOOLS.contains(&tool_name) {
                    PermissionDecision::Allow
                } else {
                    // Check allow rules for other tools
                    for rule in self.rules.iter().chain(self.dynamic_rules.iter()) {
                        if rule.action == RuleAction::Allow && rule.matches(tool_name, argument) {
                            return {
                                self.log_audit(tool_name, argument, &PermissionDecision::Allow);
                                PermissionDecision::Allow
                            };
                        }
                    }
                    PermissionDecision::Ask
                }
            }
            PermissionMode::Open => PermissionDecision::Allow,
            PermissionMode::DontAsk => {
                // DontAsk: deny everything not explicitly allowed by rules
                // (opposite of Open — never prompt, just deny)
                if READ_TOOLS.contains(&tool_name) {
                    PermissionDecision::Allow
                } else {
                    for rule in self.rules.iter().chain(self.dynamic_rules.iter()) {
                        if rule.action == RuleAction::Allow && rule.matches(tool_name, argument) {
                            return {
                                self.log_audit(tool_name, argument, &PermissionDecision::Allow);
                                PermissionDecision::Allow
                            };
                        }
                    }
                    PermissionDecision::Deny
                }
            }
            PermissionMode::AiSafetyDecide => {
                if READ_TOOLS.contains(&tool_name) {
                    PermissionDecision::Allow
                } else {
                    // Check allow rules first
                    for rule in self.rules.iter().chain(self.dynamic_rules.iter()) {
                        if rule.action == RuleAction::Allow && rule.matches(tool_name, argument) {
                            return {
                                self.log_audit(tool_name, argument, &PermissionDecision::Allow);
                                PermissionDecision::Allow
                            };
                        }
                    }
                    PermissionDecision::AiDecide
                }
            }
        };

        self.log_audit(tool_name, argument, &decision);
        decision
    }

    fn log_audit(&mut self, tool: &str, argument: Option<&str>, decision: &PermissionDecision) {
        self.audit_log.push(AuditEntry {
            timestamp: chrono::Utc::now(),
            tool: tool.to_string(),
            argument: argument.map(|s| s.to_string()),
            decision: format!("{:?}", decision),
            mode: self.mode.as_str().to_string(),
        });
    }

    pub fn audit_log(&self) -> &[AuditEntry] {
        &self.audit_log
    }

    /// Merge permission rules from a parent manager.
    pub fn merge_from_parent(&mut self, parent: &PermissionManager) {
        // Inherit rules but keep own mode
        for rule in &parent.rules {
            self.rules.push(rule.clone());
        }
    }

    /// Get the trust level for the current mode.
    pub fn trust_level(&self) -> TrustLevel {
        match self.mode {
            PermissionMode::Readonly => TrustLevel::ReadOnly,
            PermissionMode::Approval => TrustLevel::EditOnly,
            PermissionMode::AcceptEdits => TrustLevel::EditOnly,
            PermissionMode::Open => TrustLevel::Full,
            PermissionMode::DontAsk => TrustLevel::None,
            PermissionMode::AiSafetyDecide => TrustLevel::Full,
        }
    }

    /// Get all valid permission modes.
    pub fn valid_modes() -> &'static [&'static str] {
        &["readonly", "approval", "accept-edits", "open", "dont-ask", "ai-safety-decide"]
    }
}

/// Settings precedence helper.
pub fn merge_settings(base: &HashMap<String, String>, overrides: &HashMap<String, String>) -> HashMap<String, String> {
    let mut result = base.clone();
    for (k, v) in overrides {
        result.insert(k.clone(), v.clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_permission_modes() {
        assert_eq!(PermissionManager::valid_modes().len(), 6);
        for mode_str in PermissionManager::valid_modes() {
            assert!(PermissionMode::from_str(mode_str).is_some());
        }
    }

    #[test]
    fn test_readonly_mode() {
        let mut pm = PermissionManager::new(PermissionMode::Readonly);
        assert_eq!(pm.can_use_tool("Read", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Glob", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Deny);
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Deny);
    }

    #[test]
    fn test_open_mode() {
        let mut pm = PermissionManager::new(PermissionMode::Open);
        assert_eq!(pm.can_use_tool("Bash", Some("rm -rf /")), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Allow);
    }

    #[test]
    fn test_approval_mode() {
        let mut pm = PermissionManager::new(PermissionMode::Approval);
        assert_eq!(pm.can_use_tool("Read", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Ask);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Ask);
    }

    #[test]
    fn test_deny_overrides_allow() {
        let mut pm = PermissionManager::new(PermissionMode::Open);
        pm.add_rule(PermissionRule::deny_with_specifier("Bash", "rm -rf"));
        assert_eq!(pm.can_use_tool("Bash", Some("rm -rf /")), PermissionDecision::Deny);
        assert_eq!(pm.can_use_tool("Bash", Some("ls")), PermissionDecision::Allow);
    }

    #[test]
    fn test_deny_with_specifier() {
        let mut pm = PermissionManager::new(PermissionMode::Open);
        pm.add_rule(PermissionRule::deny_with_specifier("Write", ".env"));
        assert_eq!(pm.can_use_tool("Write", Some("config.env")), PermissionDecision::Deny);
        assert_eq!(pm.can_use_tool("Write", Some("main.rs")), PermissionDecision::Allow);
    }

    #[test]
    fn test_allow_rules_in_approval_mode() {
        let mut pm = PermissionManager::new(PermissionMode::Approval);
        pm.add_rule(PermissionRule::allow("Bash"));
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Allow);
    }

    #[test]
    fn test_wildcard_allow() {
        let mut pm = PermissionManager::new(PermissionMode::Approval);
        pm.add_rule(PermissionRule::allow("*"));
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Allow);
    }

    #[test]
    fn test_accept_edits_mode() {
        let mut pm = PermissionManager::new(PermissionMode::AcceptEdits);
        assert_eq!(pm.can_use_tool("Read", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Edit", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Ask);
    }

    #[test]
    fn test_ai_safety_decide_mode() {
        let mut pm = PermissionManager::new(PermissionMode::AiSafetyDecide);
        assert_eq!(pm.can_use_tool("Read", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::AiDecide);
    }

    #[test]
    fn test_dont_ask_mode_denies_non_allowed() {
        let mut pm = PermissionManager::new(PermissionMode::DontAsk);
        // Read tools allowed
        assert_eq!(pm.can_use_tool("Read", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Glob", None), PermissionDecision::Allow);
        // Non-read tools denied without explicit allow rule
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Deny);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Deny);
        // But explicitly allowed tools work
        pm.add_rule(PermissionRule::allow("Bash"));
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Allow);
        // Other tools still denied
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Deny);
    }

    #[test]
    fn test_shell_operator_decomposition() {
        let ops = PermissionManager::decompose_shell_operators("echo hello | grep world && rm -rf /");
        assert!(ops.contains(&"|".to_string()));
        assert!(ops.contains(&"&&".to_string()));
    }

    #[test]
    fn test_merge_from_parent() {
        let mut parent = PermissionManager::new(PermissionMode::Approval);
        parent.add_rule(PermissionRule::deny("Bash"));
        let mut child = PermissionManager::new(PermissionMode::Open);
        child.merge_from_parent(&parent);
        // Deny from parent should be inherited
        assert_eq!(child.can_use_tool("Bash", None), PermissionDecision::Deny);
    }

    #[test]
    fn test_trust_levels() {
        assert!(PermissionManager::new(PermissionMode::Readonly).trust_level() < PermissionManager::new(PermissionMode::Open).trust_level());
    }

    #[test]
    fn test_audit_logging() {
        let mut pm = PermissionManager::new(PermissionMode::Open);
        pm.can_use_tool("Bash", Some("ls"));
        assert_eq!(pm.audit_log().len(), 1);
        assert_eq!(pm.audit_log()[0].tool, "Bash");
    }

    #[test]
    fn test_dynamic_rules() {
        let mut pm = PermissionManager::new(PermissionMode::Approval);
        pm.add_dynamic_rule(PermissionRule::allow("Bash"));
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Allow);
        pm.clear_dynamic_rules();
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Ask);
    }

    #[test]
    fn test_custom_check() {
        let mut pm = PermissionManager::new(PermissionMode::Approval);
        pm.set_custom_check(|tool, _| {
            if tool == "Bash" { Some(PermissionDecision::Allow) } else { None }
        });
        assert_eq!(pm.can_use_tool("Bash", None), PermissionDecision::Allow);
        assert_eq!(pm.can_use_tool("Write", None), PermissionDecision::Ask);
    }
}
