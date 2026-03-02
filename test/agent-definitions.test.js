// Tests for src/agent-definitions.js — Agent types, tool resolution, matching
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentTools, matchAgentForTask } from "../src/agent-definitions.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";

describe("resolveAgentTools", () => {
  it("excludes SubAgent/SubAgentTeam/ContextSearch for all agents", () => {
    const tools = resolveAgentTools({ tools: null, disallowedTools: [] }, "open");
    const names = tools.map((t) => t.function.name);
    assert.ok(!names.includes("SubAgent"), "SubAgent should be blocked");
    assert.ok(!names.includes("SubAgentTeam"), "SubAgentTeam should be blocked");
    assert.ok(!names.includes("ContextSearch"), "ContextSearch should be blocked");
  });

  it("includes core tools for general-purpose agent", () => {
    const tools = resolveAgentTools({ tools: null, disallowedTools: [] }, "open");
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes("Read"));
    assert.ok(names.includes("Write"));
    assert.ok(names.includes("Edit"));
    assert.ok(names.includes("Bash"));
    assert.ok(names.includes("Glob"));
    assert.ok(names.includes("Grep"));
  });

  it("restricts to allowlist when tools specified", () => {
    const def = { tools: ["Read", "Glob", "Grep"], disallowedTools: [] };
    const tools = resolveAgentTools(def, "open");
    const names = tools.map((t) => t.function.name);
    assert.deepEqual(names.sort(), ["Glob", "Grep", "Read"]);
  });

  it("applies denylist", () => {
    const def = { tools: null, disallowedTools: ["Bash", "Write"] };
    const tools = resolveAgentTools(def, "open");
    const names = tools.map((t) => t.function.name);
    assert.ok(!names.includes("Bash"));
    assert.ok(!names.includes("Write"));
    assert.ok(names.includes("Read"));
  });

  it("enforces readonly mode", () => {
    const tools = resolveAgentTools({ tools: null, disallowedTools: [] }, "readonly");
    const names = tools.map((t) => t.function.name);
    const readOnly = new Set(["Read", "Glob", "Grep", "ListDir", "Diff", "Fetch", "AstSearch", "Lsp"]);
    for (const name of names) {
      assert.ok(readOnly.has(name), `${name} should not be in readonly mode`);
    }
  });
});

describe("matchAgentForTask", () => {
  // Build a mock agents map
  function makeAgents() {
    const m = new Map();
    m.set("explore", { name: "explore", builtin: true, description: "search find files" });
    m.set("plan", { name: "plan", builtin: true, description: "design architecture strategy" });
    m.set("general-purpose", { name: "general-purpose", builtin: true, description: "general tasks" });
    return m;
  }

  it("matches explore for search tasks", () => {
    const agents = makeAgents();
    const match = matchAgentForTask(agents, "search for all files matching *.ts");
    assert.equal(match.name, "explore");
  });

  it("matches plan for architecture tasks", () => {
    const agents = makeAgents();
    const match = matchAgentForTask(agents, "design the database architecture");
    assert.equal(match.name, "plan");
  });

  it("defaults to general-purpose for unmatched tasks", () => {
    const agents = makeAgents();
    const match = matchAgentForTask(agents, "refactor the authentication module");
    assert.equal(match.name, "general-purpose");
  });
});
