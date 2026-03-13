// Mercury Code - Shared Environment Sanitization
// Comprehensive env var filtering to prevent secret leakage via child processes.
// Used by: tools/executor.js (Bash), hooks.js (hook commands), mcp.js (MCP servers)

// Patterns that match sensitive environment variable names
export const SENSITIVE_ENV_PATTERNS = [
  /(?:_KEY|KEY_|^KEY$|API_KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_KEY)/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /CREDENTIAL/i, /(?:_AUTH_|AUTH_TOKEN|AUTH_KEY|AUTH_SECRET|OAUTH|^AUTH$)/i,
  /^AWS_/, /^GCP_/, /^AZURE_/, /^GITHUB_TOKEN$/, /^NPM_TOKEN$/,
  /^INCEPTION_/, /^MERCURY_/, /^DATABASE_URL$/i, /^REDIS_URL$/i,
  /^MONGO_URI$/i, /^PRIVATE_KEY$/i, /^SESSION_SECRET$/i, /^COOKIE_SECRET$/i,
  /^STRIPE_/, /^TWILIO_/, /^SENDGRID_/, /^SLACK_TOKEN$/i,
  /^OPENAI_/, /^ANTHROPIC_/, /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^SSH_/i, /^GPG_/i, /^GH_TOKEN$/i, /^NODE_OPTIONS$/i,
  // Hugging Face Hub token
  /^HUGGING_FACE_HUB_TOKEN$/i,
  // Docker auth config (may contain registry credentials)
  /^DOCKER_AUTH_CONFIG$/i,
  // GitLab CI tokens (CI_JOB_TOKEN, CI_DEPLOY_TOKEN, etc.)
  /^CI_.*TOKEN/i,
  // GitHub Actions runtime token
  /^ACTIONS_RUNTIME_TOKEN$/i,

  // ---- Process / library hijacking vectors ----
  // Node.js module resolution hijack
  /^NODE_PATH$/i,
  /^NODE_EXTRA_CA_CERTS$/i,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/i,
  // Native library injection (Linux / macOS)
  /^LD_PRELOAD$/i, /^LD_LIBRARY_PATH$/i, /^DYLD_INSERT_LIBRARIES$/i,
  /^DYLD_LIBRARY_PATH$/i, /^DYLD_FALLBACK_LIBRARY_PATH$/i,
  // Network proxy hijacking — can redirect traffic to attacker-controlled proxy
  /^HTTPS?_PROXY$/i, /^ALL_PROXY$/i, /^NO_PROXY$/i,
  // Language-specific module path hijacking
  /^PYTHONPATH$/i, /^PYTHONSTARTUP$/i, /^RUBYLIB$/i, /^PERL5LIB$/i,
  /^CLASSPATH$/i,
  // TLS/CA bundle overrides — can enable MITM
  /^SSL_CERT_FILE$/i, /^SSL_CERT_DIR$/i,
  /^CURL_CA_BUNDLE$/i, /^REQUESTS_CA_BUNDLE$/i,
  // Git command injection vectors
  /^GIT_SSH/i,         // GIT_SSH_COMMAND, GIT_SSH
  /^GIT_PROXY/i,       // GIT_PROXY_COMMAND
  // Package manager registry overrides
  /^npm_config_/i,     // npm registry override
  /^PIP_/i,            // Python package index override
  /^CARGO_/i,          // Rust build override
  /^GONOSUMCHECK/i,    // Go module verification bypass
  /^GOFLAGS/i,         // Go build flags
  // Database / service connection strings
  /(?:CONNECTION_STRING|CONNECTION_URL|_CONNECTION$)/i,       // Database connection strings
  /^DSN$/i,            // Data source name
  /(?:DATABASE_URI|MONGODB_URI|REDIS_URI|POSTGRES_URI|MYSQL_URI|_SECRET_URI)$/i,            // Various URIs
];

// Explicit allowlist for env vars that are always safe to pass through
export const SAFE_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERM_PROGRAM", "EDITOR", "VISUAL", "PAGER",
  "NODE_ENV",
  "TMPDIR", "TMP", "TEMP",
  "PWD", "OLDPWD", "SHLVL",
  "HOSTNAME", "LOGNAME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
  "DISPLAY", "COLORTERM", "FORCE_COLOR", "NO_COLOR",
]);

/**
 * Return a sanitized copy of process.env — strips secrets, keeps safe vars.
 * @returns {Record<string, string>}
 */
export function sanitizeEnv() {
  const clean = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_ALLOWLIST.has(key)) {
      clean[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_PATTERNS.some(re => re.test(key))) continue;
    clean[key] = value;
  }
  return clean;
}
