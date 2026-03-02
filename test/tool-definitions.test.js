// Tests for src/tools/definitions.js — Tool schema validation
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";

describe("TOOL_DEFINITIONS", () => {
  it("is a non-empty array", () => {
    assert.ok(Array.isArray(TOOL_DEFINITIONS));
    assert.ok(TOOL_DEFINITIONS.length >= 16, `Expected 16+ tools, got ${TOOL_DEFINITIONS.length}`);
  });

  it("every tool has type=function", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(tool.type, "function", `Tool missing type=function`);
    }
  });

  it("every tool has name and description", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.function.name, "Tool missing name");
      assert.ok(tool.function.description, `${tool.function.name} missing description`);
    }
  });

  it("every tool has parameters with type=object", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.function.parameters, `${tool.function.name} missing parameters`);
      assert.equal(tool.function.parameters.type, "object",
        `${tool.function.name} parameters.type should be object`);
    }
  });

  it("contains all expected core tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    const expected = [
      "Read", "Write", "Edit", "Patch", "Bash",
      "Glob", "Grep", "ListDir", "Diff", "Fetch",
      "Lsp", "AstSearch",
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `Missing core tool: ${name}`);
    }
  });

  it("contains all expected labs tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    const expected = ["SubAgent", "SubAgentTeam", "AgentTeams", "ContextSearch"];
    for (const name of expected) {
      assert.ok(names.includes(name), `Missing labs tool: ${name}`);
    }
  });

  it("SubAgent tool has required parameters", () => {
    const subagent = TOOL_DEFINITIONS.find((t) => t.function.name === "SubAgent");
    assert.ok(subagent);
    const props = subagent.function.parameters.properties;
    assert.ok(props.task, "SubAgent missing task param");
    assert.ok(props.agent_type, "SubAgent missing agent_type param");
    assert.ok(props.resume, "SubAgent missing resume param");
    assert.ok(props.run_in_background, "SubAgent missing run_in_background param");
    assert.ok(props.isolation, "SubAgent missing isolation param");
  });

  it("AgentTeams tool has all actions documented", () => {
    const at = TOOL_DEFINITIONS.find((t) => t.function.name === "AgentTeams");
    assert.ok(at);
    const desc = at.function.description;
    const actions = ["create", "add_task", "spawn_teammate", "message", "broadcast", "run", "status", "shutdown"];
    for (const action of actions) {
      assert.ok(desc.includes(action), `AgentTeams description missing action: ${action}`);
    }
  });
});
