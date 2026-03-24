// Mercury Code CLI - Utility modules

pub mod debug_log;
pub mod env_sanitize;
pub mod fence;

// Re-export commonly used items
pub use debug_log::{debug_log, debug_log_err, is_debug_enabled};
pub use env_sanitize::{is_sensitive_env_key, sanitize_env};
pub use fence::{create_fence_markers, escape_fence_content, FenceMarkers};
