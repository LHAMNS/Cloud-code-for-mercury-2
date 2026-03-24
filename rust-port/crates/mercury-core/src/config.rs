// Mercury Code - Configuration
// Provider-aware configuration with multi-model support.

use serde::{Deserialize, Serialize};
use std::env;

use crate::providers::{get_model_limits, get_provider, get_provider_api_key};

/// Default Mercury API base URL.
pub const MERCURY_API_BASE: &str = "https://api.inceptionlabs.ai/v1";

/// Default Mercury model identifier.
pub const MERCURY_MODEL: &str = "mercury-2";

/// Valid reasoning effort levels.
pub const REASONING_LEVELS: &[&str] = &["instant", "low", "medium", "high"];

/// Default client configuration values.
pub const DEFAULT_MAX_TOKENS: u32 = 50000;
pub const DEFAULT_TEMPERATURE: f64 = 0.75;
pub const DEFAULT_REASONING_EFFORT: &str = "medium";
pub const DEFAULT_REASONING_SUMMARY: bool = true;
pub const DEFAULT_STREAM: bool = true;
pub const DEFAULT_DIFFUSING: bool = false;

/// Model limits for the default Mercury-2 model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLimits {
    pub max_context_tokens: u32,
    pub max_output_tokens: u32,
    pub temperature_range: (f64, f64),
    pub max_stop_sequences: u32,
}

impl Default for ModelLimits {
    fn default() -> Self {
        Self {
            max_context_tokens: 128_000,
            max_output_tokens: 50_000,
            temperature_range: (0.5, 1.0),
            max_stop_sequences: 4,
        }
    }
}

/// Static default model limits.
pub static MODEL_LIMITS: once_cell::sync::Lazy<ModelLimits> =
    once_cell::sync::Lazy::new(ModelLimits::default);

/// Static default client configuration.
pub static DEFAULT_CONFIG: once_cell::sync::Lazy<ClientConfig> =
    once_cell::sync::Lazy::new(ClientConfig::default);

/// Client configuration for API requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub model: String,
    pub max_tokens: u32,
    pub temperature: f64,
    pub reasoning_effort: String,
    pub reasoning_summary: bool,
    pub stream: bool,
    pub diffusing: bool,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            model: MERCURY_MODEL.to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            temperature: DEFAULT_TEMPERATURE,
            reasoning_effort: DEFAULT_REASONING_EFFORT.to_string(),
            reasoning_summary: DEFAULT_REASONING_SUMMARY,
            stream: DEFAULT_STREAM,
            diffusing: DEFAULT_DIFFUSING,
        }
    }
}

/// Partial configuration used for overrides when normalizing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientConfigOverrides {
    pub model: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub reasoning_summary: Option<bool>,
    pub stream: Option<bool>,
    pub diffusing: Option<bool>,
}

/// Normalize client configuration, optionally scoped to a provider.
/// When a `provider_name` is given, uses that provider's model limits.
pub fn normalize_client_config(
    overrides: &ClientConfigOverrides,
    provider_name: Option<&str>,
) -> ClientConfig {
    let defaults = ClientConfig::default();
    let model_limits = ModelLimits::default();

    // When a provider is specified, use its default model instead of the global default.
    let default_model = if let Some(pn) = provider_name {
        get_provider(pn)
            .map(|p| p.default_model.clone())
            .unwrap_or_else(|| defaults.model.clone())
    } else {
        defaults.model.clone()
    };

    let mut config = ClientConfig {
        model: overrides
            .model
            .clone()
            .unwrap_or(default_model),
        max_tokens: overrides.max_tokens.unwrap_or(defaults.max_tokens),
        temperature: overrides.temperature.unwrap_or(defaults.temperature),
        reasoning_effort: overrides
            .reasoning_effort
            .clone()
            .unwrap_or_else(|| defaults.reasoning_effort.clone()),
        reasoning_summary: overrides
            .reasoning_summary
            .unwrap_or(defaults.reasoning_summary),
        stream: overrides.stream.unwrap_or(defaults.stream),
        diffusing: overrides.diffusing.unwrap_or(defaults.diffusing),
    };

    // Determine effective limits based on provider + model
    let (max_output, temp_range, _max_context) = if let Some(pn) = provider_name {
        let ml = get_model_limits(pn, &config.model);
        (ml.max_output, ml.temp_range, ml.max_context)
    } else {
        (
            model_limits.max_output_tokens,
            model_limits.temperature_range,
            model_limits.max_context_tokens,
        )
    };

    // Validate reasoning_effort
    if !REASONING_LEVELS.contains(&config.reasoning_effort.as_str()) {
        config.reasoning_effort = DEFAULT_REASONING_EFFORT.to_string();
    }

    // Validate and clamp temperature
    if config.temperature.is_nan() {
        config.temperature = DEFAULT_TEMPERATURE;
    }
    config.temperature = config.temperature.clamp(temp_range.0, temp_range.1);

    // Validate and clamp max_tokens
    if config.max_tokens == 0 {
        config.max_tokens = defaults.max_tokens.min(max_output);
    }
    config.max_tokens = config.max_tokens.min(max_output);

    config
}

/// Get API key -- provider-aware.
/// If `provider_name` is given, reads the provider's env var.
/// Falls back to `INCEPTION_API_KEY` for backward compatibility.
pub fn get_api_key(provider_name: Option<&str>) -> Option<String> {
    if let Some(pn) = provider_name {
        if let Some(key) = get_provider_api_key(pn) {
            return Some(key);
        }
    }
    // Backward-compatible fallback
    env::var("INCEPTION_API_KEY").ok()
}

/// Get the Mercury API base URL from environment or use default.
pub fn get_api_base() -> String {
    env::var("MERCURY_API_BASE").unwrap_or_else(|_| MERCURY_API_BASE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ClientConfig::default();
        assert_eq!(config.model, "mercury-2");
        assert_eq!(config.max_tokens, 50000);
        assert!((config.temperature - 0.75).abs() < f64::EPSILON);
        assert_eq!(config.reasoning_effort, "medium");
        assert!(config.reasoning_summary);
        assert!(config.stream);
        assert!(!config.diffusing);
    }

    #[test]
    fn test_normalize_clamps_temperature() {
        let overrides = ClientConfigOverrides {
            temperature: Some(5.0),
            ..Default::default()
        };
        let config = normalize_client_config(&overrides, None);
        // Default model limits temp range is (0.5, 1.0)
        assert!((config.temperature - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_normalize_clamps_temperature_low() {
        let overrides = ClientConfigOverrides {
            temperature: Some(0.0),
            ..Default::default()
        };
        let config = normalize_client_config(&overrides, None);
        assert!((config.temperature - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn test_normalize_invalid_reasoning_effort() {
        let overrides = ClientConfigOverrides {
            reasoning_effort: Some("invalid".to_string()),
            ..Default::default()
        };
        let config = normalize_client_config(&overrides, None);
        assert_eq!(config.reasoning_effort, "medium");
    }

    #[test]
    fn test_normalize_valid_reasoning_effort() {
        let overrides = ClientConfigOverrides {
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let config = normalize_client_config(&overrides, None);
        assert_eq!(config.reasoning_effort, "high");
    }

    #[test]
    fn test_normalize_clamps_max_tokens() {
        let overrides = ClientConfigOverrides {
            max_tokens: Some(999_999),
            ..Default::default()
        };
        let config = normalize_client_config(&overrides, None);
        // Should be clamped to model limits max_output_tokens (50000)
        assert_eq!(config.max_tokens, 50000);
    }

    #[test]
    fn test_normalize_zero_max_tokens_uses_default() {
        let overrides = ClientConfigOverrides {
            max_tokens: Some(0),
            ..Default::default()
        };
        let config = normalize_client_config(&overrides, None);
        assert_eq!(config.max_tokens, 50000);
    }

    #[test]
    fn test_model_limits_default() {
        let limits = ModelLimits::default();
        assert_eq!(limits.max_context_tokens, 128_000);
        assert_eq!(limits.max_output_tokens, 50_000);
        assert_eq!(limits.temperature_range, (0.5, 1.0));
        assert_eq!(limits.max_stop_sequences, 4);
    }

    #[test]
    fn test_get_api_key_fallback() {
        // Without any env var set, should return None
        // (INCEPTION_API_KEY unlikely to be set in test env)
        let key = get_api_key(None);
        // Just ensure it doesn't panic
        let _ = key;
    }
}
