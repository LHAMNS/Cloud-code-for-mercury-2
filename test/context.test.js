// Tests for src/context.js — Token estimation and context helpers
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessagesTokens } from "../src/context.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("estimates roughly bytes/4", () => {
    const text = "Hello, world!"; // 13 bytes
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 2 && tokens <= 10, `Expected ~3 tokens, got ${tokens}`);
  });

  it("handles unicode", () => {
    const text = "你好世界"; // 12 UTF-8 bytes
    const tokens = estimateTokens(text);
    assert.ok(tokens > 0);
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
});
