// Test: RollbackManager — checkpoint creation, retrieval, rollback, max limits,
// checkpoint ID uniqueness, and edge cases
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RollbackManager } from "../src/rollback.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc2-rb-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------- Constructor and _detectGit ----------

describe("RollbackManager constructor", () => {
  it("stores the cwd", () => {
    const mgr = new RollbackManager(tmpDir);
    assert.equal(mgr.cwd, tmpDir, "cwd should be stored");
  });

  it("initializes with empty checkpoints array", () => {
    const mgr = new RollbackManager(tmpDir);
    assert.equal(mgr.checkpoints.length, 0, "checkpoints should start empty");
    assert.equal(mgr.count, 0, "count should be 0");
  });

  it("_detectGit returns false in a non-git temp directory", () => {
    const mgr = new RollbackManager(tmpDir);
    assert.equal(mgr._useGit, false, "should detect non-git directory");
  });
});

// ---------- createCheckpoint ----------

describe("RollbackManager.createCheckpoint", () => {
  it("stores a checkpoint and increments count", () => {
    const mgr = new RollbackManager(tmpDir);
    const messages = [{ role: "user", content: "hello" }];
    const cp = mgr.createCheckpoint("hello", messages);

    assert.equal(mgr.count, 1, "count should be 1 after one checkpoint");
    assert.equal(cp.index, 0, "first checkpoint index should be 0");
    assert.equal(cp.userMessage, "hello", "userMessage should match");
    assert.ok(cp.timestamp > 0, "timestamp should be positive");
    assert.equal(cp.gitHash, null, "gitHash should be null in non-git dir");
  });

  it("deep-clones messages so mutations are isolated", () => {
    const mgr = new RollbackManager(tmpDir);
    const messages = [{ role: "user", content: "original" }];
    mgr.createCheckpoint("msg", messages);

    // Mutate the original array after checkpoint
    messages.push({ role: "assistant", content: "added later" });
    messages[0].content = "mutated";

    const cp = mgr.checkpoints[0];
    assert.equal(cp.messageCount, 1, "checkpoint messageCount should not be affected by mutation");
  });

  it("truncates userMessage to 120 characters", () => {
    const mgr = new RollbackManager(tmpDir);
    const longMsg = "a".repeat(200);
    const cp = mgr.createCheckpoint(longMsg, []);
    assert.equal(cp.userMessage.length, 120, "userMessage should be truncated to 120 chars");
  });

  it("assigns a unique UUID id to each checkpoint", () => {
    const mgr = new RollbackManager(tmpDir);
    const cp1 = mgr.createCheckpoint("msg1", []);
    const cp2 = mgr.createCheckpoint("msg2", []);
    const cp3 = mgr.createCheckpoint("msg3", []);

    assert.ok(typeof cp1.id === "string" && cp1.id.length > 0, "id should be a non-empty string");
    assert.notEqual(cp1.id, cp2.id, "checkpoint IDs should be unique (1 vs 2)");
    assert.notEqual(cp2.id, cp3.id, "checkpoint IDs should be unique (2 vs 3)");
    assert.notEqual(cp1.id, cp3.id, "checkpoint IDs should be unique (1 vs 3)");
  });

  it("stores messageCount matching the messages array length", () => {
    const mgr = new RollbackManager(tmpDir);
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you" },
    ];
    const cp = mgr.createCheckpoint("how are you", messages);
    assert.equal(cp.messageCount, 3, "messageCount should equal messages.length");
  });

  it("stores timestamp close to current time", () => {
    const mgr = new RollbackManager(tmpDir);
    const before = Date.now();
    const cp = mgr.createCheckpoint("test", []);
    const after = Date.now();
    assert.ok(cp.timestamp >= before && cp.timestamp <= after,
      "timestamp should be between before and after creation time");
  });
});

// ---------- MAX_CHECKPOINTS limit ----------

describe("RollbackManager MAX_CHECKPOINTS limit", () => {
  it("enforces maximum of 10 checkpoints", () => {
    const mgr = new RollbackManager(tmpDir);

    // Create 12 checkpoints — should cap at 10
    for (let i = 0; i < 12; i++) {
      mgr.createCheckpoint(`msg-${i}`, [{ role: "user", content: `msg-${i}` }]);
    }

    assert.equal(mgr.count, 10, "should not exceed MAX_CHECKPOINTS (10)");
  });

  it("evicts the oldest checkpoint when limit is reached", () => {
    const mgr = new RollbackManager(tmpDir);

    for (let i = 0; i < 12; i++) {
      mgr.createCheckpoint(`msg-${i}`, [{ role: "user", content: `msg-${i}` }]);
    }

    // The oldest surviving checkpoint should be msg-2 (msg-0 and msg-1 were evicted)
    const list = mgr.getCheckpoints();
    assert.ok(!list.some((cp) => cp.userMessage === "msg-0"),
      "msg-0 should have been evicted");
    assert.ok(!list.some((cp) => cp.userMessage === "msg-1"),
      "msg-1 should have been evicted");
    // The newest should still be present
    assert.ok(list.some((cp) => cp.userMessage === "msg-11"),
      "msg-11 should still be present");
  });

  it("maintains exactly MAX_CHECKPOINTS after many additions", () => {
    const mgr = new RollbackManager(tmpDir);

    for (let i = 0; i < 25; i++) {
      mgr.createCheckpoint(`msg-${i}`, []);
    }

    assert.equal(mgr.count, 10, "count should be exactly 10 after 25 additions");
  });
});

// ---------- Checkpoint ID uniqueness ----------

describe("Checkpoint ID uniqueness", () => {
  it("all checkpoint IDs are unique across many checkpoints", () => {
    const mgr = new RollbackManager(tmpDir);
    const ids = new Set();

    for (let i = 0; i < 20; i++) {
      const cp = mgr.createCheckpoint(`msg-${i}`, []);
      ids.add(cp.id);
    }

    // Due to MAX_CHECKPOINTS, only 10 remain, but we captured all 20 IDs
    assert.equal(ids.size, 20, "all 20 checkpoint IDs should be unique");
  });

  it("IDs look like valid UUIDs", () => {
    const mgr = new RollbackManager(tmpDir);
    const cp = mgr.createCheckpoint("test", []);
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidRegex.test(cp.id), `ID should be a valid UUID, got: ${cp.id}`);
  });
});

// ---------- getCheckpoints ----------

describe("RollbackManager.getCheckpoints", () => {
  it("returns summary objects for all checkpoints", () => {
    const mgr = new RollbackManager(tmpDir);
    mgr.createCheckpoint("first", [{ role: "user", content: "first" }]);
    mgr.createCheckpoint("second", [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);

    const list = mgr.getCheckpoints();
    assert.equal(list.length, 2, "should have 2 checkpoints");
    assert.equal(list[0].index, 0, "first checkpoint index should be 0");
    assert.equal(list[0].userMessage, "first", "first userMessage should match");
    assert.equal(list[1].index, 1, "second checkpoint index should be 1");
    assert.ok(typeof list[1].date === "string", "date should be a string");
  });

  it("returns empty array when no checkpoints exist", () => {
    const mgr = new RollbackManager(tmpDir);
    const list = mgr.getCheckpoints();
    assert.equal(list.length, 0, "should return empty array");
  });

  it("each summary has index, timestamp, date, and userMessage", () => {
    const mgr = new RollbackManager(tmpDir);
    mgr.createCheckpoint("test", []);
    const [summary] = mgr.getCheckpoints();

    assert.ok("index" in summary, "summary should have index");
    assert.ok("timestamp" in summary, "summary should have timestamp");
    assert.ok("date" in summary, "summary should have date");
    assert.ok("userMessage" in summary, "summary should have userMessage");
    assert.equal(typeof summary.timestamp, "number", "timestamp should be a number");
    assert.equal(typeof summary.date, "string", "date should be a string");
  });

  it("does not expose internal fields like messages or id", () => {
    const mgr = new RollbackManager(tmpDir);
    mgr.createCheckpoint("test", [{ role: "user", content: "hi" }]);
    const [summary] = mgr.getCheckpoints();

    assert.equal(summary.messages, undefined, "messages should not be in summary");
    assert.equal(summary.id, undefined, "id should not be in summary");
    assert.equal(summary.gitHash, undefined, "gitHash should not be in summary");
  });
});

// ---------- getLatest (via checkpoints array) ----------

describe("RollbackManager getLatest checkpoint", () => {
  it("returns the most recently created checkpoint", () => {
    const mgr = new RollbackManager(tmpDir);
    mgr.createCheckpoint("first", [{ role: "user", content: "1" }]);
    mgr.createCheckpoint("second", [{ role: "user", content: "2" }]);
    mgr.createCheckpoint("third", [{ role: "user", content: "3" }]);

    const latest = mgr.checkpoints[mgr.checkpoints.length - 1];
    assert.equal(latest.userMessage, "third", "latest checkpoint should be the last created");
  });

  it("returns undefined when no checkpoints exist", () => {
    const mgr = new RollbackManager(tmpDir);
    const latest = mgr.checkpoints[mgr.checkpoints.length - 1];
    assert.equal(latest, undefined, "should be undefined when no checkpoints");
  });
});

// ---------- contextRollback ----------

describe("RollbackManager.contextRollback", () => {
  it("restores messages from a previous checkpoint", () => {
    const mgr = new RollbackManager(tmpDir);
    const msgs1 = [{ role: "user", content: "turn 1" }];
    mgr.createCheckpoint("turn 1", msgs1);

    const msgs2 = [...msgs1, { role: "assistant", content: "reply" }, { role: "user", content: "turn 2" }];
    mgr.createCheckpoint("turn 2", msgs2);

    const result = mgr.contextRollback(0, msgs2);
    assert.equal(result.restored, true, "should report restored");
    assert.equal(result.messages.length, 1, "should restore single message");
    assert.equal(result.messages[0].content, "turn 1", "should restore correct content");
    // Checkpoints after index 0 should be removed
    assert.equal(mgr.count, 1, "should trim checkpoints after rollback index");
  });

  it("returns restored:false for invalid index", () => {
    const mgr = new RollbackManager(tmpDir);
    const result = mgr.contextRollback(99);
    assert.equal(result.restored, false, "should not restore for invalid index");
    assert.equal(result.messages, null, "messages should be null");
  });

  it("returns a new array so push/pop do not affect the live messages", () => {
    const mgr = new RollbackManager(tmpDir);
    const messages = [{ role: "user", content: "original" }];
    mgr.createCheckpoint("test", messages);

    const result = mgr.contextRollback(0, messages);
    // The returned array should be a different reference (slice creates a new array)
    assert.notEqual(result.messages, messages, "returned array should not be the same reference");
    result.messages.push({ role: "assistant", content: "extra" });

    // The original messages array should not be affected by pushing to the result
    assert.equal(messages.length, 1, "original messages length should not change");
  });
});

// ---------- fullRollback ----------

describe("RollbackManager.fullRollback", () => {
  it("returns restored:false for invalid index", () => {
    const mgr = new RollbackManager(tmpDir);
    const result = mgr.fullRollback(5);
    assert.equal(result.restored, false, "should not restore for invalid index");
    assert.equal(result.fileRestored, false, "fileRestored should be false");
    assert.equal(result.messages, null, "messages should be null");
  });

  it("in non-git env restores context but skips file restore", () => {
    const mgr = new RollbackManager(tmpDir);
    const msgs = [{ role: "user", content: "state A" }];
    mgr.createCheckpoint("state A", msgs);
    const msgs2 = [...msgs, { role: "user", content: "state B" }];
    mgr.createCheckpoint("state B", msgs2);

    const result = mgr.fullRollback(0, msgs2);
    assert.equal(result.restored, true, "should restore");
    assert.equal(result.fileRestored, false, "fileRestored should be false in non-git env");
    assert.equal(result.messages.length, 1, "should restore single message");
    assert.equal(result.messages[0].content, "state A", "should restore correct content");
    assert.equal(mgr.count, 1, "should trim checkpoints");
  });

  it("trims checkpoints after the restored index", () => {
    const mgr = new RollbackManager(tmpDir);
    mgr.createCheckpoint("cp-0", []);
    mgr.createCheckpoint("cp-1", [{ role: "user", content: "1" }]);
    const msgs = [{ role: "user", content: "1" }, { role: "user", content: "2" }];
    mgr.createCheckpoint("cp-2", msgs);

    assert.equal(mgr.count, 3, "should have 3 checkpoints before rollback");
    mgr.fullRollback(1, msgs);
    assert.equal(mgr.count, 2, "should have 2 checkpoints after rolling back to index 1");
  });
});

// ---------- count getter ----------

describe("RollbackManager.count", () => {
  it("returns 0 initially", () => {
    const mgr = new RollbackManager(tmpDir);
    assert.equal(mgr.count, 0, "count should be 0 initially");
  });

  it("increases with each checkpoint", () => {
    const mgr = new RollbackManager(tmpDir);
    mgr.createCheckpoint("a", []);
    assert.equal(mgr.count, 1, "count should be 1");
    mgr.createCheckpoint("b", []);
    assert.equal(mgr.count, 2, "count should be 2");
  });

  it("decreases after rollback", () => {
    const mgr = new RollbackManager(tmpDir);
    const messages = [];
    mgr.createCheckpoint("a", messages);
    mgr.createCheckpoint("b", messages);
    mgr.createCheckpoint("c", messages);
    mgr.contextRollback(0, messages);
    assert.equal(mgr.count, 1, "count should be 1 after rolling back to index 0");
  });
});
