/**
 * Tests for lsp.js — Language Server Protocol client.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LspClient } from "../src/lsp.js";

describe("LSP: Client construction", () => {
  it("creates LspClient with workspace path", () => {
    const client = new LspClient("/tmp/test-project");
    assert.ok(client, "Should create LspClient");
    assert.equal(client.workspace, "/tmp/test-project");
  });

  it("starts in uninitialized state", () => {
    const client = new LspClient("/tmp/test-project");
    assert.equal(client._initialized, false, "Should start uninitialized");
    assert.equal(client._process, null, "Should have no process");
  });
});

describe("LSP: Status reporting", () => {
  it("reports status when not started", () => {
    const client = new LspClient("/tmp/test-project");
    const status = client.getStatus();
    assert.equal(status.language, null, "No language detected before start");
    assert.equal(status.running, false, "Should not be running");
  });
});

describe("LSP: Uninitialized operations", () => {
  it("gotoDefinition returns empty array when not initialized", async () => {
    const client = new LspClient("/tmp/test-project");
    const result = await client.gotoDefinition("/tmp/test.js", 0, 0);
    assert.ok(Array.isArray(result), "Should return array");
    assert.equal(result.length, 0, "Should be empty when not initialized");
  });

  it("findReferences returns empty array when not initialized", async () => {
    const client = new LspClient("/tmp/test-project");
    const result = await client.findReferences("/tmp/test.js", 0, 0);
    assert.ok(Array.isArray(result), "Should return array");
    assert.equal(result.length, 0, "Should be empty when not initialized");
  });

  it("stop is safe when not started", () => {
    const client = new LspClient("/tmp/test-project");
    client.stop(); // Should not throw
    assert.equal(client._initialized, false);
  });
});
