/**
 * Tests for memory.js — MemoryManager and ConversationLog.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryManager, ConversationLog } from "../src/memory.js";

let tmpDir;
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mem-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });

describe("MemoryManager", () => {
  it("read returns empty for new directory", async () => {
    const mem = new MemoryManager(tmpDir);
    assert.equal(await mem.read(), "");
  });
  it("write and read round-trip", async () => {
    const mem = new MemoryManager(tmpDir);
    await mem.write("Test memory content");
    assert.equal(await mem.read(), "Test memory content");
  });
  it("append adds content", async () => {
    const mem = new MemoryManager(tmpDir);
    await mem.append("First fact");
    await mem.append("Second fact");
    const content = await mem.read();
    assert.ok(content.includes("First fact"));
    assert.ok(content.includes("Second fact"));
  });
  it("append skips empty content", async () => {
    const mem = new MemoryManager(tmpDir);
    await mem.append("");
    await mem.append("   ");
    assert.equal(await mem.read(), "");
  });
  it("trimOldest removes oldest sections", () => {
    const mem = new MemoryManager(tmpDir);
    const existing = "old1\n\n---\n\nold2\n\n---\n\nold3";
    const result = mem._trimOldest(existing, 80000);
    assert.ok(!result.includes("old1") || result.includes("old3"));
  });
});

describe("ConversationLog", () => {
  it("append creates JSONL entries", async () => {
    const log = new ConversationLog(tmpDir);
    await log.append({ role: "user", content: "Hello" });
    await log.append({ role: "assistant", content: "Hi" });
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path.join(tmpDir, ".mercury", "conversation.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.role, "user");
    assert.ok(first.ts, "Should have timestamp");
  });
  it("clear empties the log", async () => {
    const log = new ConversationLog(tmpDir);
    await log.append({ role: "user", content: "test" });
    await log.clear();
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path.join(tmpDir, ".mercury", "conversation.jsonl"), "utf-8");
    assert.equal(content, "");
  });
});
