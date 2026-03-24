// Mercury Code - API Client
// Handles communication with AI providers (Mercury-2, OpenAI, etc.) via OpenAI-compatible API

use std::pin::Pin;
use std::time::Duration;

use futures::stream::Stream;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;
use url::Url;

use crate::config::{
    get_api_base, get_api_key, normalize_client_config, ClientConfig, ClientConfigOverrides,
};
use crate::errors::MercuryError;
use crate::providers::{get_default_provider, get_provider, Provider};

// ── Retry configuration ─────────────────────────────────────────────────────

const MAX_RETRIES: u32 = 3;
const BASE_DELAY_MS: u64 = 1000;
const REQUEST_TIMEOUT_SECS: u64 = 120;

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn is_loopback_host(hostname: &str) -> bool {
    hostname == "localhost"
        || hostname == "127.0.0.1"
        || hostname == "::1"
        || hostname == "[::1]"
}

// ── Request/response types ──────────────────────────────────────────────────

/// Options for individual API requests (overrides per-call).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestOptions {
    pub model: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub reasoning_summary: Option<bool>,
    pub stop: Option<Vec<String>>,
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    pub diffusing: Option<bool>,
}

/// A chat message in the OpenAI format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Options for constructing a MercuryClient.
#[derive(Debug, Clone, Default)]
pub struct MercuryClientOptions {
    pub provider: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub allow_insecure_http: bool,
    pub config_overrides: ClientConfigOverrides,
}

/// Options for switching providers at runtime.
#[derive(Debug, Clone, Default)]
pub struct SwitchProviderOptions {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

// ── MercuryClient ───────────────────────────────────────────────────────────

/// HTTP client for communicating with AI providers.
pub struct MercuryClient {
    provider_name: String,
    provider: Provider,
    explicit_api_key: Option<String>,
    base_url: String,
    pub config: ClientConfig,
    http_client: Client,
    http_warned: bool,
    allow_insecure_http: bool,
}

impl MercuryClient {
    /// Create a new MercuryClient with the given options.
    pub fn new(options: MercuryClientOptions) -> Result<Self, MercuryError> {
        let provider_name = options.provider.unwrap_or_else(|| "mercury".to_string());
        let provider = get_provider(&provider_name).unwrap_or_else(get_default_provider);
        let base_url = options
            .base_url
            .unwrap_or_else(|| provider.base_url.clone());
        let base_url = if base_url.is_empty() {
            get_api_base()
        } else {
            base_url
        };

        let config = normalize_client_config(&options.config_overrides, Some(&provider_name));

        let http_client = Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| MercuryError::Client(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            provider_name,
            provider,
            explicit_api_key: options.api_key,
            base_url,
            config,
            http_client,
            http_warned: false,
            allow_insecure_http: options.allow_insecure_http,
        })
    }

    /// Get the current provider name.
    pub fn provider_name(&self) -> &str {
        &self.provider_name
    }

    /// Get the current provider definition.
    pub fn provider(&self) -> &Provider {
        &self.provider
    }

    /// Get the base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Switch to a different provider at runtime.
    pub fn switch_provider(
        &mut self,
        provider_name: &str,
        opts: SwitchProviderOptions,
    ) -> Result<(), MercuryError> {
        let provider = get_provider(provider_name)
            .ok_or_else(|| MercuryError::Config(format!("Unknown provider: {}", provider_name)))?;

        self.provider_name = provider_name.to_string();
        self.base_url = opts.base_url.unwrap_or_else(|| {
            if provider.base_url.is_empty() {
                std::env::var("MERCURY_API_BASE")
                    .unwrap_or_else(|_| "https://api.inceptionlabs.ai/v1".to_string())
            } else {
                provider.base_url.clone()
            }
        });
        self.provider = provider;

        if let Some(key) = opts.api_key {
            self.explicit_api_key = Some(key);
        }

        let model = opts
            .model
            .unwrap_or_else(|| self.provider.default_model.clone());

        let overrides = ClientConfigOverrides {
            model: Some(model),
            max_tokens: Some(self.config.max_tokens),
            temperature: Some(self.config.temperature),
            reasoning_effort: Some(self.config.reasoning_effort.clone()),
            reasoning_summary: Some(self.config.reasoning_summary),
            stream: Some(self.config.stream),
            diffusing: Some(self.config.diffusing),
        };
        self.config = normalize_client_config(&overrides, Some(provider_name));
        Ok(())
    }

    /// Get the API key -- prefer explicitly-set key, fall back to env var.
    pub fn api_key(&self) -> Option<String> {
        self.explicit_api_key
            .clone()
            .or_else(|| get_api_key(Some(&self.provider_name)))
    }

    /// Set the API key explicitly.
    pub fn set_api_key(&mut self, key: Option<String>) {
        self.explicit_api_key = key;
    }

    /// Reject plain-HTTP requests that carry an API key (unless opted in).
    fn warn_if_insecure(&mut self) -> Result<(), MercuryError> {
        if self.http_warned {
            return Ok(());
        }

        if let Ok(parsed) = Url::parse(&self.base_url) {
            if parsed.scheme() == "http" && self.api_key().is_some() {
                if let Some(host) = parsed.host_str() {
                    if is_loopback_host(host) {
                        return Ok(());
                    }
                }

                if self.allow_insecure_http
                    || std::env::var("MERCURY_ALLOW_HTTP")
                        .map(|v| v == "1")
                        .unwrap_or(false)
                {
                    warn!(
                        "API key is being sent over plain HTTP. \
                         Use HTTPS to protect credentials in transit."
                    );
                    self.http_warned = true;
                    return Ok(());
                }

                return Err(MercuryError::Security(
                    "Refusing to send API key over plain HTTP. \
                     Use HTTPS or set MERCURY_ALLOW_HTTP=1 to override."
                        .to_string(),
                ));
            }
        }

        Ok(())
    }

    /// Send a non-streaming chat completion request (with automatic retry).
    pub async fn chat_completion(
        &mut self,
        messages: &[ChatMessage],
        options: &RequestOptions,
    ) -> Result<Value, MercuryError> {
        self.warn_if_insecure()?;
        let mut body = self.build_request_body(messages, options);
        body["stream"] = Value::Bool(false);
        self.fetch_with_retry("/chat/completions", &body).await
    }

    /// Send a streaming chat completion request.
    /// Returns a Stream of parsed JSON chunks.
    pub async fn chat_completion_stream(
        &mut self,
        messages: &[ChatMessage],
        options: &RequestOptions,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value, MercuryError>> + Send>>, MercuryError> {
        self.warn_if_insecure()?;
        let mut body = self.build_request_body(messages, options);
        body["stream"] = Value::Bool(true);
        body["stream_options"] = serde_json::json!({ "include_usage": true });

        let url = self.build_url("/chat/completions")?;
        let api_key = self
            .api_key()
            .ok_or_else(|| MercuryError::Auth("No API key available".to_string()))?;

        // Connection-phase retry
        let mut last_error: Option<MercuryError> = None;

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = BASE_DELAY_MS * 2u64.pow(attempt - 1)
                    + (rand_jitter_ms() as u64);
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }

            let result = self
                .http_client
                .post(url.clone())
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", api_key))
                .body(serde_json::to_string(&body).unwrap_or_default())
                .send()
                .await;

            let response = match result {
                Ok(resp) => resp,
                Err(e) => {
                    if attempt < MAX_RETRIES && is_retryable_reqwest_error(&e) {
                        last_error = Some(MercuryError::Network(e.to_string()));
                        continue;
                    }
                    return Err(MercuryError::Network(e.to_string()));
                }
            };

            let status = response.status();
            if status != StatusCode::OK {
                if attempt < MAX_RETRIES && is_retryable_status(status) {
                    let body_text = response.text().await.unwrap_or_default();
                    last_error = Some(MercuryError::Api {
                        status: status.as_u16(),
                        body: body_text,
                    });
                    continue;
                }
                let body_text = response.text().await.unwrap_or_default();
                return Err(MercuryError::Api {
                    status: status.as_u16(),
                    body: body_text,
                });
            }

            // Success - set up SSE stream
            let byte_stream = response.bytes_stream();
            let stream = sse_stream(byte_stream);
            return Ok(Box::pin(stream));
        }

        Err(last_error.unwrap_or_else(|| {
            MercuryError::Client("All retries exhausted".to_string())
        }))
    }

    /// Build the request body for the API.
    fn build_request_body(&self, messages: &[ChatMessage], options: &RequestOptions) -> Value {
        // Sanitize messages
        let sanitized: Vec<Value> = messages
            .iter()
            .map(|msg| {
                let mut m = serde_json::to_value(msg).unwrap_or(Value::Null);
                if let Value::Object(ref mut map) = m {
                    // Assistant messages with tool_calls can have null content
                    let has_tool_calls = map.get("tool_calls").is_some();
                    let is_assistant = map
                        .get("role")
                        .and_then(|r| r.as_str())
                        .map(|r| r == "assistant")
                        .unwrap_or(false);

                    if !(is_assistant && has_tool_calls) {
                        if map.get("content").map(|v| v.is_null()).unwrap_or(true) {
                            map.insert("content".to_string(), Value::String(String::new()));
                        }
                    }
                }
                m
            })
            .collect();

        let model = options
            .model
            .as_deref()
            .unwrap_or(&self.config.model)
            .to_string();

        let max_tokens = options.max_tokens.unwrap_or(self.config.max_tokens);
        let temperature = options.temperature.unwrap_or(self.config.temperature);

        let mut body = serde_json::json!({
            "model": model,
            "messages": sanitized,
            "max_tokens": max_tokens,
            "temperature": temperature,
        });

        let body_map = body.as_object_mut().unwrap();

        // Provider-specific fields
        if self.provider.supports_reasoning {
            let effort = options
                .reasoning_effort
                .as_deref()
                .unwrap_or(&self.config.reasoning_effort);
            body_map.insert(
                "reasoning_effort".to_string(),
                Value::String(effort.to_string()),
            );
        }

        if self.provider.supports_reasoning_summary {
            let summary = options
                .reasoning_summary
                .unwrap_or(self.config.reasoning_summary);
            body_map.insert("reasoning_summary".to_string(), Value::Bool(summary));
        }

        if let Some(ref stop) = options.stop {
            body_map.insert("stop".to_string(), serde_json::to_value(stop).unwrap());
        }

        if let Some(ref tools) = options.tools {
            if !tools.is_empty() {
                body_map.insert("tools".to_string(), Value::Array(tools.clone()));
            }
        }

        if let Some(ref tool_choice) = options.tool_choice {
            body_map.insert("tool_choice".to_string(), tool_choice.clone());
        }

        // Diffusing is Mercury-specific
        if self.provider.supports_diffusing && options.diffusing.unwrap_or(false) {
            body_map.insert("diffusing".to_string(), Value::Bool(true));
            body_map.insert("stream".to_string(), Value::Bool(true));
        }

        body
    }

    /// Build the full URL for an endpoint.
    fn build_url(&self, endpoint: &str) -> Result<String, MercuryError> {
        let base = self.base_url.trim_end_matches('/');
        Ok(format!("{}{}", base, endpoint))
    }

    /// Make a non-streaming POST request with retry.
    async fn fetch_with_retry(
        &self,
        endpoint: &str,
        body: &Value,
    ) -> Result<Value, MercuryError> {
        let url = self.build_url(endpoint)?;
        let api_key = self
            .api_key()
            .ok_or_else(|| MercuryError::Auth("No API key available".to_string()))?;

        let mut last_error: Option<MercuryError> = None;

        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                let delay = BASE_DELAY_MS * 2u64.pow(attempt - 1)
                    + (rand_jitter_ms() as u64);
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }

            let result = self
                .http_client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", api_key))
                .json(body)
                .send()
                .await;

            let response = match result {
                Ok(resp) => resp,
                Err(e) => {
                    if attempt < MAX_RETRIES && is_retryable_reqwest_error(&e) {
                        last_error = Some(MercuryError::Network(e.to_string()));
                        continue;
                    }
                    return Err(MercuryError::Network(e.to_string()));
                }
            };

            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();

            if is_retryable_status(status) && attempt < MAX_RETRIES {
                last_error = Some(MercuryError::Api {
                    status: status.as_u16(),
                    body: body_text,
                });
                continue;
            }

            if status != StatusCode::OK {
                return Err(MercuryError::Api {
                    status: status.as_u16(),
                    body: body_text,
                });
            }

            let json: Value = serde_json::from_str(&body_text).map_err(|_| {
                MercuryError::Client(format!(
                    "Invalid JSON response: {}",
                    &body_text[..body_text.len().min(500)]
                ))
            })?;

            return Ok(json);
        }

        Err(last_error.unwrap_or_else(|| {
            MercuryError::Client("All retries exhausted".to_string())
        }))
    }
}

// ── SSE stream parsing ──────────────────────────────────────────────────────

/// Parse an SSE byte stream into a stream of parsed JSON values.
fn sse_stream<S>(byte_stream: S) -> impl Stream<Item = Result<Value, MercuryError>> + Send
where
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + Unpin + 'static,
{
    futures::stream::unfold(
        (byte_stream, String::new()),
        |(mut byte_stream, mut buffer)| async move {
            use futures::StreamExt;

            loop {
                // Try to extract a complete SSE event from the buffer
                if let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() {
                        continue;
                    }

                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            return None;
                        }
                        match serde_json::from_str::<Value>(data) {
                            Ok(json) => {
                                return Some((Ok(json), (byte_stream, buffer)));
                            }
                            Err(_) => {
                                // Skip malformed chunks
                                continue;
                            }
                        }
                    }
                    continue;
                }

                // Need more data from the stream
                match byte_stream.next().await {
                    Some(Ok(chunk)) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                    }
                    Some(Err(e)) => {
                        return Some((
                            Err(MercuryError::Network(e.to_string())),
                            (byte_stream, buffer),
                        ));
                    }
                    None => {
                        // Stream ended - process any remaining buffer
                        let trimmed = buffer.trim().to_string();
                        if let Some(data) = trimmed.strip_prefix("data: ") {
                            if data != "[DONE]" {
                                if let Ok(json) = serde_json::from_str::<Value>(data) {
                                    buffer.clear();
                                    return Some((Ok(json), (byte_stream, buffer)));
                                }
                            }
                        }
                        return None;
                    }
                }
            }
        },
    )
}

/// Simple jitter for retry delays (0-499ms).
fn rand_jitter_ms() -> u32 {
    // Use a simple approach based on current time for jitter.
    // In production you'd use a proper RNG, but this avoids an extra dependency.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    (now.subsec_nanos() % 500) as u32
}

/// Check if a reqwest error is retryable (connection/timeout errors).
fn is_retryable_reqwest_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_loopback() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("example.com"));
    }

    #[test]
    fn test_is_retryable_status() {
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_retryable_status(StatusCode::GATEWAY_TIMEOUT));
        assert!(!is_retryable_status(StatusCode::OK));
        assert!(!is_retryable_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_status(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn test_client_creation() {
        let client = MercuryClient::new(MercuryClientOptions::default());
        assert!(client.is_ok());
        let client = client.unwrap();
        assert_eq!(client.provider_name(), "mercury");
        assert_eq!(client.config.model, "mercury-2");
    }

    #[test]
    fn test_client_with_custom_provider() {
        let client = MercuryClient::new(MercuryClientOptions {
            provider: Some("openai".to_string()),
            ..Default::default()
        });
        assert!(client.is_ok());
        let client = client.unwrap();
        assert_eq!(client.provider_name(), "openai");
        assert_eq!(client.config.model, "gpt-4o");
    }

    #[test]
    fn test_build_url() {
        let client = MercuryClient::new(MercuryClientOptions {
            base_url: Some("https://api.example.com/v1/".to_string()),
            ..Default::default()
        })
        .unwrap();
        let url = client.build_url("/chat/completions").unwrap();
        assert_eq!(url, "https://api.example.com/v1/chat/completions");
    }

    #[test]
    fn test_build_request_body_mercury() {
        let client = MercuryClient::new(MercuryClientOptions::default()).unwrap();
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: Some("Hello".to_string()),
            tool_calls: None,
            tool_call_id: None,
        }];
        let body = client.build_request_body(&messages, &RequestOptions::default());

        assert_eq!(body["model"], "mercury-2");
        assert!(body.get("reasoning_effort").is_some());
        assert!(body.get("reasoning_summary").is_some());
    }

    #[test]
    fn test_build_request_body_openai() {
        let client = MercuryClient::new(MercuryClientOptions {
            provider: Some("openai".to_string()),
            ..Default::default()
        })
        .unwrap();
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: Some("Hello".to_string()),
            tool_calls: None,
            tool_call_id: None,
        }];
        let body = client.build_request_body(&messages, &RequestOptions::default());

        assert_eq!(body["model"], "gpt-4o");
        // OpenAI doesn't support these
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("reasoning_summary").is_none());
    }

    #[test]
    fn test_insecure_http_rejection() {
        let mut client = MercuryClient::new(MercuryClientOptions {
            base_url: Some("http://remote-server.com/v1".to_string()),
            api_key: Some("test-key".to_string()),
            ..Default::default()
        })
        .unwrap();
        let result = client.warn_if_insecure();
        assert!(result.is_err());
    }

    #[test]
    fn test_insecure_http_allowed_for_localhost() {
        let mut client = MercuryClient::new(MercuryClientOptions {
            base_url: Some("http://localhost:8080/v1".to_string()),
            api_key: Some("test-key".to_string()),
            ..Default::default()
        })
        .unwrap();
        let result = client.warn_if_insecure();
        assert!(result.is_ok());
    }

    #[test]
    fn test_sanitize_null_content() {
        let client = MercuryClient::new(MercuryClientOptions::default()).unwrap();
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: None,
            tool_calls: None,
            tool_call_id: None,
        }];
        let body = client.build_request_body(&messages, &RequestOptions::default());
        let msg = &body["messages"][0];
        assert_eq!(msg["content"], "");
    }

    #[test]
    fn test_assistant_null_content_with_tool_calls() {
        let client = MercuryClient::new(MercuryClientOptions::default()).unwrap();
        let messages = vec![ChatMessage {
            role: "assistant".to_string(),
            content: None,
            tool_calls: Some(vec![serde_json::json!({"id": "call_1", "type": "function", "function": {"name": "test", "arguments": "{}"}})]),
            tool_call_id: None,
        }];
        let body = client.build_request_body(&messages, &RequestOptions::default());
        let msg = &body["messages"][0];
        // Should keep null content for assistant with tool_calls
        assert!(msg["content"].is_null());
    }

    #[test]
    fn test_rand_jitter() {
        let jitter = rand_jitter_ms();
        assert!(jitter < 500);
    }
}
