// Tests for src/ai-safety-decide.js — AiSafetyDecider
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiSafetyDecider, MODE_AI_SAFETY_DECIDE } from "../src/ai-safety-decide.js";

process.env.INCEPTION_API_KEY = process.env.INCEPTION_API_KEY || "test-key-for-unit-tests";

/**
 * Helper: create an AiSafetyDecider with a stubbed MercuryClient so tests
 * never make real API calls. The stub is injected after construction by
 * replacing the `client` property.
 */
function makeDecider(opts = {}) {
  const decider = new AiSafetyDecider({
    apiKey: "test-key",
    baseURL: "https://test.example.com",
    workspace: "/tmp/workspace",
    timeout: opts.timeout ?? 5000,
    maxHistoryMessages: opts.maxHistoryMessages ?? 10,
    onInfo: opts.onInfo ?? null,
  });
  // Stub out the real client so evaluate() never hits the network
  decider.client = {
    chatCompletion: opts.chatCompletionStub ?? (async () => ({
      choices: [{ message: { content: '{"decision":"ALLOW","confidence":0.95,"reason":"safe"}' } }],
    })),
  };
  return decider;
}

describe("AiSafetyDecider", () => {
  it("constructor initializes with correct defaults", () => {
    const decider = new AiSafetyDecider({
      apiKey: "k",
      baseURL: "https://x.com",
    });
    assert.equal(decider.workspace, process.cwd());
    assert.equal(decider.timeout, 15000);
    assert.equal(decider.maxHistoryMessages, 10);
    assert.deepEqual(decider._stats, { allowed: 0, denied: 0, escalated: 0, errors: 0 });
    assert.equal(decider._decisionCache.size, 0);
  });

  it("constructor respects custom options", () => {
    const decider = new AiSafetyDecider({
      workspace: "/my/workspace",
      timeout: 3000,
      maxHistoryMessages: 5,
    });
    assert.equal(decider.workspace, "/my/workspace");
    assert.equal(decider.timeout, 3000);
    assert.equal(decider.maxHistoryMessages, 5);
  });

  it("_parseDecision() parses ALLOW response correctly", () => {
    const decider = makeDecider();
    const result = decider._parseDecision(
      '{"decision":"ALLOW","confidence":0.95,"reason":"File read is safe"}',
      "Read"
    );
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.confidence, 0.95);
    assert.equal(result.reason, "File read is safe");
  });

  it("_parseDecision() parses DENY response with suggestion", () => {
    const decider = makeDecider();
    const result = decider._parseDecision(
      '{"decision":"DENY","confidence":0.9,"reason":"Attempts to delete root","suggestion":"Use a scoped delete instead"}',
      "Bash"
    );
    assert.equal(result.decision, "DENY");
    assert.equal(result.confidence, 0.9);
    assert.equal(result.reason, "Attempts to delete root");
    assert.equal(result.suggestion, "Use a scoped delete instead");
  });

  it("_parseDecision() parses ESCALATE response", () => {
    const decider = makeDecider();
    const result = decider._parseDecision(
      '{"decision":"ESCALATE","confidence":0.5,"reason":"Uncertain about network call"}',
      "WebFetch"
    );
    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.confidence, 0.5);
    assert.equal(result.reason, "Uncertain about network call");
  });

  it("_parseDecision() defaults to ESCALATE on empty/malformed input", () => {
    const decider = makeDecider();

    const empty = decider._parseDecision("", "Bash");
    assert.equal(empty.decision, "ESCALATE");
    assert.equal(empty.confidence, 0);

    const garbage = decider._parseDecision("not json at all", "Bash");
    assert.equal(garbage.decision, "ESCALATE");

    const broken = decider._parseDecision("{invalid json{{{", "Bash");
    assert.equal(broken.decision, "ESCALATE");
  });

  it("_parseDecision() escalates low-confidence ALLOW (< 0.7)", () => {
    const decider = makeDecider();
    const result = decider._parseDecision(
      '{"decision":"ALLOW","confidence":0.5,"reason":"Might be safe"}',
      "Bash"
    );
    assert.equal(result.decision, "ESCALATE", "low-confidence ALLOW should become ESCALATE");
    assert.equal(result.confidence, 0.5);
  });

  it("_parseDecision() rejects invalid decision values", () => {
    const decider = makeDecider();
    const result = decider._parseDecision(
      '{"decision":"MAYBE","confidence":0.8,"reason":"not a valid value"}',
      "Read"
    );
    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.confidence, 0);
  });

  it("_buildEvalContext() builds prompt with tool name, args, workspace, and task", () => {
    const decider = makeDecider();
    const context = decider._buildEvalContext(
      "Bash",
      { command: "ls -la" },
      "List files in current directory",
      []
    );
    assert.ok(context.includes("Bash"), "should contain tool name");
    assert.ok(context.includes("ls -la"), "should contain tool argument");
    assert.ok(context.includes("List files"), "should contain user task");
    assert.ok(context.includes("/tmp/workspace"), "should contain workspace path");
    assert.ok(context.includes("<evaluation-request>"), "should use XML structure");
  });

  it("_buildEvalContext() includes conversation history and truncates long values", () => {
    const decider = makeDecider({ maxHistoryMessages: 2 });
    const history = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "response one" },
      { role: "user", content: "second message" },
    ];
    const context = decider._buildEvalContext(
      "Write",
      { file_path: "/tmp/workspace/x.js", content: "A".repeat(600) },
      "Create a file",
      history
    );
    // Should include only the last 2 messages
    assert.ok(context.includes("second message"), "should include recent history");
    assert.ok(context.includes("response one"), "should include 2nd-to-last message");
    // Long arg value should be truncated
    assert.ok(context.includes("...[truncated]"), "should truncate long argument values");
  });

  it("evaluate() returns ESCALATE on API timeout/error", async () => {
    const decider = makeDecider({
      timeout: 50,
      chatCompletionStub: () => new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 200)
      ),
    });
    const result = await decider.evaluate("Bash", { command: "echo hi" }, "test");
    assert.equal(result.decision, "ESCALATE");
    assert.ok(result.reason.includes("Safety evaluation"), "reason should mention evaluation failure");
    assert.equal(decider._stats.errors, 1);
  });

  it("MODE_AI_SAFETY_DECIDE constant is correct", () => {
    assert.equal(MODE_AI_SAFETY_DECIDE, "aiSafetyDecide");
  });
});
