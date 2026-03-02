// Tests for src/hooks.js — Hook system lifecycle events
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HooksManager, HOOK_EVENTS } from "../src/hooks.js";

describe("HooksManager: basic", () => {
  it("initializes with all event types", () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    assert.ok(hooks);
    for (const event of HOOK_EVENTS) {
      assert.equal(hooks.hasHandlers(event), false);
    }
  });

  it("registers and fires function handlers", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let fired = false;
    hooks.register("SessionStart", {
      id: "test-hook",
      type: "function",
      fn: async (event, ctx) => {
        fired = true;
        assert.equal(event, "SessionStart");
        assert.equal(ctx.workspace, "/tmp");
        return { action: "continue" };
      },
    });
    assert.equal(hooks.hasHandlers("SessionStart"), true);
    await hooks.fireSessionStart("/tmp");
    assert.equal(fired, true);
  });

  it("unregisters handlers by ID", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PreToolUse", {
      id: "removable",
      type: "function",
      fn: async () => ({ action: "deny", message: "blocked" }),
    });
    assert.equal(hooks.hasHandlers("PreToolUse"), true);
    hooks.unregister("PreToolUse", "removable");
    assert.equal(hooks.hasHandlers("PreToolUse"), false);
  });

  it("returns continue when no handlers registered", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    const result = await hooks.fire("PreToolUse", { toolName: "Bash" });
    assert.equal(result.action, "continue");
    assert.deepEqual(result.results, []);
  });
});

describe("HooksManager: PreToolUse", () => {
  it("deny action short-circuits execution", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PreToolUse", {
      id: "deny-bash",
      type: "function",
      matcher: "Bash",
      fn: async () => ({ action: "deny", message: "Bash not allowed" }),
    });

    const result = await hooks.firePreToolUse("Bash", { command: "echo hello" });
    assert.equal(result.action, "deny");
    assert.equal(result.message, "Bash not allowed");
  });

  it("allow action short-circuits execution", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PreToolUse", {
      id: "allow-read",
      type: "function",
      matcher: "Read",
      fn: async () => ({ action: "allow" }),
    });

    const result = await hooks.firePreToolUse("Read", { file_path: "/tmp/test" });
    assert.equal(result.action, "allow");
  });

  it("modify action returns updatedInput", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PreToolUse", {
      id: "modify-bash",
      type: "function",
      matcher: "Bash",
      fn: async (_event, ctx) => ({
        action: "modify",
        updatedInput: { command: ctx.toolInput.command + " --safe" },
      }),
    });

    const result = await hooks.firePreToolUse("Bash", { command: "rm file" });
    assert.equal(result.action, "modify");
    assert.equal(result.updatedInput.command, "rm file --safe");
  });

  it("matcher filters by tool name", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let called = false;
    hooks.register("PreToolUse", {
      id: "bash-only",
      type: "function",
      matcher: "Bash",
      fn: async () => { called = true; return { action: "deny" }; },
    });

    // Should NOT fire for Read
    const result = await hooks.firePreToolUse("Read", { file_path: "/tmp/file" });
    assert.equal(result.action, "continue");
    assert.equal(called, false);

    // Should fire for Bash
    const result2 = await hooks.firePreToolUse("Bash", { command: "echo" });
    assert.equal(result2.action, "deny");
    assert.equal(called, true);
  });

  it("wildcard matcher matches all tools", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let callCount = 0;
    hooks.register("PreToolUse", {
      id: "log-all",
      type: "function",
      matcher: "*",
      fn: async () => { callCount++; return { action: "continue" }; },
    });

    await hooks.firePreToolUse("Read", {});
    await hooks.firePreToolUse("Bash", {});
    await hooks.firePreToolUse("Write", {});
    assert.equal(callCount, 3);
  });
});

describe("HooksManager: PostToolUse", () => {
  it("fires after tool execution", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let captured = null;
    hooks.register("PostToolUse", {
      id: "log-post",
      type: "function",
      fn: async (_event, ctx) => {
        captured = ctx;
        return { action: "continue" };
      },
    });

    await hooks.firePostToolUse("Bash", { command: "echo hi" }, "hi\n");
    assert.ok(captured);
    assert.equal(captured.toolName, "Bash");
    assert.equal(captured.result, "hi\n");
  });
});

describe("HooksManager: agent lifecycle hooks", () => {
  it("fires SubagentStart", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("SubagentStart", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.fireSubagentStart("agent-123", "search for files");
    assert.equal(ctx.agentId, "agent-123");
    assert.equal(ctx.task, "search for files");
  });

  it("fires SubagentStop", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("SubagentStop", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.fireSubagentStop("agent-123", "found 5 files");
    assert.equal(ctx.agentId, "agent-123");
    assert.equal(ctx.result, "found 5 files");
  });

  it("fires TeammateIdle", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("TeammateIdle", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.fireTeammateIdle("mate-abc", "Worker 1");
    assert.equal(ctx.agentId, "mate-abc");
    assert.equal(ctx.agentName, "Worker 1");
  });

  it("fires TaskCompleted", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("TaskCompleted", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.fireTaskCompleted("task-1", "done", false);
    assert.equal(ctx.taskId, "task-1");
    assert.equal(ctx.isError, false);
  });

  it("fires WorktreeCreate", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("WorktreeCreate", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.fireWorktreeCreate("/tmp/wt", "feature-branch", "agent-1");
    assert.equal(ctx.worktreePath, "/tmp/wt");
    assert.equal(ctx.branch, "feature-branch");
  });

  it("fires WorktreeRemove", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("WorktreeRemove", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.fireWorktreeRemove("/tmp/wt", "feature-branch", true);
    assert.equal(ctx.hadChanges, true);
  });

  it("fires PreCompact", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let ctx = null;
    hooks.register("PreCompact", {
      id: "test", type: "function",
      fn: async (_e, c) => { ctx = c; return { action: "continue" }; },
    });
    await hooks.firePreCompact(120000, 3);
    assert.equal(ctx.tokenCount, 120000);
    assert.equal(ctx.compactionCount, 3);
  });
});

describe("HooksManager: prompt type handler", () => {
  it("returns prompt content as result", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PreToolUse", {
      id: "prompt-hook",
      type: "prompt",
      prompt: "Be careful with this tool",
    });

    const result = await hooks.firePreToolUse("Bash", {});
    assert.equal(result.action, "continue");
    assert.equal(result.results[0].prompt, "Be careful with this tool");
  });
});

describe("HooksManager: error handling", () => {
  it("continues on handler error", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PreToolUse", {
      id: "error-hook",
      type: "function",
      fn: async () => { throw new Error("hook crashed"); },
    });

    const result = await hooks.firePreToolUse("Bash", {});
    assert.equal(result.action, "continue");
    assert.equal(result.results[0].error, "hook crashed");
  });

  it("continues with multiple handlers if first errors", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    hooks.register("PostToolUse", {
      id: "bad-hook",
      type: "function",
      fn: async () => { throw new Error("oops"); },
    });
    let secondCalled = false;
    hooks.register("PostToolUse", {
      id: "good-hook",
      type: "function",
      fn: async () => { secondCalled = true; return { action: "continue" }; },
    });

    await hooks.firePostToolUse("Read", {}, "data");
    assert.equal(secondCalled, true);
  });
});

describe("HooksManager: Tool matcher patterns", () => {
  it("matches Tool(specifier) pattern", async () => {
    const hooks = new HooksManager({ workspace: "/tmp" });
    let called = false;
    hooks.register("PreToolUse", {
      id: "bash-git",
      type: "function",
      matcher: "Bash(git *)",
      fn: async () => { called = true; return { action: "continue" }; },
    });

    // Should match Bash
    await hooks.firePreToolUse("Bash", { command: "git status" });
    assert.equal(called, true);

    // Should not match Write
    called = false;
    await hooks.firePreToolUse("Write", { file_path: "/tmp/test" });
    assert.equal(called, false);
  });
});
