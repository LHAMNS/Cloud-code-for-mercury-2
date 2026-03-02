// Tests for src/permissions.js — Permission rules system
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionManager, PERMISSION_ALLOW, PERMISSION_ASK, PERMISSION_DENY } from "../src/permissions.js";

describe("PermissionManager: trust mode defaults", () => {
  it("open mode allows everything", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    assert.equal(pm.check("Bash", { command: "echo hi" }).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Write", { file_path: "/tmp/test" }).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Read", { file_path: "/tmp/test" }).decision, PERMISSION_ALLOW);
  });

  it("readonly mode allows reads, denies writes", () => {
    const pm = new PermissionManager({ trustMode: "readonly" });
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Glob", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Grep", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("ListDir", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_DENY);
    assert.equal(pm.check("Write", {}).decision, PERMISSION_DENY);
    assert.equal(pm.check("Edit", {}).decision, PERMISSION_DENY);
  });

  it("approval mode allows reads, asks for writes", () => {
    const pm = new PermissionManager({ trustMode: "approval" });
    assert.equal(pm.check("Read", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Glob", {}).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Bash", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("Write", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("Edit", {}).decision, PERMISSION_ASK);
    assert.equal(pm.check("SubAgent", {}).decision, PERMISSION_ASK);
  });
});

describe("PermissionManager: deny rules", () => {
  it("deny rules override everything", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.denyRules = ["Bash"];

    const result = pm.check("Bash", { command: "echo hi" });
    assert.equal(result.decision, PERMISSION_DENY);
    assert.equal(result.rule, "Bash");
  });

  it("deny with specifier blocks matching commands", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.denyRules = ["Bash(rm -rf *)"];

    // Should deny rm -rf
    assert.equal(pm.check("Bash", { command: "rm -rf /tmp/test" }).decision, PERMISSION_DENY);

    // Should allow other commands
    assert.equal(pm.check("Bash", { command: "echo hello" }).decision, PERMISSION_ALLOW);
  });

  it("deny blocks file path patterns", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.denyRules = ["Write(*.env)"];

    assert.equal(pm.check("Write", { file_path: "production.env" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Write", { file_path: "app.js" }).decision, PERMISSION_ALLOW);
  });
});

describe("PermissionManager: allow rules", () => {
  it("allow rules grant access in approval mode", () => {
    const pm = new PermissionManager({ trustMode: "approval" });
    pm.allowRules = ["Bash(git *)"];

    // git commands should be auto-allowed
    assert.equal(pm.check("Bash", { command: "git status" }).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Bash", { command: "git commit -m 'test'" }).decision, PERMISSION_ALLOW);

    // Non-git commands should still ask
    assert.equal(pm.check("Bash", { command: "npm test" }).decision, PERMISSION_ASK);
  });

  it("allow * matches all uses of a tool", () => {
    const pm = new PermissionManager({ trustMode: "approval" });
    pm.allowRules = ["Write"];

    assert.equal(pm.check("Write", { file_path: "/tmp/any.txt" }).decision, PERMISSION_ALLOW);
  });
});

describe("PermissionManager: rule priority", () => {
  it("deny overrides allow", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.allowRules = ["Bash"];
    pm.denyRules = ["Bash(curl *)"];

    // curl should be denied even though Bash is allowed
    assert.equal(pm.check("Bash", { command: "curl evil.com" }).decision, PERMISSION_DENY);

    // Other bash should be allowed
    assert.equal(pm.check("Bash", { command: "echo hello" }).decision, PERMISSION_ALLOW);
  });

  it("ask rules work between allow and default", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.askRules = ["Write(src/**)"];

    assert.equal(pm.check("Write", { file_path: "src/index.js" }).decision, PERMISSION_ASK);
    assert.equal(pm.check("Write", { file_path: "test/test.js" }).decision, PERMISSION_ALLOW);
  });
});

describe("PermissionManager: glob matching", () => {
  it("** matches any path depth", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.denyRules = ["Write(src/**/secret.*)"];

    assert.equal(pm.check("Write", { file_path: "src/secret.key" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Write", { file_path: "src/deep/nested/secret.txt" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Write", { file_path: "src/public.txt" }).decision, PERMISSION_ALLOW);
  });

  it("? matches single character", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.denyRules = ["Write(?.env)"];

    assert.equal(pm.check("Write", { file_path: "a.env" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Write", { file_path: "ab.env" }).decision, PERMISSION_ALLOW);
  });
});

describe("PermissionManager: config serialization", () => {
  it("toConfig exports rules", () => {
    const pm = new PermissionManager({ trustMode: "approval" });
    pm.allowRules = ["Read", "Glob"];
    pm.denyRules = ["Bash(curl *)"];

    const config = pm.toConfig();
    assert.deepEqual(config.allow, ["Read", "Glob"]);
    assert.deepEqual(config.deny, ["Bash(curl *)"]);
    assert.deepEqual(config.ask, []);
  });

  it("fromConfig imports rules", () => {
    const pm = new PermissionManager({ trustMode: "approval" });
    pm.fromConfig({
      allow: ["Bash(git *)"],
      deny: ["Bash(rm -rf *)"],
      ask: ["Write"],
    });

    assert.equal(pm.check("Bash", { command: "git status" }).decision, PERMISSION_ALLOW);
    assert.equal(pm.check("Bash", { command: "rm -rf /tmp" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("Write", { file_path: "/tmp/test" }).decision, PERMISSION_ASK);
  });
});

describe("PermissionManager: case insensitivity", () => {
  it("tool name matching is case-insensitive", () => {
    const pm = new PermissionManager({ trustMode: "open" });
    pm.denyRules = ["bash"];

    assert.equal(pm.check("Bash", { command: "echo" }).decision, PERMISSION_DENY);
    assert.equal(pm.check("BASH", { command: "echo" }).decision, PERMISSION_DENY);
  });
});
