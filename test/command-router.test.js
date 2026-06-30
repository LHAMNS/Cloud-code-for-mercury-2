// Tests for src/command-router.js — command dispatch, registration, hasCommand
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommandRouter } from "../src/command-router.js";

function createMockRepl() {
  return {
    conversation: { clear: () => {} },
    log: { clear: async () => {} },
    rollback: { checkpoints: [] },
    client: {
      config: { reasoning_effort: "medium", model: "mercury-2" },
      providerName: "mercury",
      provider: { displayName: "Mercury-2", envKey: "INCEPTION_API_KEY" },
    },
    superCompress: false,
    contextSearchEnabled: true,
    workspace: "/workspace",
    trustMode: "approval",
    planMode: false,
    allowOutsideWorkspace: false,
    verbose: false,
    webBridgeMode: false,
    sandbox: { enabled: false },
    mcpManager: { getStatus: () => [] },
    skillManager: { count: 0, formatList: () => "No skills found." },
    _trustLabel: (mode) => mode,
    _reloadPermissions: async () => {},
    _refreshConversationSystemPrompt: () => {},
    _reloadWorkspaceState: async () => ({ mcpResult: { count: 0 } }),
    _handleSandbox: async () => {},
    _handleSentinel: async () => {},
    _handleHistory: async () => {},
    _printContextInfo: () => {},
    _handleSettings: async () => {},
    _handleAgents: async () => {},
    _handleLabs: async () => {},
    _handleInit: async () => {},
    _handleDiff: async () => {},
    _handleCompact: async () => {},
    _handleNew: async () => {},
    _handleCopy: () => {},
    _handleCost: () => {},
    _handleDoctor: async () => {},
    _handleStatus: () => {},
    _handleMemory: async () => {},
    _handleUndo: async () => {},
    _handleMcp: async () => {},
    _handleSkills: () => {},
    _handleExport: async () => {},
    _setClientConnection: () => {},
    _gracefulExit: async () => {},
    _onProviderChanged: null,
    switchProvider: () => {},
  };
}

describe("CommandRouter.hasCommand", () => {
  const repl = createMockRepl();
  const router = new CommandRouter(repl);

  const EXPECTED_COMMANDS = [
    "help", "clear", "config", "reasoning", "supercompress",
    "contextsearch", "trust", "workspace", "sandbox", "sentinel",
    "history", "context", "settings", "agents", "labs", "init",
    "diff", "compact", "new", "copy", "edit", "cost", "doctor",
    "bug", "status", "memory", "model", "undo", "login", "logout",
    "verbose", "mcp", "skills", "export", "provider", "exit",
  ];

  for (const cmd of EXPECTED_COMMANDS) {
    it(`has command: ${cmd}`, () => {
      assert.ok(router.hasCommand(cmd), `Should have command: ${cmd}`);
    });
  }

  it("returns false for unregistered commands", () => {
    assert.ok(!router.hasCommand("nonexistent"));
    assert.ok(!router.hasCommand(""));
    assert.ok(!router.hasCommand("foo"));
  });
});

describe("CommandRouter.getCommands", () => {
  const repl = createMockRepl();
  const router = new CommandRouter(repl);

  it("returns a Map with all commands", () => {
    const cmds = router.getCommands();
    assert.ok(cmds instanceof Map);
    assert.ok(cmds.size >= 30, `Expected 30+ commands, got ${cmds.size}`);
  });

  it("each command has handler and description", () => {
    const cmds = router.getCommands();
    for (const [name, cmd] of cmds) {
      assert.ok(typeof cmd.handler === "function", `${name} should have handler`);
      assert.ok(typeof cmd.description === "string", `${name} should have description`);
      assert.ok(cmd.description.length > 0, `${name} should have non-empty description`);
    }
  });
});

describe("CommandRouter.execute", () => {
  it("returns true for known commands", async () => {
    const repl = createMockRepl();
    const router = new CommandRouter(repl);
    const result = await router.execute("help", ["/help"]);
    assert.equal(result, true);
  });

  it("returns false for unknown commands", async () => {
    const repl = createMockRepl();
    const router = new CommandRouter(repl);
    const result = await router.execute("nonexistent", ["/nonexistent"]);
    assert.equal(result, false);
  });

  it("executes clear command and resets conversation", async () => {
    const repl = createMockRepl();
    let cleared = false;
    repl.conversation.clear = () => { cleared = true; };
    const router = new CommandRouter(repl);
    await router.execute("clear", ["/clear"]);
    assert.ok(cleared, "Conversation should have been cleared");
  });

  it("executes verbose toggle", async () => {
    const repl = createMockRepl();
    repl.verbose = false;
    const router = new CommandRouter(repl);
    await router.execute("verbose", ["/verbose"]);
    assert.equal(repl.verbose, true);
    await router.execute("verbose", ["/verbose"]);
    assert.equal(repl.verbose, false);
  });

  it("executes supercompress toggle", async () => {
    const repl = createMockRepl();
    repl.superCompress = false;
    const router = new CommandRouter(repl);
    await router.execute("supercompress", ["/supercompress"]);
    assert.equal(repl.superCompress, true);
  });

  it("executes contextsearch toggle", async () => {
    const repl = createMockRepl();
    repl.contextSearchEnabled = true;
    const router = new CommandRouter(repl);
    await router.execute("contextsearch", ["/contextsearch"]);
    assert.equal(repl.contextSearchEnabled, false);
  });
});
