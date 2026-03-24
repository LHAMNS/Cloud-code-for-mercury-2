// Mercury Code - Debug Logging Utility
// Logs only when MERCURY_DEBUG or DEBUG env var is set.
// Ported from: src/utils/debug-log.js

use once_cell::sync::Lazy;
use std::env;
use std::io::Write;

/// Whether debug logging is enabled (checked once at startup).
static DEBUG_ENABLED: Lazy<bool> = Lazy::new(|| {
    env::var("MERCURY_DEBUG").is_ok() || env::var("DEBUG").is_ok()
});

/// Log a debug message to stderr if debug mode is enabled.
/// Includes the context label and error information.
///
/// # Arguments
/// * `context` - A label identifying where the log originates (e.g., "HooksManager.load")
/// * `err` - The error or message to log
pub fn debug_log(context: &str, err: &dyn std::fmt::Display) {
    if *DEBUG_ENABLED {
        let _ = writeln!(
            std::io::stderr(),
            "[mercury:debug] {}: {}",
            context,
            err
        );
    }
}

/// Log a debug message with an optional error's debug representation.
pub fn debug_log_err(context: &str, err: &dyn std::error::Error) {
    if *DEBUG_ENABLED {
        let source = err
            .source()
            .map(|s| format!("\n  caused by: {}", s))
            .unwrap_or_default();
        let _ = writeln!(
            std::io::stderr(),
            "[mercury:debug] {}: {}{}",
            context,
            err,
            source
        );
    }
}

/// Check if debug logging is enabled.
pub fn is_debug_enabled() -> bool {
    *DEBUG_ENABLED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_debug_enabled_returns_bool() {
        // Just ensure it doesn't panic
        let _ = is_debug_enabled();
    }

    #[test]
    fn test_debug_log_does_not_panic() {
        debug_log("test_context", &"test message");
    }

    #[test]
    fn test_debug_log_err_does_not_panic() {
        let err = std::io::Error::new(std::io::ErrorKind::Other, "test error");
        debug_log_err("test_context", &err);
    }
}
