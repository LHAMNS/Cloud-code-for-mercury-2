// Tests for MCP, Skills, Plan mode, and enhanced trust modes (v1.3.0)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

// ── MCP Manager Tests ──────────────────────────────────────────────────────

describe("McpManager", () => {
  it("should import McpManager", async () => {
    const { McpManager } = await import("../src/mcp.js");
    assert.ok(McpManager);
  });

  it("should create an instance", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    assert.strictEqual(mgr.serverCount, 0);
    assert.strictEqual(mgr.isLoaded, false);
  });

  it("should handle missing config gracefully", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    const result = await mgr.loadConfig("/nonexistent/path");
    assert.strictEqual(result.loaded, false);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(mgr.isLoaded, true);
  });

  it("should return empty tool definitions with no servers", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    await mgr.loadConfig("/nonexistent/path");
    const defs = mgr.getToolDefinitions();
    assert.deepStrictEqual(defs, []);
  });

  it("should return empty status with no servers", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    const status = mgr.getStatus();
    assert.deepStrictEqual(status, []);
  });

  it("should correctly identify MCP tool names", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    assert.strictEqual(mgr.isMcpTool("mcp__filesystem__readFile"), true);
    assert.strictEqual(mgr.isMcpTool("mcp__github__createIssue"), true);
    assert.strictEqual(mgr.isMcpTool("Read"), false);
    assert.strictEqual(mgr.isMcpTool("Bash"), false);
    assert.strictEqual(mgr.isMcpTool("mcp"), false);
  });

  it("should reject invalid MCP tool names in executeTool", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    await assert.rejects(
      () => mgr.executeTool("invalidName", {}),
      /Invalid MCP tool name/
    );
  });

  it("should reject non-existent server in executeTool", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    await assert.rejects(
      () => mgr.executeTool("mcp__nonexistent__tool", {}),
      /MCP server not found/
    );
  });

  it("should shutdown gracefully with no servers", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const mgr = new McpManager();
    await mgr.shutdown(); // Should not throw
    assert.strictEqual(mgr.serverCount, 0);
  });

  it("does not start project HTTP MCP servers with embedded credentials", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const workspace = await mkdtemp(path.join(os.tmpdir(), "mercury-mcp-http-creds-"));
    try {
      await mkdir(path.join(workspace, ".mercury"), { recursive: true });
      await writeFile(
        path.join(workspace, ".mercury", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            dangerous: { url: "https://user:pass@example.com/mcp" },
          },
        }),
        "utf-8"
      );

      const mgr = new McpManager();
      await mgr.loadConfig(workspace, undefined, { allowProjectConfig: true });
      const status = mgr.getStatus();
      assert.equal(status.length, 1);
      assert.equal(status[0].ready, false);
      await mgr.shutdown();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not start HTTP MCP servers with unsupported protocols", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const workspace = await mkdtemp(path.join(os.tmpdir(), "mercury-mcp-http-proto-"));
    try {
      await mkdir(path.join(workspace, ".mercury"), { recursive: true });
      await writeFile(
        path.join(workspace, ".mercury", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            dangerous: { url: "ftp://example.com/mcp" },
          },
        }),
        "utf-8"
      );

      const mgr = new McpManager();
      await mgr.loadConfig(workspace, undefined, { allowProjectConfig: true });
      const status = mgr.getStatus();
      assert.equal(status.length, 1);
      assert.equal(status[0].ready, false);
      await mgr.shutdown();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// ── Skills System Tests ────────────────────────────────────────────────────

describe("SkillManager", () => {
  it("should import SkillManager and Skill", async () => {
    const { SkillManager, Skill } = await import("../src/skills.js");
    assert.ok(SkillManager);
    assert.ok(Skill);
  });

  it("should create an empty instance", async () => {
    const { SkillManager } = await import("../src/skills.js");
    const mgr = new SkillManager();
    assert.strictEqual(mgr.count, 0);
    assert.strictEqual(mgr.isLoaded, false);
  });

  it("should handle missing skills directory gracefully", async () => {
    const { SkillManager } = await import("../src/skills.js");
    const mgr = new SkillManager();
    await mgr.discover("/nonexistent/path");
    assert.strictEqual(mgr.count, 0);
    assert.strictEqual(mgr.isLoaded, true);
  });

  it("should return empty completions with no skills", async () => {
    const { SkillManager } = await import("../src/skills.js");
    const mgr = new SkillManager();
    await mgr.discover("/nonexistent/path");
    assert.deepStrictEqual(mgr.getCompletions(), []);
  });

  it("should return null tool definition with no skills", async () => {
    const { SkillManager } = await import("../src/skills.js");
    const mgr = new SkillManager();
    await mgr.discover("/nonexistent/path");
    assert.strictEqual(mgr.getToolDefinition(), null);
  });

  it("should return null for non-existent skill", async () => {
    const { SkillManager } = await import("../src/skills.js");
    const mgr = new SkillManager();
    await mgr.discover("/nonexistent/path");
    assert.strictEqual(mgr.get("nonexistent"), null);
    assert.strictEqual(mgr.has("nonexistent"), false);
  });

  it("should format empty list correctly", async () => {
    const { SkillManager } = await import("../src/skills.js");
    const mgr = new SkillManager();
    await mgr.discover("/nonexistent/path");
    const list = mgr.formatList();
    assert.ok(list.includes("No skills found"));
  });
});

describe("Skill", () => {
  it("should create a skill with all options", async () => {
    const { Skill } = await import("../src/skills.js");
    const skill = new Skill({
      name: "test-skill",
      description: "A test skill",
      prompt: "Do something with {{argument}}",
      argumentHint: "thing to do",
      userInvocable: true,
      allowedTools: ["Read", "Bash"],
      model: "mercury-coder-small",
      source: "/path/to/skill.md",
    });
    assert.strictEqual(skill.name, "test-skill");
    assert.strictEqual(skill.description, "A test skill");
    assert.deepStrictEqual(skill.allowedTools, ["Read", "Bash"]);
    assert.strictEqual(skill.userInvocable, true);
  });

  it("should render prompt with argument substitution", async () => {
    const { Skill } = await import("../src/skills.js");
    const skill = new Skill({
      name: "greet",
      prompt: "Hello {{argument}}! How are you $ARGUMENTS?",
      source: "test",
    });
    const rendered = skill.render("world");
    assert.strictEqual(rendered, "Hello world! How are you world?");
  });

  it("should render prompt with empty argument", async () => {
    const { Skill } = await import("../src/skills.js");
    const skill = new Skill({
      name: "greet",
      prompt: "Hello {{argument}}!",
      source: "test",
    });
    const rendered = skill.render();
    assert.strictEqual(rendered, "Hello !");
  });

  it("should default userInvocable to true", async () => {
    const { Skill } = await import("../src/skills.js");
    const skill = new Skill({ name: "x", source: "test" });
    assert.strictEqual(skill.userInvocable, true);
  });

  it("should respect disableModelInvocation", async () => {
    const { Skill } = await import("../src/skills.js");
    const skill = new Skill({
      name: "internal",
      disableModelInvocation: true,
      source: "test",
    });
    assert.strictEqual(skill.disableModelInvocation, true);
  });
});

// ── Enhanced Trust Modes Tests ─────────────────────────────────────────────

describe("Enhanced Trust Modes", () => {
  // Import the permission modes from permissions.js
  it("should export all 6 permission modes", async () => {
    const {
      MODE_READONLY, MODE_APPROVAL, MODE_ACCEPT_EDITS,
      MODE_AI_SAFETY_DECIDE, MODE_OPEN, MODE_DONT_ASK, VALID_MODES,
    } = await import("../src/permissions.js");

    assert.strictEqual(MODE_READONLY, "readonly");
    assert.strictEqual(MODE_APPROVAL, "approval");
    assert.strictEqual(MODE_ACCEPT_EDITS, "acceptEdits");
    assert.strictEqual(MODE_AI_SAFETY_DECIDE, "aiSafetyDecide");
    assert.strictEqual(MODE_OPEN, "open");
    assert.strictEqual(MODE_DONT_ASK, "dontAsk");
    assert.strictEqual(VALID_MODES.length, 6);
  });

  it("should have correct TRUST_LEVELS ordering", async () => {
    const { TRUST_LEVELS } = await import("../src/permissions.js");
    assert.ok(TRUST_LEVELS.open < TRUST_LEVELS.aiSafetyDecide);
    assert.ok(TRUST_LEVELS.aiSafetyDecide < TRUST_LEVELS.acceptEdits);
    assert.ok(TRUST_LEVELS.acceptEdits < TRUST_LEVELS.approval);
    assert.ok(TRUST_LEVELS.approval < TRUST_LEVELS.dontAsk);
    assert.ok(TRUST_LEVELS.dontAsk < TRUST_LEVELS.readonly);
  });
});

// ── Display Module Tests ───────────────────────────────────────────────────

describe("Display Module", () => {
  it("should export all required display functions", async () => {
    const display = await import("../src/ui/display.js");
    assert.ok(typeof display.printWelcome === "function");
    assert.ok(typeof display.printHelp === "function");
    assert.ok(typeof display.printToolCall === "function");
    assert.ok(typeof display.printToolResult === "function");
    assert.ok(typeof display.printError === "function");
    assert.ok(typeof display.printInfo === "function");
    assert.ok(typeof display.printSuccess === "function");
    assert.ok(typeof display.printWarning === "function");
    assert.ok(typeof display.printPlanModeBanner === "function");
    assert.ok(typeof display.printMcpStatus === "function");
    assert.ok(typeof display.renderContextGauge === "function");
    assert.ok(typeof display.spinner === "object");
  });

  it("printMcpStatus should handle empty server list", async () => {
    const { printMcpStatus } = await import("../src/ui/display.js");
    // Should not throw
    printMcpStatus([]);
    printMcpStatus(null);
  });

  it("renderContextGauge should return a string", async () => {
    const { renderContextGauge } = await import("../src/ui/display.js");
    const gauge = renderContextGauge(50000, 128000);
    assert.ok(typeof gauge === "string");
    assert.ok(gauge.length > 0);
  });
});

// ── Tool Definitions Tests ─────────────────────────────────────────────────

describe("Tool Definitions (MCP/Skill support)", () => {
  it("should contain all base tool definitions", async () => {
    const { TOOL_DEFINITIONS } = await import("../src/tools/definitions.js");
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);

    // Core tools
    assert.ok(names.includes("Read"));
    assert.ok(names.includes("Write"));
    assert.ok(names.includes("Edit"));
    assert.ok(names.includes("Bash"));
    assert.ok(names.includes("Glob"));
    assert.ok(names.includes("Grep"));
    assert.ok(names.includes("SubAgent"));
    assert.ok(names.includes("SubAgentTeam"));
    assert.ok(names.includes("AgentTeams"));
  });

  it("should have valid function calling format for all tools", async () => {
    const { TOOL_DEFINITIONS } = await import("../src/tools/definitions.js");
    for (const tool of TOOL_DEFINITIONS) {
      assert.strictEqual(tool.type, "function");
      assert.ok(tool.function);
      assert.ok(typeof tool.function.name === "string");
      assert.ok(typeof tool.function.description === "string");
      assert.ok(tool.function.parameters);
      assert.strictEqual(tool.function.parameters.type, "object");
    }
  });
});

// ── CLI Integration Tests ──────────────────────────────────────────────────

describe("CLI flags (v1.3.0)", () => {
  it("cli.js should exist and be valid JS", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("cli.js", "utf-8");
    assert.ok(content.includes("--plan"));
    assert.ok(content.includes("--trust-mode"));
    assert.ok(content.includes("--mcp-config"));
    assert.ok(content.includes("--allow-project-mcp"));
    assert.ok(content.includes("--allow-project-hooks"));
    assert.ok(content.includes("MercuryRepl"));
  });

  it("should support all trust mode values", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("cli.js", "utf-8");
    assert.ok(content.includes("readonly"));
    assert.ok(content.includes("approval"));
    assert.ok(content.includes("acceptEdits"));
    assert.ok(content.includes("open"));
    assert.ok(content.includes("dontAsk"));
  });

  it("should have sandbox mode support", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("cli.js", "utf-8");
    assert.ok(content.includes("--sandbox"));
    assert.ok(content.includes("--no-sandbox"));
  });
});

// ── Package.json Tests ─────────────────────────────────────────────────────

describe("Package.json (v1.4.0)", () => {
  it("should have correct version", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version), "version should be semver");
  });

  it("should have mercury binary entries", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    assert.ok(pkg.bin.mercury);
    assert.ok(pkg.bin["mercury-code"]);
  });

  it("should not have os/cpu restrictions (cross-platform)", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    assert.strictEqual(pkg.os, undefined);
    assert.strictEqual(pkg.cpu, undefined);
  });

  it("should have mcp and agent keywords", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    assert.ok(pkg.keywords.includes("mcp"));
    assert.ok(pkg.keywords.includes("agent"));
  });

  it("should have postinstall script", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    assert.ok(pkg.scripts.postinstall);
  });
});

// ── Sandbox Cross-Platform Tests ───────────────────────────────────────────

describe("Sandbox (cross-platform)", () => {
  it("should handle Windows tmp directory in strict mode", async () => {
    const { Sandbox, SANDBOX_STRICT } = await import("../src/sandbox.js");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = process.platform === "win32"
      ? (process.env.TEMP || process.env.TMP || os.tmpdir())
      : "/tmp";
    const sandbox = new Sandbox({ mode: SANDBOX_STRICT, workspace: "/workspace" });
    sandbox.init();

    // The platform temp directory should always be readable in strict mode
    const result = sandbox.checkPath(path.join(tmpDir, "test.txt"), "read");
    assert.strictEqual(result.allowed, true);
  });

  it("should export all sandbox modes", async () => {
    const { SANDBOX_OFF, SANDBOX_ON, SANDBOX_STRICT, SANDBOX_MODES } = await import("../src/sandbox.js");
    assert.strictEqual(SANDBOX_OFF, "off");
    assert.strictEqual(SANDBOX_ON, "on");
    assert.strictEqual(SANDBOX_STRICT, "strict");
    assert.ok(SANDBOX_MODES.includes("off"));
    assert.ok(SANDBOX_MODES.includes("on"));
    assert.ok(SANDBOX_MODES.includes("strict"));
  });
});

// ── Postinstall Script Tests ───────────────────────────────────────────────

describe("Postinstall Script", () => {
  it("should exist and be valid JS", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("scripts/postinstall.js", "utf-8");
    assert.ok(content.includes("platform"));
    assert.ok(content.includes("mercury"));
  });
});

// ── Windows Install Script Tests ───────────────────────────────────────────

describe("Windows Install Script", () => {
  it("install.ps1 should exist", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("install.ps1", "utf-8");
    assert.ok(content.includes("mercury"));
    assert.ok(content.includes("npm"));
  });
});


describe("McpManager project config opt-in", () => {
  it("does not auto-load workspace MCP config by default", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mercury-mcp-"));
    const homeDir = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "workspace");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousWarn = console.warn;

    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      console.warn = () => {};
      await mkdir(path.join(workspace, ".mercury"), { recursive: true });
      await writeFile(path.join(workspace, ".mercury", "mcp.json"), JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"] },
        },
      }), "utf8");

      const mgr = new McpManager();
      let started = null;
      mgr._startServers = async (config) => {
        started = config;
      };

      const result = await mgr.loadConfig(workspace);
      assert.equal(result.loaded, false);
      assert.equal(started, null);
    } finally {
      console.warn = previousWarn;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads workspace MCP config when explicitly enabled", async () => {
    const { McpManager } = await import("../src/mcp.js");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mercury-mcp-"));
    const homeDir = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "workspace");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousWarn = console.warn;

    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      console.warn = () => {};
      await mkdir(path.join(workspace, ".mercury"), { recursive: true });
      await writeFile(path.join(workspace, ".mercury", "mcp.json"), JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"] },
        },
      }), "utf8");

      const mgr = new McpManager();
      let started = null;
      mgr._startServers = async (config) => {
        started = config;
      };

      const result = await mgr.loadConfig(workspace, null, { allowProjectConfig: true });
      assert.equal(result.loaded, true);
      assert.equal(result.isProjectConfig, true);
      assert.deepEqual(started, {
        local: { command: "node", args: ["server.js"] },
      });
    } finally {
      console.warn = previousWarn;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
