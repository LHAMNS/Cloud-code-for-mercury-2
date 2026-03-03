/**
 * Tests for history.js — SessionHistory.
 * Note: SessionHistory uses ~/.mercury/sessions/ by default.
 * We use the real SessionHistory but test with unique session IDs.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SessionHistory } from "../src/history.js";

describe("SessionHistory", () => {
  const uniqueId = () => "test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  it("save creates a session file", async () => {
    const hist = new SessionHistory();
    const id = uniqueId();
    const filepath = await hist.save({
      id,
      cwd: "/tmp",
      messages: [{ role: "user", content: "Hello" }],
      config: {},
      summary: "Test session",
    });
    assert.ok(filepath, "Should return filepath");
    assert.ok(filepath.endsWith(".json"), "Should be a JSON file");
  });

  it("list returns sessions including saved one", async () => {
    const hist = new SessionHistory();
    const id = uniqueId();
    await hist.save({
      id,
      cwd: "/tmp",
      messages: [{ role: "user", content: "Test" }],
      config: {},
    });
    const entries = await hist.list();
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length > 0);
    const found = entries.find(e => e.id === id);
    assert.ok(found, "Should find saved session");
  });

  it("load returns saved session by id", async () => {
    const hist = new SessionHistory();
    const id = uniqueId();
    await hist.save({
      id,
      cwd: "/tmp",
      messages: [{ role: "user", content: "Loadable" }],
      config: {},
    });
    const loaded = await hist.load(id);
    assert.ok(loaded, "Should load session");
    assert.equal(loaded.id, id);
    assert.ok(loaded.messages.length > 0);
  });

  it("load returns null for non-existent session", async () => {
    const hist = new SessionHistory();
    const loaded = await hist.load("nonexistent-id-" + Date.now());
    assert.equal(loaded, null);
  });

  it("auto-summary generates from first user message", async () => {
    const hist = new SessionHistory();
    const id = uniqueId();
    await hist.save({
      id,
      cwd: "/tmp",
      messages: [{ role: "user", content: "Help me write a sorting algorithm" }],
      config: {},
    });
    const entries = await hist.list();
    const found = entries.find(e => e.id === id);
    assert.ok(found);
    assert.ok(found.summary.includes("sorting") || found.summary.includes("Help"),
      `Auto-summary should include user message content: ${found.summary}`);
  });
});
