import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/conversation.js";

describe("Conversation - message management", () => {
  let conv;
  beforeEach(() => { conv = new Conversation("You are helpful."); });
  it("starts with empty messages", () => { assert.equal(conv.messages.length, 0); });
  it("adds user message", () => { conv.addUserMessage("hello"); assert.equal(conv.messages[conv.messages.length - 1].role, "user"); });
  it("adds assistant message", () => { conv.addAssistantMessage("hi"); assert.equal(conv.messages[conv.messages.length - 1].role, "assistant"); });
  it("adds tool result", () => {
    conv.addAssistantMessage("", [{ id: "1", type: "function", function: { name: "Read", arguments: "{}" } }]);
    conv.addToolResult("1", "result");
    assert.ok(conv.messages.some(m => m.role === "tool"));
  });
  it("clear resets messages", () => { conv.addUserMessage("test"); conv.clear(); assert.equal(conv.messages.length, 0); });
  it("preserves message order", () => {
    conv.addUserMessage("q1"); conv.addAssistantMessage("a1"); conv.addUserMessage("q2");
    assert.equal(conv.messages[0].content, "q1");
    assert.equal(conv.messages[1].content, "a1");
    assert.equal(conv.messages[2].content, "q2");
  });
});

describe("Conversation - system prompt", () => {
  it("includes system prompt in getMessages", () => {
    const c = new Conversation("Be kind.");
    const msgs = c.getMessages();
    assert.ok(msgs[0].role === "system" && msgs[0].content.includes("Be kind."));
  });
  it("injects memory into getMessages", async () => {
    const c = new Conversation("Base prompt.");
    await c.loadMemory({ read: async () => "User prefers dark mode." });
    const msgs = c.getMessages();
    assert.ok(msgs[0].content.includes("dark mode"));
  });
  it("updates system prompt", () => {
    const c = new Conversation("v1");
    c.updateSystemPrompt("v2");
    const msgs = c.getMessages();
    assert.ok(msgs[0].content.includes("v2"));
  });
});

describe("Conversation - token estimation", () => {
  it("estimates tokens", () => { const c = new Conversation("test"); assert.ok(c.getTokenEstimate() >= 0); });
  it("increases with messages", () => {
    const c = new Conversation("test");
    const t1 = c.getTokenEstimate();
    c.addUserMessage("a long message with many words to increase token count significantly");
    assert.ok(c.getTokenEstimate() > t1);
  });
  it("returns a number", () => { assert.equal(typeof new Conversation("t").getTokenEstimate(), "number"); });
});

describe("Conversation - memory", () => {
  it("loads memory", async () => {
    const c = new Conversation("Base");
    await c.loadMemory({ read: async () => "Remember this." });
    const msgs = c.getMessages();
    assert.ok(msgs[0].content.includes("Remember this."));
  });
  it("works without memory", () => {
    const c = new Conversation("No memory");
    const msgs = c.getMessages();
    assert.ok(msgs[0].content.includes("No memory"));
  });
});
