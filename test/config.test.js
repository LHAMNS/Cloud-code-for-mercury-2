// Tests for src/config.js — Configuration and constants
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MERCURY_API_BASE,
  MERCURY_MODEL,
  REASONING_LEVELS,
  DEFAULT_CONFIG,
  MODEL_LIMITS,
  normalizeClientConfig,
} from "../src/config.js";
import { MercuryClient } from "../src/client.js";

describe("Config", () => {
  it("has a valid API base URL", () => {
    assert.ok(MERCURY_API_BASE.startsWith("https://"));
  });

  it("model is mercury-2", () => {
    assert.equal(MERCURY_MODEL, "mercury-2");
  });

  it("has 4 reasoning levels", () => {
    assert.equal(REASONING_LEVELS.length, 4);
    assert.ok(REASONING_LEVELS.includes("instant"));
    assert.ok(REASONING_LEVELS.includes("low"));
    assert.ok(REASONING_LEVELS.includes("medium"));
    assert.ok(REASONING_LEVELS.includes("high"));
  });

  it("DEFAULT_CONFIG has required fields", () => {
    assert.equal(DEFAULT_CONFIG.model, "mercury-2");
    assert.ok(DEFAULT_CONFIG.max_tokens > 0);
    assert.ok(typeof DEFAULT_CONFIG.temperature === "number");
    assert.ok(DEFAULT_CONFIG.reasoning_effort);
    assert.ok(typeof DEFAULT_CONFIG.stream === "boolean");
  });

  it("MODEL_LIMITS has correct ranges", () => {
    assert.ok(MODEL_LIMITS.max_context_tokens >= 128000);
    assert.ok(MODEL_LIMITS.max_output_tokens > 0);
    assert.ok(Array.isArray(MODEL_LIMITS.temperature_range));
    assert.equal(MODEL_LIMITS.temperature_range.length, 2);
  });

  it("normalizes client config and strips unknown keys", () => {
    const config = normalizeClientConfig({
      workspace: "/tmp/project",
      trustMode: "open",
      temperature: 99,
      max_tokens: 999999,
      reasoning_effort: "invalid",
      stream: "yes",
    });

    assert.equal(config.reasoning_effort, DEFAULT_CONFIG.reasoning_effort);
    assert.equal(config.temperature, MODEL_LIMITS.temperature_range[1]);
    assert.equal(config.max_tokens, MODEL_LIMITS.max_output_tokens);
    assert.equal(config.stream, true);
    assert.equal("workspace" in config, false);
    assert.equal("trustMode" in config, false);
  });

  it("MercuryClient only keeps whitelisted runtime config keys", () => {
    const client = new MercuryClient({
      apiKey: "test-key",
      workspace: "/tmp/project",
      trustMode: "approval",
      max_tokens: 1234,
      stream: false,
    });

    assert.equal(client.config.max_tokens, 1234);
    assert.equal(client.config.stream, false);
    assert.equal("workspace" in client.config, false);
    assert.equal("trustMode" in client.config, false);
  });
});
