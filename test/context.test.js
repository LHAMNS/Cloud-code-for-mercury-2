import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessagesTokens } from "../src/context.js";

describe("estimateTokens", () => {
  it("returns 0 for null", () => { assert.equal(estimateTokens(null), 0); });
  it("returns 0 for undefined", () => { assert.equal(estimateTokens(undefined), 0); });
  it("returns 0 for empty string", () => { assert.equal(estimateTokens(""), 0); });
  it("estimates ASCII text", () => { const t = estimateTokens("Hello world, this is a test."); assert.ok(t > 0 && t < 100); });
  it("estimates UTF-8 text", () => { const t = estimateTokens("こんにちは世界"); assert.ok(t > 0); });
  it("handles emoji", () => { assert.ok(estimateTokens("👋🌍") > 0); });
  it("scales with length", () => { assert.ok(estimateTokens("a".repeat(1000)) > estimateTokens("a".repeat(100))); });
  it("handles large strings", () => { assert.ok(estimateTokens("x".repeat(100000)) > 1000); });
});

describe("estimateMessagesTokens", () => {
  it("returns 0 for empty array", () => { assert.equal(estimateMessagesTokens([]), 0); });
  it("adds overhead per message", () => { assert.ok(estimateMessagesTokens([{ role: "user", content: "" }]) > 0); });
  it("estimates content tokens", () => { assert.ok(estimateMessagesTokens([{ role: "user", content: "Hello world" }]) > estimateMessagesTokens([{ role: "user", content: "" }])); });
  it("handles tool_calls", () => {
    const msg = { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "Read", arguments: '{"file_path":"/tmp/t.txt"}' } }] };
    assert.ok(estimateMessagesTokens([msg]) > 0);
  });
  it("handles tool_call_id", () => { assert.ok(estimateMessagesTokens([{ role: "tool", tool_call_id: "1", content: "result" }]) > 0); });
  it("handles multiple messages", () => { assert.ok(estimateMessagesTokens([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]) > estimateMessagesTokens([{ role: "user", content: "a" }])); });
  it("handles null content in message", () => { assert.ok(estimateMessagesTokens([{ role: "assistant", content: null }]) >= 0); });
});
