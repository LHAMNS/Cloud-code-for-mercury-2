// Tests for src/system-prompt.js — System prompt generation
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, setProjectConfig } from "../src/system-prompt.js";
import { labs } from "../src/labs.js";

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    labs.enabled = false;
    labs._overrides = new Map();
    setProjectConfig(null, null);
  });

  it("returns a non-empty string", () => {
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(prompt.length > 100);
  });

  it("includes Mercury Code identity", () => {
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(prompt.includes("Mercury Code"));
  });

  it("includes workspace path", () => {
    const prompt = buildSystemPrompt("/tmp/my-project", "approval", null);
    assert.ok(prompt.includes("/tmp/my-project"));
  });

  it("includes core tools always", () => {
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(prompt.includes("**Read**"));
    assert.ok(prompt.includes("**Write**"));
    assert.ok(prompt.includes("**Edit**"));
    assert.ok(prompt.includes("**Bash**"));
    assert.ok(prompt.includes("**Glob**"));
    assert.ok(prompt.includes("**Grep**"));
    assert.ok(prompt.includes("**Lsp**"));
    assert.ok(prompt.includes("**AstSearch**"));
  });

  it("does NOT include labs tools when labs disabled", () => {
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(!prompt.includes("**SubAgent**"));
    assert.ok(!prompt.includes("**SubAgentTeam**"));
    assert.ok(!prompt.includes("**AgentTeams**"));
    assert.ok(!prompt.includes("**ContextSearch**"));
  });

  it("includes SubAgent/SubAgentTeam when labs enabled", () => {
    labs.enableLabs();
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(prompt.includes("**SubAgent**"));
    assert.ok(prompt.includes("**SubAgentTeam**"));
  });

  it("does NOT include AgentTeams when default (off)", () => {
    labs.enableLabs();
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(!prompt.includes("**AgentTeams**"));
  });

  it("includes AgentTeams when explicitly enabled", () => {
    labs.enableLabs();
    labs.toggle("agent-teams", true);
    const prompt = buildSystemPrompt("/tmp/test", "approval", null);
    assert.ok(prompt.includes("**AgentTeams**"));
  });

  describe("trust modes", () => {
    it("shows readonly permission mode", () => {
      const prompt = buildSystemPrompt("/tmp/test", "readonly", null);
      assert.ok(prompt.includes('mode="readonly"'));
      assert.ok(prompt.includes("only read files"));
    });

    it("shows approval permission mode", () => {
      const prompt = buildSystemPrompt("/tmp/test", "approval", null);
      assert.ok(prompt.includes('mode="approval"'));
      assert.ok(prompt.includes("require explicit user approval"));
    });

    it("shows open permission mode", () => {
      const prompt = buildSystemPrompt("/tmp/test", "open", null);
      assert.ok(prompt.includes('mode="open"'));
      assert.ok(prompt.includes("All operations are allowed"));
    });

    it("shows aiSafetyDecide permission mode", () => {
      const prompt = buildSystemPrompt("/tmp/test", "aiSafetyDecide", null);
      assert.ok(prompt.includes('mode="aiSafetyDecide"'));
      assert.ok(prompt.includes("AI Safety Decide"));
    });
  });

  describe("project config", () => {
    it("includes project config when set for matching cwd", () => {
      setProjectConfig("/tmp/test", "## Custom Instructions\nDo this.");
      const prompt = buildSystemPrompt("/tmp/test", "approval", null);
      assert.ok(prompt.includes("Custom Instructions"));
    });

    it("excludes project config for non-matching cwd", () => {
      setProjectConfig("/tmp/other", "## Secret");
      const prompt = buildSystemPrompt("/tmp/test", "approval", null);
      assert.ok(!prompt.includes("Secret"));
    });
  });
});
