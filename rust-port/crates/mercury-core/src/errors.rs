use thiserror::Error;

#[derive(Error, Debug)]
pub enum MercuryError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("API error (status {status}): {body}")]
    Api { status: u16, body: String },

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("Client error: {0}")]
    Client(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("Security error: {0}")]
    Security(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Tool error: {0}")]
    Tool(String),

    #[error("{0}")]
    Other(String),
}
