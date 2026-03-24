pub mod config;
pub mod errors;
pub mod providers;
pub mod client;
pub mod memory;
pub mod conversation;
pub mod context;

// Re-export commonly used types
pub use config::{ClientConfig, ClientConfigOverrides, ModelLimits, MERCURY_MODEL, REASONING_LEVELS, DEFAULT_CONFIG, MODEL_LIMITS};
pub use errors::MercuryError;
pub use providers::{Provider, get_provider, get_default_provider, list_providers, list_providers_detailed, get_provider_for_model, get_model_limits};
pub use client::MercuryClient;
pub use conversation::Conversation;
pub use memory::{MemoryManager, ConversationLog};
pub use context::{estimate_tokens, estimate_messages_tokens, compress_context, super_compress_context};
