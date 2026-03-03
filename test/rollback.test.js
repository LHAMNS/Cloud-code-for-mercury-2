/**
 * Tests for rollback.js — RollbackManager and Checkpoint.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RollbackManager } from "../src/rollback.js";

describe("RollbackManager", () => {
  it("starts with zero checkpoints", () => {
    const rm = new RollbackManager("/tmp");
    assert.equal(rm.count, 0);
    assert.deepEqual(rm.getCheckpoints(), []);
  });
  it("createCheckpoint adds checkpoint", () => {
    const rm = new RollbackManager("/tmp");
    const cp = rm.createCheckpoint("First message", [{ role: "user", content: "Hello" }]);
    assert.equal(rm.count, 1);
    assert.equal(cp.index, 0);
    assert.ok(cp.timestamp > 0);
    assert.equal(cp.userMessage, "First message");
  });
  it("multiple checkpoints have sequential indices", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("cp0", []);
    rm.createCheckpoint("cp1", [{ role: "user", content: "Hi" }]);
    rm.createCheckpoint("cp2", [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }]);
    assert.equal(rm.count, 3);
    const list = rm.getCheckpoints();
    assert.equal(list[0].index, 0);
    assert.equal(list[1].index, 1);
    assert.equal(list[2].index, 2);
  });
  it("contextRollback restores messages", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("cp0", []);
    rm.createCheckpoint("cp1", [{ role: "user", content: "Hello" }]);
    const result = rm.contextRollback(0);
    assert.ok(result.restored);
    assert.deepEqual(result.messages, []);
    assert.equal(rm.count, 1); // only cp0 remains
  });
  it("contextRollback returns false for invalid index", () => {
    const rm = new RollbackManager("/tmp");
    const result = rm.contextRollback(99);
    assert.equal(result.restored, false);
    assert.equal(result.messages, null);
  });
  it("fullRollback returns false for invalid index", () => {
    const rm = new RollbackManager("/tmp");
    const result = rm.fullRollback(99);
    assert.equal(result.restored, false);
  });
  it("deep-clones messages on checkpoint", () => {
    const rm = new RollbackManager("/tmp");
    const msgs = [{ role: "user", content: "Original" }];
    rm.createCheckpoint("test", msgs);
    msgs[0].content = "Modified";
    const result = rm.contextRollback(0);
    assert.equal(result.messages[0].content, "Original", "Should preserve original");
  });
  it("truncates long userMessage in checkpoint", () => {
    const rm = new RollbackManager("/tmp");
    const longMsg = "x".repeat(200);
    rm.createCheckpoint(longMsg, []);
    const list = rm.getCheckpoints();
    assert.ok(list[0].userMessage.length <= 120);
  });
});
