// Test: Conversation — message management, system prompt, token estimation, clear
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Conversation } from "../src/conversation.js";

let convo;

beforeEach(() => {
  convo = new Conversation("You are a helpful assistant.");
});

// ---------- Constructor ----------

describe("Conversation constructor", () => {
  it("stores the system prompt", () => {
    assert.equal(convo.systemPrompt, "You are a helpful assistant.",
      "systemPrompt should be stored");
  });

  it("starts with empty messages array", () => {
    assert.equal(convo.messages.length, 0,
      "messages should start empty");
  });

  it("starts with null _lastActualUsage", () => {
    assert.equal(convo._lastActualUsage, null,
      "_lastActualUsage should be null initially");
  });

  it("starts with empty _memoryContent", () => {
    assert.equal(convo._memoryContent, "",
      "_memoryContent should be empty string initially");
  });

  it("starts with _msgCountAtLastUsage of 0", () => {
    assert.equal(convo._msgCountAtLastUsage, 0,
      "_msgCountAtLastUsage should start at 0");
  });
});

// ---------- addUserMessage ----------

describe("Conversation.addUserMessage", () => {
  it("adds a user message to the conversation", () => {
    convo.addUserMessage("Hello");
    assert.equal(convo.messages.length, 1, "should have 1 message");
    assert.equal(convo.messages[0].role, "user", "role should be user");
    assert.equal(convo.messages[0].content, "Hello", "content should match");
  });

  it("adds multiple user messages in sequence", () => {
    convo.addUserMessage("First");
    convo.addUserMessage("Second");
    convo.addUserMessage("Third");
    assert.equal(convo.messages.length, 3, "should have 3 messages");
    assert.equal(convo.messages[2].content, "Third", "third message content should match");
  });

  it("preserves message order", () => {
    convo.addUserMessage("msg-1");
    convo.addUserMessage("msg-2");
    assert.equal(convo.messages[0].content, "msg-1", "first message should be msg-1");
    assert.equal(convo.messages[1].content, "msg-2", "second message should be msg-2");
  });

  it("handles empty string content", () => {
    convo.addUserMessage("");
    assert.equal(convo.messages[0].content, "", "empty string should be stored");
  });
});

// ---------- addAssistantMessage ----------

describe("Conversation.addAssistantMessage", () => {
  it("adds an assistant message to the conversation", () => {
    convo.addAssistantMessage("Hi there!");
    assert.equal(convo.messages.length, 1, "should have 1 message");
    assert.equal(convo.messages[0].role, "assistant", "role should be assistant");
    assert.equal(convo.messages[0].content, "Hi there!", "content should match");
  });

  it("includes tool_calls when provided", () => {
    const toolCalls = [
      { id: "tc_1", type: "function", function: { name: "read_file", arguments: '{}' } },
    ];
    convo.addAssistantMessage(null, toolCalls);
    assert.equal(convo.messages[0].content, null, "content should be null");
    assert.deepEqual(convo.messages[0].tool_calls, toolCalls, "tool_calls should match");
  });

  it("does not include tool_calls property when not provided", () => {
    convo.addAssistantMessage("plain response");
    assert.equal(convo.messages[0].tool_calls, undefined,
      "tool_calls should not exist on plain messages");
  });

  it("does not include tool_calls when null is passed", () => {
    convo.addAssistantMessage("response", null);
    assert.equal(convo.messages[0].tool_calls, undefined,
      "tool_calls should not exist when null is passed");
  });
});

// ---------- addToolResult ----------

describe("Conversation.addToolResult", () => {
  it("adds a tool result message", () => {
    convo.addToolResult("tc_1", "file contents here");
    assert.equal(convo.messages.length, 1, "should have 1 message");
    assert.equal(convo.messages[0].role, "tool", "role should be tool");
    assert.equal(convo.messages[0].tool_call_id, "tc_1", "tool_call_id should match");
    assert.equal(convo.messages[0].content, "file contents here", "content should match");
  });
});

// ---------- getMessages ----------

describe("Conversation.getMessages", () => {
  it("returns messages with system prompt as first message", () => {
    convo.addUserMessage("Hello");
    const messages = convo.getMessages();
    assert.equal(messages.length, 2, "should have system + 1 user message");
    assert.equal(messages[0].role, "system", "first message should be system");
    assert.ok(messages[0].content.includes("You are a helpful assistant."),
      "system message should contain the prompt");
  });

  it("includes all conversation messages after system", () => {
    convo.addUserMessage("Hello");
    convo.addAssistantMessage("Hi");
    convo.addUserMessage("How are you?");
    const messages = convo.getMessages();
    assert.equal(messages.length, 4, "should have system + 3 messages");
    assert.equal(messages[1].role, "user", "second message should be user");
    assert.equal(messages[2].role, "assistant", "third message should be assistant");
    assert.equal(messages[3].role, "user", "fourth message should be user");
  });

  it("appends memory content to system prompt when available", () => {
    convo._memoryContent = "Important: The project uses TypeScript.";
    const messages = convo.getMessages();
    assert.ok(messages[0].content.includes("Accumulated Memory"),
      "system message should contain memory header");
    assert.ok(messages[0].content.includes("The project uses TypeScript"),
      "system message should contain memory content");
  });

  it("does not include memory section when _memoryContent is empty", () => {
    convo._memoryContent = "";
    const messages = convo.getMessages();
    assert.ok(!messages[0].content.includes("Accumulated Memory"),
      "system message should not contain memory header when empty");
  });

  it("does not mutate internal messages array", () => {
    convo.addUserMessage("test");
    const messages = convo.getMessages();
    messages.push({ role: "user", content: "injected" });
    assert.equal(convo.messages.length, 1,
      "internal messages should not be affected by external push");
  });
});

// ---------- updateSystemPrompt ----------

describe("Conversation.updateSystemPrompt", () => {
  it("updates the system prompt", () => {
    convo.updateSystemPrompt("You are a coding assistant.");
    assert.equal(convo.systemPrompt, "You are a coding assistant.",
      "systemPrompt should be updated");
  });

  it("updated prompt is reflected in getMessages", () => {
    convo.updateSystemPrompt("New prompt here.");
    const messages = convo.getMessages();
    assert.ok(messages[0].content.includes("New prompt here."),
      "getMessages should use updated prompt");
  });

  it("can set prompt to empty string", () => {
    convo.updateSystemPrompt("");
    assert.equal(convo.systemPrompt, "", "prompt should be empty string");
  });
});

// ---------- getTokenEstimate ----------

describe("Conversation.getTokenEstimate", () => {
  it("returns a positive number for non-empty conversation", () => {
    convo.addUserMessage("Hello, how are you?");
    convo.addAssistantMessage("I am fine, thanks!");
    convo.addUserMessage("Follow up question");
    convo.addAssistantMessage(null, [
      { id: "tc_est", type: "function", function: { name: "Read", arguments: '{}' } },
    ]);
    convo.addToolResult("tc_est", "tool output here");
    convo.addAssistantMessage("Done reading.");
    const estimate = convo.getTokenEstimate();
    assert.ok(typeof estimate === "number", "should return a number");
    assert.ok(estimate > 0, `estimate should be positive, got ${estimate}`);
  });

  it("returns a number even with no messages", () => {
    const estimate = convo.getTokenEstimate();
    assert.ok(typeof estimate === "number", "should return a number");
    // Should at least include system prompt tokens
    assert.ok(estimate > 0, "should include system prompt token estimate");
  });

  it("increases when messages are added", () => {
    const est1 = convo.getTokenEstimate();
    convo.addUserMessage("This is a message with some content.");
    const est2 = convo.getTokenEstimate();
    assert.ok(est2 > est1, `estimate should increase after adding message: ${est2} > ${est1}`);
  });

  it("uses API-reported usage as baseline when available", () => {
    convo.addUserMessage("Hello");
    convo.addAssistantMessage("Hi");
    // Simulate API usage report
    convo.updateUsage({ prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100 });

    // Add a new message after usage report
    convo.addUserMessage("Another message");
    const estimate = convo.getTokenEstimate();
    // Should be baseTokens (5000) + heuristic for new messages
    assert.ok(estimate >= 5000, `estimate should be at least 5000 (API-reported), got ${estimate}`);
  });

  it("falls back to full heuristic when no API usage available", () => {
    convo.addUserMessage("Hello");
    const estimate = convo.getTokenEstimate();
    // Without API usage, it uses heuristic based on system prompt + messages
    assert.ok(estimate > 0, "should provide a heuristic estimate");
  });

  it("includes memory content in estimate", () => {
    const estWithout = convo.getTokenEstimate();
    convo._memoryContent = "A ".repeat(1000); // ~2000 chars of memory
    const estWith = convo.getTokenEstimate();
    assert.ok(estWith > estWithout,
      `estimate with memory (${estWith}) should be greater than without (${estWithout})`);
  });
});

// ---------- getUsagePercent ----------

describe("Conversation.getUsagePercent", () => {
  it("returns a string with percentage and fraction", () => {
    convo.addUserMessage("test");
    const pct = convo.getUsagePercent();
    assert.ok(typeof pct === "string", "should return a string");
    assert.ok(pct.includes("%"), "should contain % symbol");
    assert.ok(pct.includes("/"), "should contain / separator");
    assert.ok(pct.includes("128000"), "should reference max context tokens");
  });
});

// ---------- updateUsage ----------

describe("Conversation.updateUsage", () => {
  it("stores usage information", () => {
    convo.updateUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    assert.deepEqual(convo._lastActualUsage, {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    }, "usage should be stored");
  });

  it("updates _msgCountAtLastUsage to current message count", () => {
    convo.addUserMessage("msg-1");
    convo.addAssistantMessage("reply-1");
    convo.updateUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    assert.equal(convo._msgCountAtLastUsage, 2,
      "_msgCountAtLastUsage should reflect current message count");
  });

  it("does not update when usage is null/undefined", () => {
    convo.updateUsage(null);
    assert.equal(convo._lastActualUsage, null,
      "should not update for null usage");
    convo.updateUsage(undefined);
    assert.equal(convo._lastActualUsage, null,
      "should not update for undefined usage");
  });
});

// ---------- clear ----------

describe("Conversation.clear", () => {
  it("empties the messages array", () => {
    convo.addUserMessage("Hello");
    convo.addAssistantMessage("Hi");
    convo.addUserMessage("Bye");
    convo.clear();
    assert.equal(convo.messages.length, 0, "messages should be empty after clear");
  });

  it("resets _lastActualUsage to null", () => {
    convo.updateUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    convo.clear();
    assert.equal(convo._lastActualUsage, null,
      "_lastActualUsage should be null after clear");
  });

  it("preserves the system prompt", () => {
    convo.clear();
    assert.equal(convo.systemPrompt, "You are a helpful assistant.",
      "system prompt should be preserved after clear");
  });

  it("preserves memory content across clears", () => {
    convo._memoryContent = "Important memory fact";
    convo.clear();
    assert.equal(convo._memoryContent, "Important memory fact",
      "memory content should persist after clear");
  });

  it("allows adding new messages after clear", () => {
    convo.addUserMessage("before");
    convo.clear();
    convo.addUserMessage("after");
    assert.equal(convo.messages.length, 1, "should have 1 message after clear + add");
    assert.equal(convo.messages[0].content, "after", "content should be the new message");
  });

  it("getMessages returns only system message after clear", () => {
    convo.addUserMessage("test");
    convo.clear();
    const messages = convo.getMessages();
    assert.equal(messages.length, 1, "should only have system message after clear");
    assert.equal(messages[0].role, "system", "remaining message should be system");
  });
});

// ---------- loadMemory ----------

describe("Conversation.loadMemory", () => {
  it("loads memory content from a MemoryManager-like object", async () => {
    const mockMemory = {
      async read() { return "loaded from memory"; },
    };
    await convo.loadMemory(mockMemory);
    assert.equal(convo._memoryContent, "loaded from memory",
      "_memoryContent should match what memory.read() returned");
  });

  it("does nothing when memory is null", async () => {
    await convo.loadMemory(null);
    assert.equal(convo._memoryContent, "",
      "_memoryContent should remain empty for null memory");
  });

  it("does nothing when memory is undefined", async () => {
    await convo.loadMemory(undefined);
    assert.equal(convo._memoryContent, "",
      "_memoryContent should remain empty for undefined memory");
  });

  it("loaded memory appears in getMessages system prompt", async () => {
    const mockMemory = {
      async read() { return "Project uses React and Node.js"; },
    };
    await convo.loadMemory(mockMemory);
    const messages = convo.getMessages();
    assert.ok(messages[0].content.includes("Project uses React and Node.js"),
      "system message should include loaded memory");
  });
});

// ---------- Full conversation flow ----------

describe("Conversation full flow", () => {
  it("handles a multi-turn conversation correctly", () => {
    convo.addUserMessage("What is 2+2?");
    convo.addAssistantMessage("2+2 = 4.");
    convo.addUserMessage("And 3+3?");
    convo.addAssistantMessage("3+3 = 6.");

    const messages = convo.getMessages();
    assert.equal(messages.length, 5, "should have system + 4 conversation messages");
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].content, "What is 2+2?");
    assert.equal(messages[2].content, "2+2 = 4.");
    assert.equal(messages[3].content, "And 3+3?");
    assert.equal(messages[4].content, "3+3 = 6.");
  });

  it("handles tool call flow correctly", () => {
    convo.addUserMessage("Read the file");
    convo.addAssistantMessage(null, [
      { id: "tc_1", type: "function", function: { name: "Read", arguments: '{"path": "test.js"}' } },
    ]);
    convo.addToolResult("tc_1", "console.log('hello');");
    convo.addAssistantMessage("The file contains a console.log statement.");

    const messages = convo.getMessages();
    assert.equal(messages.length, 5, "should have system + 4 messages");
    assert.equal(messages[2].role, "assistant");
    assert.equal(messages[2].content, null);
    assert.ok(messages[2].tool_calls, "assistant message should have tool_calls");
    assert.equal(messages[3].role, "tool");
    assert.equal(messages[3].tool_call_id, "tc_1");
  });
});
