// Tests for src/context.js — Token estimation, context stats, and compression helpers
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
  getContextStats,
  updateApiUsage,
  resetCompactionState,
  forceCompact,
} from "../src/context.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("returns 0 for null/undefined", () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  it("estimates roughly bytes/4", () => {
    const text = "Hello, world!"; // 13 bytes
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 2 && tokens <= 10, `Expected ~3 tokens, got ${tokens}`);
  });

  it("handles unicode (multi-byte characters)", () => {
    const text = "你好世界"; // 12 UTF-8 bytes
    const tokens = estimateTokens(text);
    assert.ok(tokens > 0);
    // 12 bytes / 4 = 3 tokens
    assert.equal(tokens, 3);
  });

  it("ceiling division produces correct values", () => {
    // 1 byte → ceil(1/4) = 1
    assert.equal(estimateTokens("a"), 1);
    // 4 bytes → ceil(4/4) = 1
    assert.equal(estimateTokens("abcd"), 1);
    // 5 bytes → ceil(5/4) = 2
    assert.equal(estimateTokens("abcde"), 2);
  });
});

describe("estimateMessagesTokens", () => {
  it("estimates tokens for a message array", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there! How can I help?" },
    ];
    const tokens = estimateMessagesTokens(messages);
    assert.ok(tokens > 0);
  });

  it("handles empty messages", () => {
    const tokens = estimateMessagesTokens([]);
    assert.equal(tokens, 0);
  });

  it("handles messages with null content", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [] },
    ];
    const tokens = estimateMessagesTokens(messages);
    assert.ok(tokens >= 0);
  });

  it("includes per-message overhead of 4 tokens", () => {
    // One message with empty content = 4 overhead
    const tokens = estimateMessagesTokens([{ role: "user", content: "" }]);
    assert.equal(tokens, 4);
  });

  it("adds 3 tokens for tool_call_id", () => {
    const tokens = estimateMessagesTokens([
      { role: "tool", tool_call_id: "tc_123", content: "" },
    ]);
    // 4 (overhead) + 3 (tool_call_id) = 7
    assert.equal(tokens, 7);
  });
});

describe("getContextStats", () => {
  it("returns usage statistics", () => {
    resetCompactionState();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const stats = getContextStats(messages, "You are a helpful assistant.");
    assert.ok(stats.estimated > 0);
    assert.ok(stats.effective > 0);
    assert.ok(typeof stats.pct === "number");
    assert.equal(stats.compactionCount, 0);
    assert.equal(stats.apiReported, null);
  });

  it("tracks API-reported usage", () => {
    resetCompactionState();
    updateApiUsage({ prompt_tokens: 50000, completion_tokens: 1000, total_tokens: 51000 });
    const stats = getContextStats([], "test");
    assert.equal(stats.apiReported, 50000);
  });
});

describe("resetCompactionState", () => {
  it("resets counters", () => {
    updateApiUsage({ prompt_tokens: 99999, completion_tokens: 0, total_tokens: 99999 });
    resetCompactionState();
    const stats = getContextStats([], "test");
    assert.equal(stats.compactionCount, 0);
    assert.equal(stats.apiReported, null);
  });
});

describe("forceCompact", () => {
  it("does not compact when messages are empty", async () => {
    const messages = [];
    const infos = [];
    const result = await forceCompact(messages, "system", null, null, (msg) => infos.push(msg));
    assert.equal(result, false);
  });

  it("does not compact when only 1 turn", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const infos = [];
    const result = await forceCompact(messages, "system", null, null, (msg) => infos.push(msg));
    // With threshold=0, cutoff=0 because only 1 user turn → returns false
    assert.equal(result, false);
  });
});
