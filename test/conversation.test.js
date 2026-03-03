/**
 * Tests for conversation.js — Conversation manager.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/conversation.js";

describe("Conversation: message management", () => {
  it("starts empty", () => {
    const conv = new Conversation("System prompt");
    assert.equal(conv.messages.length, 0);
  });
  it("addUserMessage adds user message", () => {
    const conv = new Conversation("System");
    conv.addUserMessage("Hello");
    assert.equal(conv.messages.length, 1);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[0].content, "Hello");
  });
  it("addAssistantMessage adds assistant message", () => {
    const conv = new Conversation("System");
    conv.addAssistantMessage("Hi there");
    assert.equal(conv.messages[0].role, "assistant");
  });
  it("addAssistantMessage with tool_calls", () => {
    const conv = new Conversation("System");
    const calls = [{ id: "tc1", function: { name: "read", arguments: "{}" } }];
    conv.addAssistantMessage("Using tool", calls);
    assert.deepEqual(conv.messages[0].tool_calls, calls);
  });
  it("addToolResult adds tool message", () => {
    const conv = new Conversation("System");
    conv.addToolResult("tc1", "File content here");
    assert.equal(conv.messages[0].role, "tool");
    assert.equal(conv.messages[0].tool_call_id, "tc1");
  });
});

describe("Conversation: system prompt", () => {
  it("getMessages prepends system", () => {
    const conv = new Conversation("You are helpful.");
    conv.addUserMessage("Hi");
    const msgs = conv.getMessages();
    assert.equal(msgs[0].role, "system");
    assert.equal(msgs[0].content, "You are helpful.");
    assert.equal(msgs.length, 2);
  });
  it("updateSystemPrompt changes the prompt", () => {
    const conv = new Conversation("Old prompt");
    conv.updateSystemPrompt("New prompt");
    assert.equal(conv.getMessages()[0].content, "New prompt");
  });
});

describe("Conversation: clear", () => {
  it("clear removes all messages", () => {
    const conv = new Conversation("System");
    conv.addUserMessage("Hello");
    conv.addAssistantMessage("Hi");
    conv.clear();
    assert.equal(conv.messages.length, 0);
  });
});

describe("Conversation: usage tracking", () => {
  it("updateUsage stores usage data", () => {
    const conv = new Conversation("System");
    conv.addUserMessage("test");
    conv.updateUsage({ prompt_tokens: 50, total_tokens: 80 });
    assert.equal(conv._lastActualUsage.prompt_tokens, 50);
    assert.equal(conv._msgCountAtLastUsage, 1);
  });
  it("getTokenEstimate uses API baseline", () => {
    const conv = new Conversation("System");
    conv.addUserMessage("test");
    conv.updateUsage({ prompt_tokens: 100, total_tokens: 150 });
    conv.addUserMessage("follow up");
    const est = conv.getTokenEstimate();
    assert.ok(est >= 150, `Should use API baseline: got ${est}`);
  });
  it("getTokenEstimate fallback heuristic", () => {
    const conv = new Conversation("System prompt");
    conv.addUserMessage("Hello");
    const est = conv.getTokenEstimate();
    assert.ok(est > 0, `Should be positive: got ${est}`);
  });
  it("getUsagePercent returns percentage string", () => {
    const conv = new Conversation("System");
    const pct = conv.getUsagePercent();
    assert.ok(pct.includes("%"), `Should include %: got ${pct}`);
  });
});
