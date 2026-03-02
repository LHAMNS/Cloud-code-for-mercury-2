import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentTools, matchAgentForTask, discoverAgents, formatAgentList } from "../src/agent-definitions.js";

describe("matchAgentForTask", () => {
  it("loads builtin agents", async () => {
    const a = await discoverAgents(process.cwd());
    assert.ok(a.has("explore") && a.has("plan") && a.has("general-purpose"));
  });
  it("matches explore for search", async () => { assert.equal(matchAgentForTask(await discoverAgents(process.cwd()), "search codebase").name, "explore"); });
  it("matches explore for find", async () => { assert.equal(matchAgentForTask(await discoverAgents(process.cwd()), "find files").name, "explore"); });
  it("matches explore for grep", async () => { assert.equal(matchAgentForTask(await discoverAgents(process.cwd()), "grep TODOs").name, "explore"); });
  it("matches plan for architecture", async () => { assert.equal(matchAgentForTask(await discoverAgents(process.cwd()), "plan the architecture").name, "plan"); });
  it("matches plan for design", async () => { assert.equal(matchAgentForTask(await discoverAgents(process.cwd()), "design a strategy").name, "plan"); });
  it("falls back to general-purpose", async () => { assert.equal(matchAgentForTask(await discoverAgents(process.cwd()), "implement login").name, "general-purpose"); });
});

describe("resolveAgentTools", () => {
  it("filters out blocked tools", () => {
    const names = resolveAgentTools({ tools: null, disallowedTools: [] }, "default").map(t => t.function.name);
    assert.ok(!names.includes("SubAgent") && !names.includes("SubAgentTeam") && !names.includes("ContextSearch"));
  });
  it("applies allowlist", () => {
    const names = resolveAgentTools({ tools: ["Read", "Glob"], disallowedTools: [] }, "default").map(t => t.function.name);
    assert.ok(names.includes("Read") && names.includes("Glob") && !names.includes("Write"));
  });
  it("applies denylist", () => {
    const names = resolveAgentTools({ tools: null, disallowedTools: ["Bash", "Write"] }, "default").map(t => t.function.name);
    assert.ok(!names.includes("Bash") && !names.includes("Write") && names.includes("Read"));
  });
  it("enforces readonly", () => {
    const names = resolveAgentTools({ tools: null, disallowedTools: [] }, "readonly").map(t => t.function.name);
    assert.ok(names.includes("Read") && !names.includes("Write") && !names.includes("Bash"));
  });
  it("returns all tools minus blocked for null", () => { assert.ok(resolveAgentTools({ tools: null, disallowedTools: [] }, "default").length > 5); });
});

describe("discoverAgents", () => {
  it("always includes builtins", async () => {
    const a = await discoverAgents("/nonexistent");
    assert.ok(a.has("explore") && a.has("plan") && a.has("general-purpose"));
    assert.equal(a.size, 3);
  });
  it("explore has read-only tools", async () => { const e = (await discoverAgents("/x")).get("explore"); assert.ok(e.tools.includes("Read") && !e.tools.includes("Write")); });
  it("general-purpose has null tools", async () => { assert.equal((await discoverAgents("/x")).get("general-purpose").tools, null); });
  it("builtins marked builtin", async () => { for (const [, d] of await discoverAgents("/x")) assert.equal(d.builtin, true); });
});

describe("formatAgentList", () => {
  it("formats list", async () => {
    const o = formatAgentList(await discoverAgents("/x"));
    assert.ok(o.includes("Available agents") && o.includes("explore"));
  });
});
