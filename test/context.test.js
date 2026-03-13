// Tests for src/context.js — Token estimation, context stats, and compression helpers
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
  getContextStats,
  updateApiUsage,
  resetCompactionState,
  createCompactionState,
  forceCompact,
  trimStaleToolOutputs,
  clearToolOutput,
  aggressiveTrim,
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

  it("keeps per-session compaction state isolated when passed explicitly", () => {
    const stateA = createCompactionState();
    const stateB = createCompactionState();

    updateApiUsage({ prompt_tokens: 50000, completion_tokens: 1000, total_tokens: 51000 }, stateA);

    assert.equal(getContextStats([], "test", stateA).apiReported, 50000);
    assert.equal(getContextStats([], "test", stateB).apiReported, null);
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

describe("trimStaleToolOutputs", () => {
  it("trims large tool outputs older than keepTurns", () => {
    // Generate a large multiline output (realistic file read content)
    const lines = Array.from({ length: 200 }, (_, i) =>
      `     ${i + 1}\tconst value_${i} = "data_" + ${"abcde".repeat(20)};`
    );
    const largeOutput = lines.join("\n"); // ~24000 chars = ~6000 tokens
    const messages = [
      { role: "user", content: "Task 1" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", function: { name: "Read", arguments: '{}' } }] },
      { role: "tool", tool_call_id: "tc1", content: largeOutput },
      { role: "assistant", content: "Done with task 1" },
      { role: "user", content: "Task 2" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc2", function: { name: "Read", arguments: '{}' } }] },
      { role: "tool", tool_call_id: "tc2", content: largeOutput },
      { role: "assistant", content: "Done with task 2" },
      // Recent turns (keep these)
      { role: "user", content: "Task 3" },
      { role: "assistant", content: "Response 3" },
      { role: "user", content: "Task 4" },
      { role: "assistant", content: "Response 4" },
      { role: "user", content: "Task 5" },
      { role: "assistant", content: "Response 5" },
      { role: "user", content: "Task 6" },
      { role: "assistant", content: "Response 6" },
    ];

    const { trimmed, savedTokens } = trimStaleToolOutputs(messages, 4, 500);
    assert.ok(trimmed >= 1, `Expected at least 1 trimmed, got ${trimmed}`);
    assert.ok(savedTokens > 0, `Expected savedTokens > 0, got ${savedTokens}`);
    // The old tool output should now be shorter
    assert.ok(messages[2].content.includes("[Tool output trimmed"));
    // Verify the trimmed content is significantly shorter
    assert.ok(messages[2].content.length < largeOutput.length / 2,
      `Trimmed output should be much shorter: ${messages[2].content.length} vs ${largeOutput.length}`);
  });

  it("preserves small tool outputs", () => {
    const messages = [
      { role: "user", content: "Task 1" },
      { role: "tool", tool_call_id: "tc1", content: "OK" },
      { role: "user", content: "Task 2" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Task 3" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Task 4" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Task 5" },
      { role: "assistant", content: "Done" },
    ];

    const { trimmed } = trimStaleToolOutputs(messages, 4, 500);
    assert.equal(trimmed, 0);
    assert.equal(messages[1].content, "OK");
  });

  it("summarizes error messages", () => {
    const errorOutput = "Error: something failed\n" + "details ".repeat(500);
    const messages = [
      { role: "user", content: "Task 1" },
      { role: "tool", tool_call_id: "tc1", content: errorOutput },
      { role: "user", content: "Task 2" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Task 3" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Task 4" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Task 5" },
      { role: "assistant", content: "Done" },
    ];

    const { trimmed } = trimStaleToolOutputs(messages, 4, 500);
    assert.ok(trimmed >= 1);
    // Error content should be preserved in summary
    assert.ok(messages[1].content.includes("error summary"));
  });
});

describe("clearToolOutput", () => {
  it("clears a specific tool output by ID", () => {
    const messages = [
      { role: "user", content: "Task 1" },
      { role: "tool", tool_call_id: "tc1", content: "a".repeat(1000) },
      { role: "tool", tool_call_id: "tc2", content: "b".repeat(500) },
    ];

    const cleared = clearToolOutput(messages, "tc1");
    assert.equal(cleared, true);
    assert.ok(messages[1].content.includes("Output cleared"));
    // tc2 should be untouched
    assert.equal(messages[2].content, "b".repeat(500));
  });

  it("returns false for non-existent tool_call_id", () => {
    const messages = [
      { role: "tool", tool_call_id: "tc1", content: "data" },
    ];
    assert.equal(clearToolOutput(messages, "nonexistent"), false);
  });
});

describe("aggressiveTrim", () => {
  it("returns trimmed count and deduped count", () => {
    const messages = [
      { role: "user", content: "Task 1" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Task 2" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Task 3" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Task 4" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Task 5" },
      { role: "assistant", content: "Response" },
    ];

    const result = aggressiveTrim(messages, 4);
    assert.ok(typeof result.trimmed === "number");
    assert.ok(typeof result.savedTokens === "number");
    assert.ok(typeof result.deduped === "number");
  });
});
