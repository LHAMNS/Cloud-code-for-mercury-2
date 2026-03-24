// Mercury Code - Environment Variable Sanitization
// Comprehensive env var filtering to prevent secret leakage via child processes.
// Used by: hooks (hook commands), mcp (MCP servers)
// Ported from: src/utils/env-sanitize.js

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::env;

/// Patterns that match sensitive environment variable names.
/// Any env var whose key matches one of these is stripped from child process environments.
static SENSITIVE_ENV_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"(?i)(?:_KEY|KEY_|^KEY$|API_KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_KEY)").unwrap(),
        Regex::new(r"(?i)SECRET").unwrap(),
        Regex::new(r"(?i)TOKEN").unwrap(),
        Regex::new(r"(?i)PASSWORD").unwrap(),
        Regex::new(r"(?i)CREDENTIAL").unwrap(),
        Regex::new(r"(?i)(?:_AUTH_|AUTH_TOKEN|AUTH_KEY|AUTH_SECRET|OAUTH|^AUTH$)").unwrap(),
        Regex::new(r"^AWS_").unwrap(),
        Regex::new(r"^GCP_").unwrap(),
        Regex::new(r"^AZURE_").unwrap(),
        Regex::new(r"^GITHUB_TOKEN$").unwrap(),
        Regex::new(r"^NPM_TOKEN$").unwrap(),
        Regex::new(r"^INCEPTION_").unwrap(),
        Regex::new(r"^MERCURY_").unwrap(),
        Regex::new(r"(?i)^DATABASE_URL$").unwrap(),
        Regex::new(r"(?i)^REDIS_URL$").unwrap(),
        Regex::new(r"(?i)^MONGO_URI$").unwrap(),
        Regex::new(r"(?i)^PRIVATE_KEY$").unwrap(),
        Regex::new(r"(?i)^SESSION_SECRET$").unwrap(),
        Regex::new(r"(?i)^COOKIE_SECRET$").unwrap(),
        Regex::new(r"^STRIPE_").unwrap(),
        Regex::new(r"^TWILIO_").unwrap(),
        Regex::new(r"^SENDGRID_").unwrap(),
        Regex::new(r"(?i)^SLACK_TOKEN$").unwrap(),
        Regex::new(r"^OPENAI_").unwrap(),
        Regex::new(r"^ANTHROPIC_").unwrap(),
        Regex::new(r"^GOOGLE_APPLICATION_CREDENTIALS$").unwrap(),
        Regex::new(r"(?i)^SSH_").unwrap(),
        Regex::new(r"(?i)^GPG_").unwrap(),
        Regex::new(r"(?i)^GH_TOKEN$").unwrap(),
        Regex::new(r"(?i)^NODE_OPTIONS$").unwrap(),
        // Hugging Face
        Regex::new(r"(?i)^HUGGING_FACE_HUB_TOKEN$").unwrap(),
        // Docker
        Regex::new(r"(?i)^DOCKER_AUTH_CONFIG$").unwrap(),
        // CI tokens
        Regex::new(r"(?i)^CI_.*TOKEN").unwrap(),
        Regex::new(r"(?i)^ACTIONS_RUNTIME_TOKEN$").unwrap(),
        // Process / library hijacking vectors
        Regex::new(r"(?i)^NODE_PATH$").unwrap(),
        Regex::new(r"(?i)^NODE_EXTRA_CA_CERTS$").unwrap(),
        Regex::new(r"(?i)^NODE_TLS_REJECT_UNAUTHORIZED$").unwrap(),
        Regex::new(r"(?i)^LD_PRELOAD$").unwrap(),
        Regex::new(r"(?i)^LD_LIBRARY_PATH$").unwrap(),
        Regex::new(r"(?i)^DYLD_INSERT_LIBRARIES$").unwrap(),
        Regex::new(r"(?i)^DYLD_LIBRARY_PATH$").unwrap(),
        Regex::new(r"(?i)^DYLD_FALLBACK_LIBRARY_PATH$").unwrap(),
        // Proxy hijacking
        Regex::new(r"(?i)^HTTPS?_PROXY$").unwrap(),
        Regex::new(r"(?i)^ALL_PROXY$").unwrap(),
        Regex::new(r"(?i)^NO_PROXY$").unwrap(),
        // Language module path hijacking
        Regex::new(r"(?i)^PYTHONPATH$").unwrap(),
        Regex::new(r"(?i)^PYTHONSTARTUP$").unwrap(),
        Regex::new(r"(?i)^RUBYLIB$").unwrap(),
        Regex::new(r"(?i)^PERL5LIB$").unwrap(),
        Regex::new(r"(?i)^CLASSPATH$").unwrap(),
        // TLS/CA overrides
        Regex::new(r"(?i)^SSL_CERT_FILE$").unwrap(),
        Regex::new(r"(?i)^SSL_CERT_DIR$").unwrap(),
        Regex::new(r"(?i)^CURL_CA_BUNDLE$").unwrap(),
        Regex::new(r"(?i)^REQUESTS_CA_BUNDLE$").unwrap(),
        // Git injection vectors
        Regex::new(r"(?i)^GIT_SSH").unwrap(),
        Regex::new(r"(?i)^GIT_PROXY").unwrap(),
        // Package manager registry overrides
        Regex::new(r"(?i)^npm_config_").unwrap(),
        Regex::new(r"(?i)^PIP_").unwrap(),
        Regex::new(r"(?i)^CARGO_").unwrap(),
        Regex::new(r"(?i)^GONOSUMCHECK").unwrap(),
        Regex::new(r"(?i)^GOFLAGS").unwrap(),
        // Database connection strings
        Regex::new(r"(?i)(?:CONNECTION_STRING|CONNECTION_URL|_CONNECTION$)").unwrap(),
        Regex::new(r"(?i)^DSN$").unwrap(),
        Regex::new(r"(?i)(?:DATABASE_URI|MONGODB_URI|REDIS_URI|POSTGRES_URI|MYSQL_URI|_SECRET_URI)$").unwrap(),
    ]
});

/// Explicit allowlist for env vars that are always safe to pass through.
static SAFE_ENV_ALLOWLIST: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
        "TERM", "TERM_PROGRAM", "EDITOR", "VISUAL", "PAGER",
        "NODE_ENV",
        "TMPDIR", "TMP", "TEMP",
        "PWD", "OLDPWD", "SHLVL",
        "HOSTNAME", "LOGNAME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
        "DISPLAY", "COLORTERM", "FORCE_COLOR", "NO_COLOR",
    ]
    .into_iter()
    .collect()
});

/// Check whether an environment variable key matches any sensitive pattern.
pub fn is_sensitive_env_key(key: &str) -> bool {
    SENSITIVE_ENV_PATTERNS.iter().any(|re| re.is_match(key))
}

/// Return a sanitized copy of the current environment -- strips secrets, keeps safe vars.
pub fn sanitize_env() -> HashMap<String, String> {
    let mut clean = HashMap::new();
    for (key, value) in env::vars() {
        if SAFE_ENV_ALLOWLIST.contains(key.as_str()) {
            clean.insert(key, value);
            continue;
        }
        if is_sensitive_env_key(&key) {
            continue;
        }
        clean.insert(key, value);
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sensitive_patterns() {
        assert!(is_sensitive_env_key("INCEPTION_API_KEY"));
        assert!(is_sensitive_env_key("OPENAI_API_KEY"));
        assert!(is_sensitive_env_key("AWS_SECRET_ACCESS_KEY"));
        assert!(is_sensitive_env_key("GITHUB_TOKEN"));
        assert!(is_sensitive_env_key("LD_PRELOAD"));
        assert!(is_sensitive_env_key("NODE_OPTIONS"));
        assert!(is_sensitive_env_key("MERCURY_DEBUG"));
    }

    #[test]
    fn test_safe_allowlist() {
        assert!(!is_sensitive_env_key("PATH"));
        assert!(!is_sensitive_env_key("HOME"));
        assert!(!is_sensitive_env_key("EDITOR"));
    }

    #[test]
    fn test_sanitize_env_does_not_panic() {
        let clean = sanitize_env();
        // PATH should always be present
        // (might not be if running in a very stripped environment, so just check it doesn't panic)
        let _ = clean;
    }
}
