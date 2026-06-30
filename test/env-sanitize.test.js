// Tests for src/utils/env-sanitize.js — environment variable sanitization
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sanitizeEnv, SENSITIVE_ENV_PATTERNS, SAFE_ENV_ALLOWLIST } from "../src/utils/env-sanitize.js";

describe("sanitizeEnv: safe allowlist", () => {
  const SAFE_KEYS = ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "NODE_ENV", "EDITOR", "TMPDIR", "PWD"];

  for (const key of SAFE_KEYS) {
    it(`passes through ${key}`, () => {
      const original = process.env[key];
      process.env[key] = "test-value-safe";
      try {
        const clean = sanitizeEnv();
        assert.equal(clean[key], "test-value-safe", `${key} should pass through`);
      } finally {
        if (original !== undefined) process.env[key] = original;
        else delete process.env[key];
      }
    });
  }
});

describe("sanitizeEnv: blocks sensitive keys", () => {
  const SENSITIVE_KEYS = [
    "API_KEY", "SECRET_KEY", "PRIVATE_KEY", "ACCESS_KEY",
    "MY_SECRET", "AUTH_TOKEN", "MY_PASSWORD", "MY_CREDENTIAL",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN", "NPM_TOKEN", "GH_TOKEN",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "INCEPTION_API_KEY", "MERCURY_API_KEY",
    "DATABASE_URL", "REDIS_URL",
    "STRIPE_SECRET_KEY", "SENDGRID_API_KEY", "SLACK_TOKEN",
    "SSH_PRIVATE_KEY", "GPG_KEY",
    // Hijacking vectors
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
    "LD_PRELOAD", "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
    "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
    "PYTHONPATH", "PYTHONSTARTUP", "RUBYLIB", "PERL5LIB", "CLASSPATH",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
    "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND",
    "npm_config_registry",
    "PIP_INDEX_URL",
    "CARGO_NET_GIT_FETCH_WITH_CLI",
  ];

  for (const key of SENSITIVE_KEYS) {
    it(`blocks ${key}`, () => {
      const original = process.env[key];
      process.env[key] = "secret-value";
      try {
        const clean = sanitizeEnv();
        assert.equal(clean[key], undefined, `${key} should be stripped`);
      } finally {
        if (original !== undefined) process.env[key] = original;
        else delete process.env[key];
      }
    });
  }
});

describe("sanitizeEnv: passes through normal keys", () => {
  it("passes through non-sensitive custom keys", () => {
    const original = process.env.MY_CUSTOM_SETTING;
    process.env.MY_CUSTOM_SETTING = "some-value";
    try {
      const clean = sanitizeEnv();
      assert.equal(clean.MY_CUSTOM_SETTING, "some-value");
    } finally {
      if (original !== undefined) process.env.MY_CUSTOM_SETTING = original;
      else delete process.env.MY_CUSTOM_SETTING;
    }
  });
});

describe("SENSITIVE_ENV_PATTERNS coverage", () => {
  it("has patterns for all major secret categories", () => {
    const categories = [
      { name: "API keys", sample: "MY_API_KEY" },
      { name: "secrets", sample: "APP_SECRET" },
      { name: "tokens", sample: "MY_TOKEN" },
      { name: "passwords", sample: "DB_PASSWORD" },
      { name: "credentials", sample: "SERVICE_CREDENTIAL" },
      { name: "AWS", sample: "AWS_SESSION_TOKEN" },
      { name: "auth", sample: "OAUTH_CLIENT_SECRET" },
    ];

    for (const { name, sample } of categories) {
      const matched = SENSITIVE_ENV_PATTERNS.some(re => re.test(sample));
      assert.ok(matched, `Should match ${name} category (sample: ${sample})`);
    }
  });
});
