import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RollbackManager } from "../src/rollback.js";

describe("RollbackManager", () => {
  it("starts with zero checkpoints", () => { const rm = new RollbackManager("/tmp"); assert.equal(rm.count, 0); });
  it("creates checkpoint", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("hi", [{ role: "user", content: "hi" }]);
    assert.equal(rm.count, 1);
  });
  it("deep clones messages in checkpoint", () => {
    const rm = new RollbackManager("/tmp");
    const msgs = [{ role: "user", content: "original" }];
    rm.createCheckpoint("original", msgs);
    msgs[0].content = "changed";
    const restored = rm.contextRollback(0);
    assert.equal(restored.messages[0].content, "original");
  });
  it("getCheckpoints returns list", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("msg1", [{ role: "user", content: "msg1" }]);
    rm.createCheckpoint("msg2", [{ role: "user", content: "msg2" }]);
    const cps = rm.getCheckpoints();
    assert.equal(cps.length, 2);
  });
  it("contextRollback restores messages", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("v1", [{ role: "user", content: "v1" }]);
    rm.createCheckpoint("v2", [{ role: "user", content: "v1" }, { role: "user", content: "v2" }]);
    const r = rm.contextRollback(0);
    assert.ok(r.restored);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].content, "v1");
  });
  it("contextRollback returns not-restored for invalid index", () => {
    const rm = new RollbackManager("/tmp");
    const r = rm.contextRollback(99);
    assert.equal(r.restored, false);
    assert.equal(r.messages, null);
  });
  it("fullRollback returns not-restored for invalid index", () => {
    const rm = new RollbackManager("/tmp");
    const r = rm.fullRollback(99);
    assert.equal(r.restored, false);
    assert.equal(r.messages, null);
  });
  it("fullRollback restores state", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("v1", [{ role: "user", content: "v1" }]);
    rm.createCheckpoint("v2", [{ role: "user", content: "v1" }, { role: "user", content: "v2" }]);
    const r = rm.fullRollback(0);
    assert.ok(r.restored);
    assert.equal(r.messages[0].content, "v1");
  });
  it("count getter works", () => {
    const rm = new RollbackManager("/tmp");
    assert.equal(rm.count, 0);
    rm.createCheckpoint("a", []);
    assert.equal(rm.count, 1);
  });
  it("getCheckpoints has info", () => {
    const rm = new RollbackManager("/tmp");
    rm.createCheckpoint("hello world", [{ role: "user", content: "hello world" }]);
    const cps = rm.getCheckpoints();
    assert.ok(cps.length > 0);
  });
});
