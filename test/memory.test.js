// Test: MemoryManager + ConversationLog — file-based persistence
// Tests constructor, read, append, write, replace, _trimOldest, ConversationLog.append/read/clear
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryManager, ConversationLog } from "../src/memory.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc2-mem-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------- MemoryManager constructor ----------

describe("MemoryManager constructor", () => {
  it("sets dir based on cwd when no opts.dir is provided", () => {
    const mm = new MemoryManager("/some/project");
    assert.ok(mm.dir.includes(".mercury"), "dir should include .mercury subdirectory");
    assert.ok(mm.filePath.includes("memory.md"), "filePath should include memory.md");
  });

  it("uses opts.dir directly when provided", () => {
    const customDir = path.join(tmpDir, "custom-mem");
    const mm = new MemoryManager(tmpDir, { dir: customDir });
    assert.equal(mm.dir, customDir, "dir should be the custom directory");
    assert.equal(mm.filePath, path.join(customDir, "memory.md"), "filePath should use custom dir");
  });

  it("initializes _writeQueue as a resolved promise", () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    assert.ok(mm._writeQueue instanceof Promise, "_writeQueue should be a Promise");
  });
});

// ---------- MemoryManager.read ----------

describe("MemoryManager.read", () => {
  it("returns empty string when file does not exist", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const content = await mm.read();
    assert.equal(content, "", "read should return empty string for nonexistent file");
  });

  it("returns content after write", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.write("test content here");
    const content = await mm.read();
    assert.equal(content, "test content here", "read should return what was written");
  });

  it("returns content from nested .mercury directory", async () => {
    const mm = new MemoryManager(tmpDir); // uses default .mercury subdir
    await mm.write("nested content");
    const content = await mm.read();
    assert.equal(content, "nested content", "should read from .mercury subdirectory");
  });
});

// ---------- MemoryManager.append ----------

describe("MemoryManager.append", () => {
  it("creates the memory file if it does not exist", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.append("first fact");
    const content = await mm.read();
    assert.ok(content.includes("first fact"), "should contain appended content");
  });

  it("adds timestamped blocks with separator", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.append("fact one");
    await mm.append("fact two");
    const content = await mm.read();

    assert.ok(content.includes("fact one"), "should contain first fact");
    assert.ok(content.includes("fact two"), "should contain second fact");
    assert.ok(content.includes("---"), "should contain separator between blocks");
    // Check timestamp comment format
    assert.ok(/<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} -->/.test(content),
      "should contain timestamp in comment format");
  });

  it("skips empty or whitespace-only content", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.append("");
    await mm.append("   ");
    await mm.append(null);
    await mm.append(undefined);
    const content = await mm.read();
    assert.equal(content, "", "nothing should be appended for empty/whitespace/null content");
  });

  it("trims the content before appending", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.append("  trimmed content  ");
    const content = await mm.read();
    assert.ok(content.includes("trimmed content"), "content should be trimmed");
    assert.ok(!content.includes("  trimmed content  "), "leading/trailing spaces should be removed");
  });

  it("creates directory recursively if needed", async () => {
    const deepDir = path.join(tmpDir, "deep", "nested", "dir");
    const mm = new MemoryManager(tmpDir, { dir: deepDir });
    await mm.append("deep fact");
    const content = await mm.read();
    assert.ok(content.includes("deep fact"), "should write to deeply nested directory");
  });

  it("handles concurrent appends via write queue", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    // Fire multiple appends concurrently
    await Promise.all([
      mm.append("concurrent-1"),
      mm.append("concurrent-2"),
      mm.append("concurrent-3"),
    ]);
    const content = await mm.read();
    assert.ok(content.includes("concurrent-1"), "should contain first concurrent fact");
    assert.ok(content.includes("concurrent-2"), "should contain second concurrent fact");
    assert.ok(content.includes("concurrent-3"), "should contain third concurrent fact");
  });

  it("deduplicates repeated appended content", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.append("same fact");
    await mm.append("same fact");

    const content = await mm.read();
    const occurrences = content.match(/same fact/g) || [];
    assert.equal(occurrences.length, 1, "duplicate facts should only be stored once");
  });
});

// ---------- MemoryManager.write (replace) ----------

describe("MemoryManager.write (replace)", () => {
  it("stores content that can be read back", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.write("hello world");
    const content = await mm.read();
    assert.equal(content, "hello world", "write should store content exactly");
  });

  it("overwrites previous content entirely", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.write("original");
    await mm.write("replaced");
    const content = await mm.read();
    assert.equal(content, "replaced", "write should replace all previous content");
    assert.ok(!content.includes("original"), "original content should be gone");
  });

  it("can write empty string to clear the file", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    await mm.write("some data");
    await mm.write("");
    const content = await mm.read();
    assert.equal(content, "", "writing empty string should clear the file");
  });

  it("creates directory if it does not exist", async () => {
    const newDir = path.join(tmpDir, "new-dir");
    const mm = new MemoryManager(tmpDir, { dir: newDir });
    await mm.write("new dir content");
    const content = await mm.read();
    assert.equal(content, "new dir content", "should create dir and write content");
  });
});

// ---------- MemoryManager._trimOldest ----------

describe("MemoryManager._trimOldest", () => {
  it("removes oldest sections to make room", () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const sections = ["section-A", "section-B", "section-C"].join("\n\n---\n\n");
    // needSpace large enough to force trimming
    const trimmed = mm._trimOldest(sections, 80000);
    // At least the oldest section should be removed
    assert.ok(!trimmed.includes("section-A") || trimmed.includes("section-C"),
      "oldest section should be removed");
    assert.ok(trimmed.includes("section-C"), "newest section must survive");
  });

  it("preserves all sections when there is enough space", () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const sections = ["small-A", "small-B", "small-C"].join("\n\n---\n\n");
    const trimmed = mm._trimOldest(sections, 10); // very small needSpace
    assert.ok(trimmed.includes("small-A"), "should keep all sections when space allows");
    assert.ok(trimmed.includes("small-B"), "should keep all sections when space allows");
    assert.ok(trimmed.includes("small-C"), "should keep all sections when space allows");
  });

  it("keeps at least the last section even if it exceeds limit", () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const bigSection = "x".repeat(90000);
    const sections = ["old", bigSection].join("\n\n---\n\n");
    const trimmed = mm._trimOldest(sections, 1000);
    // The loop stops when sections.length === 1, so the big section remains
    assert.ok(trimmed.includes(bigSection), "should keep last section even if over limit");
  });

  it("handles single section input without removing it", () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const trimmed = mm._trimOldest("only-section", 90000);
    assert.equal(trimmed, "only-section", "single section should not be removed");
  });

  it("removes multiple oldest sections progressively", () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const sections = ["A", "B", "C", "D", "E"].join("\n\n---\n\n");
    // Require almost all space -> should trim most sections
    const trimmed = mm._trimOldest(sections, 79990);
    assert.ok(trimmed.includes("E"), "newest section should survive");
  });
});

// ---------- MemoryManager._atomicWrite ----------

describe("MemoryManager._atomicWrite", () => {
  it("creates a temp file then renames to final path", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const target = path.join(tmpDir, "atomic-test.md");
    await mm._atomicWrite(target, "atomic content");
    const result = await readFile(target, "utf-8");
    assert.equal(result, "atomic content", "should write content atomically");
  });

  it("overwrites existing file atomically", async () => {
    const mm = new MemoryManager(tmpDir, { dir: tmpDir });
    const target = path.join(tmpDir, "atomic-overwrite.md");
    await mm._atomicWrite(target, "first");
    await mm._atomicWrite(target, "second");
    const result = await readFile(target, "utf-8");
    assert.equal(result, "second", "should overwrite with atomic rename");
  });
});

// ---------- ConversationLog ----------

describe("ConversationLog constructor", () => {
  it("sets filePath to conversation.jsonl in the directory", () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    assert.ok(log.filePath.endsWith("conversation.jsonl"),
      "filePath should end with conversation.jsonl");
  });

  it("uses .mercury subdir when no opts.dir provided", () => {
    const log = new ConversationLog("/some/project");
    assert.ok(log.dir.includes(".mercury"), "dir should include .mercury");
  });
});

describe("ConversationLog.append", () => {
  it("creates JSONL lines with ts field", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await log.append({ role: "user", content: "hello" });
    await log.append({ role: "assistant", content: "hi" });

    const raw = await readFile(log.filePath, "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2, "should have two lines");

    const first = JSON.parse(lines[0]);
    assert.equal(first.role, "user", "first line role should be user");
    assert.equal(first.content, "hello", "first line content should be hello");
    assert.ok(typeof first.ts === "number", "ts should be a numeric timestamp");
  });

  it("preserves all message fields", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await log.append({ role: "tool", tool_call_id: "tc_123", content: "result" });

    const raw = await readFile(log.filePath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.role, "tool", "role should be preserved");
    assert.equal(parsed.tool_call_id, "tc_123", "tool_call_id should be preserved");
    assert.equal(parsed.content, "result", "content should be preserved");
  });

  it("handles concurrent appends without data loss", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await Promise.all([
      log.append({ role: "user", content: "msg-1" }),
      log.append({ role: "user", content: "msg-2" }),
      log.append({ role: "user", content: "msg-3" }),
    ]);

    const raw = await readFile(log.filePath, "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 3, "should have three lines for three appends");
  });

  it("timestamps increase monotonically", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await log.append({ role: "user", content: "first" });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await log.append({ role: "user", content: "second" });

    const raw = await readFile(log.filePath, "utf-8");
    const lines = raw.trim().split("\n");
    const ts1 = JSON.parse(lines[0]).ts;
    const ts2 = JSON.parse(lines[1]).ts;
    assert.ok(ts2 >= ts1, "second timestamp should be >= first");
  });
});

describe("ConversationLog.clear", () => {
  it("empties the conversation file", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await log.append({ role: "user", content: "data" });
    await log.clear();

    const raw = await readFile(log.filePath, "utf-8");
    assert.equal(raw, "", "file should be empty after clear");
  });

  it("allows appending after clear", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await log.append({ role: "user", content: "before" });
    await log.clear();
    await log.append({ role: "user", content: "after" });

    const raw = await readFile(log.filePath, "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1, "should have exactly one line after clear + append");
    assert.ok(raw.includes("after"), "should contain new content");
    assert.ok(!raw.includes("before"), "should not contain old content");
  });
});

describe("ConversationLog read (via readFile)", () => {
  it("reads back all appended messages as JSONL", async () => {
    const log = new ConversationLog(tmpDir, { dir: tmpDir });
    await log.append({ role: "user", content: "msg-a" });
    await log.append({ role: "assistant", content: "msg-b" });

    const raw = await readFile(log.filePath, "utf-8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));

    assert.equal(lines.length, 2, "should have two entries");
    assert.equal(lines[0].content, "msg-a", "first entry content should match");
    assert.equal(lines[1].content, "msg-b", "second entry content should match");
  });
});
