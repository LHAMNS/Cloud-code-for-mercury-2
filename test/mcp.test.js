// Tests for src/mcp.js — MCP argument validation, tool name parsing, isMcpTool
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpManager, MCP_PREFIX } from "../src/mcp.js";

describe("McpManager._validateMcpArgs", () => {
  let mgr;

  it("setup", () => {
    mgr = new McpManager();
  });

  it("allows normal arguments", () => {
    assert.doesNotThrow(() => mgr._validateMcpArgs({ path: "/workspace/file.js", content: "hello" }));
  });

  it("blocks null bytes in arguments", () => {
    assert.throws(
      () => mgr._validateMcpArgs({ file: "test\0.js" }),
      /null bytes/
    );
  });

  it("blocks null bytes in any argument", () => {
    assert.throws(
      () => mgr._validateMcpArgs({ name: "ok", data: "has\0null" }),
      /null bytes/
    );
  });

  it("blocks path traversal in path-like arguments", () => {
    assert.throws(
      () => mgr._validateMcpArgs({ file_path: "../../etc/passwd" }),
      /path traversal/
    );
  });

  it("blocks path traversal in 'dir' arguments", () => {
    assert.throws(
      () => mgr._validateMcpArgs({ directory: "../../../secret" }),
      /path traversal/
    );
  });

  it("allows ../ in non-path arguments", () => {
    assert.doesNotThrow(() => mgr._validateMcpArgs({ query: "find ../stuff" }));
  });

  it("skips non-string values", () => {
    assert.doesNotThrow(() => mgr._validateMcpArgs({ count: 42, active: true }));
  });

  it("handles null/undefined args gracefully", () => {
    assert.doesNotThrow(() => mgr._validateMcpArgs(null));
    assert.doesNotThrow(() => mgr._validateMcpArgs(undefined));
    assert.doesNotThrow(() => mgr._validateMcpArgs("not-an-object"));
  });
});

describe("McpManager.isMcpTool", () => {
  const mgr = new McpManager();

  it("returns true for MCP-prefixed tool names", () => {
    assert.ok(mgr.isMcpTool("mcp__filesystem__readFile"));
    assert.ok(mgr.isMcpTool("mcp__github__createIssue"));
  });

  it("returns false for non-MCP tool names", () => {
    assert.ok(!mgr.isMcpTool("Bash"));
    assert.ok(!mgr.isMcpTool("Read"));
    assert.ok(!mgr.isMcpTool("Write"));
  });
});

describe("McpManager.executeTool name parsing", () => {
  const mgr = new McpManager();

  it("rejects names not starting with mcp", async () => {
    await assert.rejects(
      () => mgr.executeTool("invalid__server__tool", {}),
      /Invalid MCP tool name/
    );
  });

  it("rejects names with less than 3 parts", async () => {
    await assert.rejects(
      () => mgr.executeTool("mcp__serveronly", {}),
      /Invalid MCP tool name/
    );
  });

  it("rejects names with empty tool portion", async () => {
    await assert.rejects(
      () => mgr.executeTool("mcp__server__", {}),
      /empty tool/
    );
  });

  it("rejects when server is not found", async () => {
    await assert.rejects(
      () => mgr.executeTool("mcp__nonexistent__tool", {}),
      /not found/
    );
  });
});

describe("McpManager initial state", () => {
  it("starts with zero servers and not loaded", () => {
    const mgr = new McpManager();
    assert.equal(mgr.serverCount, 0);
    assert.equal(mgr.isLoaded, false);
  });

  it("getToolDefinitions returns empty when no servers", () => {
    const mgr = new McpManager();
    assert.deepEqual(mgr.getToolDefinitions(), []);
  });

  it("getStatus returns empty when no servers", () => {
    const mgr = new McpManager();
    assert.deepEqual(mgr.getStatus(), []);
  });
});

describe("MCP_PREFIX constant", () => {
  it("equals mcp__", () => {
    assert.equal(MCP_PREFIX, "mcp__");
  });
});
