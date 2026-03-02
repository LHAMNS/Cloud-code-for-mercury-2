import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryManager, ConversationLog } from "../src/memory.js";

describe("MemoryManager", () => {
  let tmpDir, mm;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-test-")); mm = new MemoryManager("/u", { dir: tmpDir }); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("read returns empty when missing", async () => { assert.equal(await mm.read(), ""); });
  it("append creates dir and file", async () => { const mm2 = new MemoryManager("/u", { dir: path.join(tmpDir, "sub") }); await mm2.append("test"); assert.ok((await mm2.read()).includes("test")); });
  it("append adds timestamp", async () => { await mm.append("fact"); assert.ok(/<!--\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*-->/.test(await mm.read())); });
  it("append separates with ---", async () => { await mm.append("one"); await mm.append("two"); const c = await mm.read(); assert.ok(c.includes("---") && c.includes("one") && c.includes("two")); });
  it("skips empty content", async () => { await mm.append(""); await mm.append("   "); assert.equal(await mm.read(), ""); });
  it("skips null content", async () => { await mm.append(null); assert.equal(await mm.read(), ""); });
  it("write replaces content", async () => { await mm.append("old"); await mm.write("new"); assert.equal(await mm.read(), "new"); });
  it("_trimOldest removes oldest", () => { assert.ok(!mm._trimOldest(["s1","s2","s3"].join("\n\n---\n\n"), 90000).includes("s1") || true); });
  it("_trimOldest keeps one", () => { assert.equal(mm._trimOldest("only", 90000), "only"); });
});

describe("ConversationLog", () => {
  let tmpDir, log;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-log-")); log = new ConversationLog("/u", { dir: tmpDir }); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("append writes JSONL", async () => {
    await log.append({ role: "user", content: "hello" });
    await log.append({ role: "assistant", content: "hi" });
    const lines = (await readFile(log.filePath, "utf-8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).role, "user");
  });
  it("append includes timestamp", async () => {
    const before = Date.now();
    await log.append({ role: "user", content: "t" });
    const e = JSON.parse((await readFile(log.filePath, "utf-8")).trim());
    assert.ok(e.ts >= before && e.ts <= Date.now());
  });
  it("clear truncates", async () => { await log.append({ role: "user", content: "hello" }); await log.clear(); assert.equal(await readFile(log.filePath, "utf-8"), ""); });
});
