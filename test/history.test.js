// Tests for src/history.js — SessionHistory
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionHistory } from "../src/history.js";

/**
 * Helper: create a SessionHistory that writes to a temporary directory.
 */
async function makeTempHistory() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc2-hist-"));
  const history = new SessionHistory();
  history.dir = tmpDir;
  return { history, tmpDir };
}

/**
 * Helper: build a minimal valid session object.
 */
function makeSession(id = "sess-1", messageCount = 2) {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
    });
  }
  return {
    id,
    cwd: "/tmp/project",
    messages,
    config: { model: "mercury-2" },
    summary: `Test session ${id}`,
  };
}

describe("SessionHistory", () => {
  let history;
  let tmpDir;

  beforeEach(async () => {
    ({ history, tmpDir } = await makeTempHistory());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("save() creates a JSON file in the sessions directory", async () => {
    const session = makeSession("save-test");
    const filepath = await history.save(session);

    assert.ok(filepath.endsWith(".json"), "saved file should end with .json");
    assert.ok(filepath.includes("save-test"), "filename should contain the session id");

    const files = await readdir(tmpDir);
    assert.equal(files.length, 1, "exactly one file should be created");
  });

  it("save() persists correct session data", async () => {
    const session = makeSession("data-test", 3);
    await history.save(session);

    const files = await readdir(tmpDir);
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(tmpDir, files[0]), "utf-8")
    );
    const data = JSON.parse(raw);

    assert.equal(data.id, "data-test");
    assert.equal(data.cwd, "/tmp/project");
    assert.equal(data.messageCount, 3);
    assert.equal(data.messages.length, 3);
    assert.equal(data.summary, "Test session data-test");
    assert.ok(data.timestamp > 0, "timestamp should be a positive number");
    assert.ok(data.date, "date should be set");
  });

  it("list() returns saved sessions sorted by most recent first", async () => {
    await history.save(makeSession("first"));
    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 50));
    await history.save(makeSession("second"));

    const sessions = await history.list();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, "second", "most recent session should be first");
    assert.equal(sessions[1].id, "first");
  });

  it("list() returns empty array when no sessions exist", async () => {
    const sessions = await history.list();
    assert.ok(Array.isArray(sessions));
    assert.equal(sessions.length, 0);
  });

  it("load() returns full session data by 1-based index", async () => {
    await history.save(makeSession("load-idx", 4));

    const loaded = await history.load("1");
    assert.ok(loaded, "load should return data");
    assert.equal(loaded.id, "load-idx");
    assert.equal(loaded.messages.length, 4);
  });

  it("load() returns full session data by session id", async () => {
    await history.save(makeSession("by-id-test"));

    const loaded = await history.load("by-id-test");
    assert.ok(loaded, "load by id should return data");
    assert.equal(loaded.id, "by-id-test");
  });

  it("load() returns null for nonexistent identifier", async () => {
    await history.save(makeSession("exists"));

    const result = await history.load("does-not-exist");
    assert.equal(result, null);
  });

  it("_autoSummary() uses first user message truncated to 80 chars", () => {
    const short = history._autoSummary([
      { role: "user", content: "Fix the bug" },
    ]);
    assert.equal(short, "Fix the bug");

    const long = history._autoSummary([
      { role: "user", content: "A".repeat(100) },
    ]);
    assert.equal(long.length, 83); // 80 chars + "..."
    assert.ok(long.endsWith("..."));
  });

  it("_pruneOld() removes sessions beyond MAX_SESSIONS", async () => {
    // Write 5 files manually and set a low prune threshold by calling
    // _pruneOld after populating the directory. We cannot change the module
    // constant, so we create 55 sessions (more than the 50 limit).
    // For speed, write files directly rather than calling save() 55 times.
    const promises = [];
    for (let i = 0; i < 55; i++) {
      const ts = new Date(Date.now() - (55 - i) * 1000)
        .toISOString()
        .replace(/[:.]/g, "-");
      const filename = `${ts}_prune-${i}.json`;
      const data = JSON.stringify({
        id: `prune-${i}`,
        timestamp: Date.now() - (55 - i) * 1000,
        date: new Date().toISOString(),
        messageCount: 1,
        summary: `session ${i}`,
        cwd: "/tmp",
      });
      promises.push(writeFile(path.join(tmpDir, filename), data, "utf-8"));
    }
    await Promise.all(promises);

    // Verify 55 files exist before pruning
    let files = await readdir(tmpDir);
    assert.equal(files.length, 55);

    await history._pruneOld();

    files = await readdir(tmpDir);
    assert.ok(files.length <= 50, `should have at most 50 files, got ${files.length}`);
  });

  it("list() ignores non-JSON files", async () => {
    await history.save(makeSession("valid"));
    // Create a non-JSON file
    await writeFile(path.join(tmpDir, "notes.txt"), "not json", "utf-8");

    const sessions = await history.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "valid");
  });
});
