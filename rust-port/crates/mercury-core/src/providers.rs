// Mercury Code - Provider Registry
// Manages multiple AI API providers (Mercury-2, OpenAI, etc.)
// Each provider defines: baseURL, API key env var, model catalog, and capabilities.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::sync::RwLock;

use crate::errors::MercuryError;

// ── Data types ──────────────────────────────────────────────────────────────

/// Model specification within a provider's catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSpec {
    pub max_context: u32,
    pub max_output: u32,
    pub temp_range: (f64, f64),
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub reasoning_model: bool,
}

/// Provider definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub name: String,
    pub display_name: String,
    pub base_url: String,
    pub env_key: String,
    pub default_model: String,
    pub models: HashMap<String, ModelSpec>,
    pub supports_reasoning: bool,
    pub supports_diffusing: bool,
    pub supports_reasoning_summary: bool,
}

/// Model limits returned by `get_model_limits`.
#[derive(Debug, Clone)]
pub struct ModelLimitsInfo {
    pub max_context: u32,
    pub max_output: u32,
    pub temp_range: (f64, f64),
}

/// Detailed provider info for listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderDetail {
    pub name: String,
    pub display_name: String,
    pub default_model: String,
    pub models: Vec<ModelDetail>,
}

/// Detailed model info for listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDetail {
    pub id: String,
    pub description: String,
    pub max_context: u32,
    pub max_output: u32,
}

// ── Static provider registry ────────────────────────────────────────────────

static PROVIDERS: Lazy<RwLock<HashMap<String, Provider>>> = Lazy::new(|| {
    let mut map = HashMap::new();

    // Mercury provider
    let mut mercury_models = HashMap::new();
    mercury_models.insert(
        "mercury-2".to_string(),
        ModelSpec {
            max_context: 128_000,
            max_output: 50_000,
            temp_range: (0.5, 1.0),
            description: "Mercury-2 diffusion model".to_string(),
            reasoning_model: false,
        },
    );
    map.insert(
        "mercury".to_string(),
        Provider {
            name: "mercury".to_string(),
            display_name: "Mercury-2 (Inception Labs)".to_string(),
            base_url: "https://api.inceptionlabs.ai/v1".to_string(),
            env_key: "INCEPTION_API_KEY".to_string(),
            default_model: "mercury-2".to_string(),
            models: mercury_models,
            supports_reasoning: true,
            supports_diffusing: true,
            supports_reasoning_summary: true,
        },
    );

    // OpenAI provider
    let mut openai_models = HashMap::new();
    openai_models.insert(
        "gpt-4o".to_string(),
        ModelSpec {
            max_context: 128_000,
            max_output: 16_384,
            temp_range: (0.0, 2.0),
            description: "GPT-4o — flagship multimodal model".to_string(),
            reasoning_model: false,
        },
    );
    openai_models.insert(
        "gpt-4o-mini".to_string(),
        ModelSpec {
            max_context: 128_000,
            max_output: 16_384,
            temp_range: (0.0, 2.0),
            description: "GPT-4o mini — cost-effective".to_string(),
            reasoning_model: false,
        },
    );
    openai_models.insert(
        "gpt-4.1".to_string(),
        ModelSpec {
            max_context: 1_047_576,
            max_output: 32_768,
            temp_range: (0.0, 2.0),
            description: "GPT-4.1 — long-context coding model".to_string(),
            reasoning_model: false,
        },
    );
    openai_models.insert(
        "gpt-4.1-mini".to_string(),
        ModelSpec {
            max_context: 1_047_576,
            max_output: 32_768,
            temp_range: (0.0, 2.0),
            description: "GPT-4.1 mini — fast + long context".to_string(),
            reasoning_model: false,
        },
    );
    openai_models.insert(
        "gpt-4.1-nano".to_string(),
        ModelSpec {
            max_context: 1_047_576,
            max_output: 32_768,
            temp_range: (0.0, 2.0),
            description: "GPT-4.1 nano — ultrafast + cheapest".to_string(),
            reasoning_model: false,
        },
    );
    openai_models.insert(
        "o3".to_string(),
        ModelSpec {
            max_context: 200_000,
            max_output: 100_000,
            temp_range: (1.0, 1.0),
            description: "o3 — advanced reasoning model".to_string(),
            reasoning_model: true,
        },
    );
    openai_models.insert(
        "o4-mini".to_string(),
        ModelSpec {
            max_context: 200_000,
            max_output: 100_000,
            temp_range: (1.0, 1.0),
            description: "o4-mini — fast reasoning model".to_string(),
            reasoning_model: true,
        },
    );
    openai_models.insert(
        "gpt-4-turbo".to_string(),
        ModelSpec {
            max_context: 128_000,
            max_output: 4_096,
            temp_range: (0.0, 2.0),
            description: "GPT-4 Turbo — legacy high-intelligence".to_string(),
            reasoning_model: false,
        },
    );
    openai_models.insert(
        "gpt-3.5-turbo".to_string(),
        ModelSpec {
            max_context: 16_384,
            max_output: 4_096,
            temp_range: (0.0, 2.0),
            description: "GPT-3.5 Turbo — fast & budget".to_string(),
            reasoning_model: false,
        },
    );
    map.insert(
        "openai".to_string(),
        Provider {
            name: "openai".to_string(),
            display_name: "OpenAI (ChatGPT)".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            default_model: "gpt-4o".to_string(),
            models: openai_models,
            supports_reasoning: false,
            supports_diffusing: false,
            supports_reasoning_summary: false,
        },
    );

    RwLock::new(map)
});

// ── Public API ──────────────────────────────────────────────────────────────

/// Get a provider definition by name.
pub fn get_provider(name: &str) -> Option<Provider> {
    let registry = PROVIDERS.read().unwrap();
    registry.get(name).cloned()
}

/// Get the default (Mercury) provider.
pub fn get_default_provider() -> Provider {
    let registry = PROVIDERS.read().unwrap();
    registry
        .get("mercury")
        .cloned()
        .expect("Mercury provider must always exist")
}

/// List all registered provider names.
pub fn list_providers() -> Vec<String> {
    let registry = PROVIDERS.read().unwrap();
    registry.keys().cloned().collect()
}

/// List all providers with their display names and available models.
pub fn list_providers_detailed() -> Vec<ProviderDetail> {
    let registry = PROVIDERS.read().unwrap();
    registry
        .values()
        .map(|p| ProviderDetail {
            name: p.name.clone(),
            display_name: p.display_name.clone(),
            default_model: p.default_model.clone(),
            models: p
                .models
                .iter()
                .map(|(id, info)| ModelDetail {
                    id: id.clone(),
                    description: if info.description.is_empty() {
                        id.clone()
                    } else {
                        info.description.clone()
                    },
                    max_context: info.max_context,
                    max_output: info.max_output,
                })
                .collect(),
        })
        .collect()
}

/// Determine which provider a model belongs to.
/// Searches all providers for the model name.
pub fn get_provider_for_model(model_name: &str) -> Option<Provider> {
    let registry = PROVIDERS.read().unwrap();
    for provider in registry.values() {
        if provider.models.contains_key(model_name) {
            return Some(provider.clone());
        }
    }
    None
}

/// Get model limits for a specific model within a provider.
/// Returns default limits if the model is not found in the catalog.
pub fn get_model_limits(provider_name: &str, model_name: &str) -> ModelLimitsInfo {
    let registry = PROVIDERS.read().unwrap();
    let fallback = ModelLimitsInfo {
        max_context: 128_000,
        max_output: 16_384,
        temp_range: (0.0, 2.0),
    };

    let provider = match registry.get(provider_name) {
        Some(p) => p,
        None => return fallback,
    };

    match provider.models.get(model_name) {
        Some(model) => ModelLimitsInfo {
            max_context: model.max_context,
            max_output: model.max_output,
            temp_range: model.temp_range,
        },
        None => fallback,
    }
}

/// Get the API key for a provider from environment variables.
pub fn get_provider_api_key(provider_name: &str) -> Option<String> {
    let registry = PROVIDERS.read().unwrap();
    let provider = registry.get(provider_name)?;
    env::var(&provider.env_key).ok()
}

/// Register a custom provider at runtime.
/// Allows users to add their own OpenAI-compatible endpoints.
pub fn register_provider(provider_def: Provider) -> Result<(), MercuryError> {
    if provider_def.name.is_empty() || provider_def.base_url.is_empty() {
        return Err(MercuryError::Config(
            "Provider must have a name and base_url".to_string(),
        ));
    }

    let mut registry = PROVIDERS.write().unwrap();

    // Apply defaults for missing fields while preserving the explicit values
    let provider = Provider {
        display_name: if provider_def.display_name.is_empty() {
            provider_def.name.clone()
        } else {
            provider_def.display_name
        },
        env_key: if provider_def.env_key.is_empty() {
            format!("{}_API_KEY", provider_def.name.to_uppercase())
        } else {
            provider_def.env_key
        },
        default_model: if provider_def.default_model.is_empty() {
            "default".to_string()
        } else {
            provider_def.default_model
        },
        ..provider_def
    };

    registry.insert(provider.name.clone(), provider);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_mercury_provider() {
        let provider = get_provider("mercury").expect("Mercury provider should exist");
        assert_eq!(provider.name, "mercury");
        assert_eq!(provider.default_model, "mercury-2");
        assert!(provider.supports_reasoning);
        assert!(provider.supports_diffusing);
        assert!(provider.supports_reasoning_summary);
    }

    #[test]
    fn test_get_openai_provider() {
        let provider = get_provider("openai").expect("OpenAI provider should exist");
        assert_eq!(provider.name, "openai");
        assert_eq!(provider.default_model, "gpt-4o");
        assert!(!provider.supports_reasoning);
        assert!(!provider.supports_diffusing);
    }

    #[test]
    fn test_get_unknown_provider() {
        assert!(get_provider("nonexistent").is_none());
    }

    #[test]
    fn test_get_default_provider() {
        let provider = get_default_provider();
        assert_eq!(provider.name, "mercury");
    }

    #[test]
    fn test_list_providers() {
        let names = list_providers();
        assert!(names.contains(&"mercury".to_string()));
        assert!(names.contains(&"openai".to_string()));
    }

    #[test]
    fn test_list_providers_detailed() {
        let details = list_providers_detailed();
        assert!(details.len() >= 2);
    }

    #[test]
    fn test_get_provider_for_model() {
        let provider = get_provider_for_model("mercury-2").expect("Should find Mercury provider");
        assert_eq!(provider.name, "mercury");

        let provider = get_provider_for_model("gpt-4o").expect("Should find OpenAI provider");
        assert_eq!(provider.name, "openai");

        assert!(get_provider_for_model("nonexistent-model").is_none());
    }

    #[test]
    fn test_get_model_limits_known() {
        let limits = get_model_limits("mercury", "mercury-2");
        assert_eq!(limits.max_context, 128_000);
        assert_eq!(limits.max_output, 50_000);
        assert_eq!(limits.temp_range, (0.5, 1.0));
    }

    #[test]
    fn test_get_model_limits_unknown_model() {
        let limits = get_model_limits("mercury", "nonexistent");
        // Should return fallback
        assert_eq!(limits.max_context, 128_000);
        assert_eq!(limits.max_output, 16_384);
    }

    #[test]
    fn test_get_model_limits_unknown_provider() {
        let limits = get_model_limits("nonexistent", "whatever");
        assert_eq!(limits.max_context, 128_000);
        assert_eq!(limits.max_output, 16_384);
    }

    #[test]
    fn test_register_provider() {
        let custom = Provider {
            name: "custom_test_provider".to_string(),
            display_name: String::new(), // will get defaulted
            base_url: "https://custom.example.com/v1".to_string(),
            env_key: String::new(), // will get defaulted
            default_model: "custom-model".to_string(),
            models: HashMap::new(),
            supports_reasoning: false,
            supports_diffusing: false,
            supports_reasoning_summary: false,
        };
        register_provider(custom).expect("Should register successfully");

        let provider =
            get_provider("custom_test_provider").expect("Custom provider should exist");
        assert_eq!(provider.display_name, "custom_test_provider");
        assert_eq!(provider.env_key, "CUSTOM_TEST_PROVIDER_API_KEY");
    }

    #[test]
    fn test_register_provider_missing_name() {
        let bad = Provider {
            name: String::new(),
            display_name: String::new(),
            base_url: "https://example.com".to_string(),
            env_key: String::new(),
            default_model: String::new(),
            models: HashMap::new(),
            supports_reasoning: false,
            supports_diffusing: false,
            supports_reasoning_summary: false,
        };
        assert!(register_provider(bad).is_err());
    }
}
