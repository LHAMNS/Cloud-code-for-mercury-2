//! Context management for Mercury Code.
//! Token estimation, context compression, and compaction state.

use crate::conversation::{Message, Usage};

/// Compaction state tracks compression history.
#[derive(Debug, Clone)]
pub struct CompactionState {
    pub total_compressions: u32,
    pub total_super_compressions: u32,
    pub last_api_prompt_tokens: Option<u64>,
    pub last_api_completion_tokens: Option<u64>,
    pub aggressive_trim_threshold: f64,
}

pub fn create_compaction_state() -> CompactionState {
    CompactionState {
        total_compressions: 0,
        total_super_compressions: 0,
        last_api_prompt_tokens: None,
        last_api_completion_tokens: None,
        aggressive_trim_threshold: 0.85,
    }
}

pub fn reset_compaction_state(state: &mut CompactionState) {
    state.total_compressions = 0;
    state.total_super_compressions = 0;
    state.last_api_prompt_tokens = None;
    state.last_api_completion_tokens = None;
}

/// Update compaction state with API usage info.
pub fn update_api_usage(usage: &Usage, state: &mut CompactionState) {
    state.last_api_prompt_tokens = usage.prompt_tokens;
    state.last_api_completion_tokens = usage.completion_tokens;
}

/// Estimate tokens from a string using bytes/4 heuristic.
pub fn estimate_tokens(text: &str) -> u64 {
    (text.len() as u64) / 4
}

/// Estimate tokens for a list of messages.
/// Each message has ~4 tokens of overhead (role, formatting).
/// Tool call IDs add ~3 tokens each.
pub fn estimate_messages_tokens(messages: &[Message]) -> u64 {
    let mut total: u64 = 0;
    for msg in messages {
        // Per-message overhead
        total += 4;
        // Content tokens
        if let Some(ref content) = msg.content {
            total += estimate_tokens(content);
        }
        // Tool calls
        if let Some(ref tool_calls) = msg.tool_calls {
            for tc in tool_calls {
                total += 3; // tool call ID overhead
                if let Some(s) = tc.as_str() {
                    total += estimate_tokens(s);
                } else {
                    // Serialize to estimate
                    let serialized = serde_json::to_string(tc).unwrap_or_default();
                    total += estimate_tokens(&serialized);
                }
            }
        }
        // Tool call ID
        if msg.tool_call_id.is_some() {
            total += 3;
        }
    }
    total
}

/// Get context statistics.
pub fn get_context_stats(
    messages: &[Message],
    system_prompt: &str,
    state: &CompactionState,
) -> ContextStats {
    let system_tokens = estimate_tokens(system_prompt) + 4;
    let message_tokens = estimate_messages_tokens(messages);
    let total = system_tokens + message_tokens;

    ContextStats {
        system_tokens,
        message_tokens,
        total_tokens: total,
        message_count: messages.len(),
        compressions: state.total_compressions,
        super_compressions: state.total_super_compressions,
    }
}

#[derive(Debug, Clone)]
pub struct ContextStats {
    pub system_tokens: u64,
    pub message_tokens: u64,
    pub total_tokens: u64,
    pub message_count: usize,
    pub compressions: u32,
    pub super_compressions: u32,
}

/// Compress context by removing old tool results and trimming stale output.
/// Keeps the first and last N messages, summarizes the middle.
pub fn compress_context(
    messages: &mut Vec<Message>,
    _system_prompt: &str,
    state: &mut CompactionState,
) {
    state.total_compressions += 1;

    if messages.len() <= 6 {
        return; // Too few messages to compress
    }

    // Strategy: trim long tool results in older messages
    let keep_recent = 4.min(messages.len());
    let trim_end = messages.len() - keep_recent;

    for msg in messages[..trim_end].iter_mut() {
        if msg.role == "tool" {
            if let Some(ref content) = msg.content {
                if content.len() > 500 {
                    let truncated = format!(
                        "{}...\n[Output truncated during context compression - {} chars removed]",
                        &content[..200],
                        content.len() - 200
                    );
                    msg.content = Some(truncated);
                }
            }
        }
        // Trim long assistant messages
        if msg.role == "assistant" {
            if let Some(ref content) = msg.content {
                if content.len() > 2000 {
                    let truncated = format!(
                        "{}...\n[Response truncated during context compression]",
                        &content[..1000]
                    );
                    msg.content = Some(truncated);
                }
            }
        }
    }

    // Remove consecutive tool result messages if there are too many
    let mut i = 0;
    while i < trim_end && messages.len() > 10 {
        if messages[i].role == "tool" && i + 1 < messages.len() && messages[i + 1].role == "tool" {
            // Check if both are old tool results
            if let Some(ref content) = messages[i].content {
                if content.contains("[Output truncated") {
                    messages.remove(i);
                    continue;
                }
            }
        }
        i += 1;
    }
}

/// Super compress context - more aggressive trimming.
pub fn super_compress_context(
    messages: &mut Vec<Message>,
    system_prompt: &str,
    state: &mut CompactionState,
) {
    state.total_super_compressions += 1;

    // First do normal compression
    compress_context(messages, system_prompt, state);

    if messages.len() <= 4 {
        return;
    }

    // Keep only the last 4 messages + a summary of what came before
    let keep_count = 4.min(messages.len());
    let remove_count = messages.len() - keep_count;

    if remove_count > 0 {
        // Create a summary message
        let summary = format!(
            "[Previous conversation context was compressed. {} messages were summarized to save context space.]",
            remove_count
        );

        // Remove old messages and insert summary
        messages.drain(0..remove_count);
        messages.insert(0, Message::user(&summary));
        messages.insert(
            1,
            Message::assistant("Understood. I'll continue from where we left off."),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1); // 4 bytes / 4
        assert_eq!(estimate_tokens("abcdefgh"), 2); // 8 bytes / 4
    }

    #[test]
    fn test_estimate_messages_tokens() {
        let messages = vec![
            Message::user("hello world"),
            Message::assistant("hi there"),
        ];
        let tokens = estimate_messages_tokens(&messages);
        // Each msg: 4 overhead + content tokens
        assert!(tokens > 8); // At least 4+4 overhead
    }

    #[test]
    fn test_estimate_messages_with_tool_calls() {
        let tc = serde_json::json!({
            "id": "call_1",
            "type": "function",
            "function": {"name": "read", "arguments": "{}"}
        });
        let messages = vec![Message::assistant_with_tool_calls(
            Some("let me check".to_string()),
            vec![tc],
        )];
        let tokens = estimate_messages_tokens(&messages);
        assert!(tokens > 4); // overhead + content + tool call
    }

    #[test]
    fn test_create_compaction_state() {
        let state = create_compaction_state();
        assert_eq!(state.total_compressions, 0);
        assert_eq!(state.total_super_compressions, 0);
        assert!(state.last_api_prompt_tokens.is_none());
    }

    #[test]
    fn test_reset_compaction_state() {
        let mut state = create_compaction_state();
        state.total_compressions = 5;
        reset_compaction_state(&mut state);
        assert_eq!(state.total_compressions, 0);
    }

    #[test]
    fn test_compress_context_short() {
        let mut messages = vec![
            Message::user("hello"),
            Message::assistant("hi"),
        ];
        let mut state = create_compaction_state();
        compress_context(&mut messages, "sys", &mut state);
        assert_eq!(messages.len(), 2); // Too short to compress
        assert_eq!(state.total_compressions, 1);
    }

    #[test]
    fn test_compress_context_trims_tool_output() {
        let long_output = "x".repeat(1000);
        let mut messages = vec![
            Message::user("do something"),
            Message::assistant("ok"),
            Message::tool_result("c1", &long_output),
            Message::assistant("done"),
            Message::user("next"),
            Message::assistant("ok"),
            Message::user("more"),
        ];
        let mut state = create_compaction_state();
        compress_context(&mut messages, "sys", &mut state);
        // The tool result should be truncated
        let tool_msg = messages.iter().find(|m| m.role == "tool").unwrap();
        let content = tool_msg.content.as_deref().unwrap();
        assert!(content.len() < 1000);
        assert!(content.contains("truncated"));
    }

    #[test]
    fn test_super_compress() {
        let mut messages: Vec<Message> = (0..20)
            .flat_map(|i| {
                vec![
                    Message::user(&format!("question {}", i)),
                    Message::assistant(&format!("answer {}", i)),
                ]
            })
            .collect();
        let mut state = create_compaction_state();
        super_compress_context(&mut messages, "sys", &mut state);
        assert!(messages.len() <= 10); // Significantly reduced
        assert_eq!(state.total_super_compressions, 1);
    }

    #[test]
    fn test_get_context_stats() {
        let messages = vec![
            Message::user("hello"),
            Message::assistant("world"),
        ];
        let state = create_compaction_state();
        let stats = get_context_stats(&messages, "system prompt", &state);
        assert!(stats.total_tokens > 0);
        assert_eq!(stats.message_count, 2);
        assert_eq!(stats.compressions, 0);
    }

    #[test]
    fn test_update_api_usage() {
        let mut state = create_compaction_state();
        let usage = Usage {
            prompt_tokens: Some(500),
            completion_tokens: Some(200),
            total_tokens: Some(700),
        };
        update_api_usage(&usage, &mut state);
        assert_eq!(state.last_api_prompt_tokens, Some(500));
        assert_eq!(state.last_api_completion_tokens, Some(200));
    }
}
