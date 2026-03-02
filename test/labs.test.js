// Tests for src/labs.js — Labs experimental feature system
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { labs, LAB_FEATURES } from "../src/labs.js";

describe("Labs", () => {
  beforeEach(() => {
    // Reset state before each test
    labs.enabled = false;
    labs._overrides = new Map();
  });

  describe("master switch", () => {
    it("should be disabled by default", () => {
      assert.equal(labs.enabled, false);
    });

    it("enableLabs() turns on the master switch", () => {
      labs.enableLabs();
      assert.equal(labs.enabled, true);
    });

    it("disableLabs() turns off the master switch", () => {
      labs.enableLabs();
      labs.disableLabs();
      assert.equal(labs.enabled, false);
    });
  });

  describe("isActive", () => {
    it("returns false when labs is disabled", () => {
      assert.equal(labs.isActive("subagent"), false);
    });

    it("returns true for feature with default=true when labs enabled", () => {
      labs.enableLabs();
      assert.equal(labs.isActive("subagent"), true);
    });

    it("returns false for feature with default=false when labs enabled", () => {
      labs.enableLabs();
      assert.equal(labs.isActive("agent-resume"), false);
    });

    it("respects override", () => {
      labs.enableLabs();
      labs.toggle("agent-resume", true);
      assert.equal(labs.isActive("agent-resume"), true);
    });

    it("returns false for unknown feature", () => {
      labs.enableLabs();
      assert.equal(labs.isActive("nonexistent-feature"), false);
    });

    it("checks dependency chain", () => {
      labs.enableLabs();
      // subagent-team requires subagent
      assert.equal(labs.isActive("subagent-team"), true); // both default true
      labs.toggle("subagent", false);
      assert.equal(labs.isActive("subagent-team"), false); // dep not met
    });
  });

  describe("isToolAllowed", () => {
    it("allows non-gated tools always", () => {
      assert.equal(labs.isToolAllowed("Read"), true);
      assert.equal(labs.isToolAllowed("Write"), true);
      assert.equal(labs.isToolAllowed("Bash"), true);
    });

    it("blocks gated tools when labs disabled", () => {
      assert.equal(labs.isToolAllowed("SubAgent"), false);
      assert.equal(labs.isToolAllowed("SubAgentTeam"), false);
      assert.equal(labs.isToolAllowed("AgentTeams"), false);
    });

    it("allows gated tools when labs enabled and feature active", () => {
      labs.enableLabs();
      assert.equal(labs.isToolAllowed("SubAgent"), true);
      assert.equal(labs.isToolAllowed("SubAgentTeam"), true);
    });

    it("blocks AgentTeams (default=false) even when labs enabled", () => {
      labs.enableLabs();
      assert.equal(labs.isToolAllowed("AgentTeams"), false);
    });

    it("allows AgentTeams when explicitly enabled", () => {
      labs.enableLabs();
      labs.toggle("agent-teams", true);
      assert.equal(labs.isToolAllowed("AgentTeams"), true);
    });
  });

  describe("toggle", () => {
    it("toggles a feature on", () => {
      labs.enableLabs();
      const result = labs.toggle("agent-resume", true);
      assert.equal(result.ok, true);
      assert.equal(labs.isActive("agent-resume"), true);
    });

    it("toggles a feature off", () => {
      labs.enableLabs();
      const result = labs.toggle("subagent", false);
      assert.equal(result.ok, true);
      assert.equal(labs.isActive("subagent"), false);
    });

    it("returns error for unknown feature", () => {
      const result = labs.toggle("fake-feature");
      assert.equal(result.ok, false);
    });

    it("cascades disable to dependents", () => {
      labs.enableLabs();
      labs.toggle("agent-teams", true);
      assert.equal(labs.isActive("agent-teams"), true);

      // Disable parent (subagent) — should cascade to agent-teams
      labs.toggle("subagent", false);
      assert.equal(labs.isActive("agent-teams"), false);
      assert.equal(labs.isActive("subagent-team"), false);
    });
  });

  describe("getBlockedTools", () => {
    it("returns all gated tools when labs disabled", () => {
      const blocked = labs.getBlockedTools();
      assert.ok(blocked.includes("SubAgent"));
      assert.ok(blocked.includes("SubAgentTeam"));
      assert.ok(blocked.includes("AgentTeams"));
      assert.ok(blocked.includes("ContextSearch"));
    });

    it("returns fewer blocked tools when labs enabled", () => {
      labs.enableLabs();
      const blocked = labs.getBlockedTools();
      // SubAgent and SubAgentTeam should be unblocked (default true)
      assert.ok(!blocked.includes("SubAgent"));
      assert.ok(!blocked.includes("SubAgentTeam"));
      // AgentTeams and ContextSearch still blocked (default false)
      assert.ok(blocked.includes("AgentTeams"));
      assert.ok(blocked.includes("ContextSearch"));
    });
  });

  describe("snapshot", () => {
    it("returns all features with states", () => {
      const snap = labs.snapshot();
      assert.ok(Array.isArray(snap));
      assert.ok(snap.length > 0);

      const subagent = snap.find((f) => f.id === "subagent");
      assert.ok(subagent);
      assert.equal(subagent.active, false); // labs disabled
      assert.equal(subagent.blocked, "labs off");
    });

    it("shows active features when labs enabled", () => {
      labs.enableLabs();
      const snap = labs.snapshot();
      const subagent = snap.find((f) => f.id === "subagent");
      assert.equal(subagent.active, true);
      assert.equal(subagent.blocked, null);
    });
  });

  describe("feature registry", () => {
    it("has required features", () => {
      const ids = LAB_FEATURES.map((f) => f.id);
      assert.ok(ids.includes("subagent"));
      assert.ok(ids.includes("subagent-team"));
      assert.ok(ids.includes("agent-resume"));
      assert.ok(ids.includes("agent-background"));
      assert.ok(ids.includes("agent-worktree"));
      assert.ok(ids.includes("agent-teams"));
      assert.ok(ids.includes("context-search"));
      assert.ok(ids.includes("project-config"));
      assert.ok(ids.includes("sandbox"));
    });

    it("every feature has required fields", () => {
      for (const f of LAB_FEATURES) {
        assert.ok(f.id, `feature missing id`);
        assert.ok(f.name, `${f.id} missing name`);
        assert.ok(f.category, `${f.id} missing category`);
        assert.ok(f.desc, `${f.id} missing desc`);
        assert.ok(typeof f.default === "boolean", `${f.id} missing default`);
      }
    });
  });
});
