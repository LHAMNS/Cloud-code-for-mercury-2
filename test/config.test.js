// Tests for src/config.js — Configuration and constants
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MERCURY_API_BASE,
  MERCURY_MODEL,
  REASONING_LEVELS,
  DEFAULT_CONFIG,
  MODEL_LIMITS,
} from "../src/config.js";

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
});
