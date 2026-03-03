/**
 * Stress tests for Mercury Code — large-scale reliability testing.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Conversation } from "../src/conversation.js";
import { MemoryManager, ConversationLog } from "../src/memory.js";
import { RollbackManager } from "../src/rollback.js";
import { PermissionManager } from "../src/permissions.js";
import { Sandbox } from "../src/sandbox.js";
import { estimateTokens, estimateMessagesTokens } from "../src/context.js";
import { AgentTeam } from "../src/agent-teams.js";
import { labs } from "../src/labs.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { searchSymbols, fileOutline } from "../src/ast-search.js";

let tmpDir;
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "stress-"));
  labs.enabled = false;
  labs._overrides = new Map();
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });

describe("Stress: Conversation 1000 messages", () => {
  it("handles 1000 messages", () => {
    const conv = new Conversation("System");
    for (let i = 0; i < 500; i++) {
      conv.addUserMessage("User msg " + i + " " + "x".repeat(200));
      conv.addAssistantMessage("Reply " + i + " " + "y".repeat(200));
    }
    assert.equal(conv.messages.length, 1000);
    assert.equal(conv.getMessages().length, 1001);
  });
  it("token estimation on large conversation", () => {
    const conv = new Conversation("System");
    for (let i = 0; i < 200; i++) {
      conv.addUserMessage("Hello world ".repeat(50));
      conv.addAssistantMessage("Response ".repeat(50));
    }
    const est = conv.getTokenEstimate();
    assert.ok(est > 0 && est < 10000000);
  });
});

describe("Stress: MemoryManager 100 appends", () => {
  it("100 sequential appends", async () => {
    const mem = new MemoryManager(tmpDir);
    for (let i = 0; i < 100; i++) await mem.append("Fact #" + i + ": important info.");
    const content = await mem.read();
    assert.ok(content.includes("Fact #99"));
  });
  it("overflow trimming", async () => {
    const mem = new MemoryManager(tmpDir);
    for (let i = 0; i < 200; i++) await mem.append("X".repeat(500) + " entry-" + i);
    const content = await mem.read();
    assert.ok(content.length <= 85000);
    assert.ok(content.includes("entry-199"));
  });
});

describe("Stress: ConversationLog 500 entries", () => {
  it("500 log entries", async () => {
    const log = new ConversationLog(tmpDir);
    for (let i = 0; i < 500; i++) await log.append({ role: "user", content: "Msg " + i, index: i });
    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(path.join(tmpDir, ".mercury", "conversation.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 500);
    assert.equal(JSON.parse(lines[499]).index, 499);
  });
});

describe("Stress: RollbackManager 200 checkpoints", () => {
  it("200 checkpoints", () => {
    const rm = new RollbackManager("/tmp");
    const msgs = [];
    for (let i = 0; i < 200; i++) {
      msgs.push({ role: "user", content: "Msg " + i });
      rm.createCheckpoint("CP " + i, msgs);
    }
    assert.equal(rm.count, 200);
    assert.equal(rm.getCheckpoints()[199].userMessage, "CP 199");
  });
  it("rapid rollback cycles", () => {
    const mgr = new RollbackManager("/tmp");
    for (let i = 0; i < 50; i++) mgr.createCheckpoint("cp-" + i, [{ role: "user", content: "m" + i }]);
    for (let c = 0; c < 20; c++) {
      const t = Math.floor(Math.random() * mgr.count);
      const r = mgr.contextRollback(t);
      assert.ok(r.restored);
      assert.equal(mgr.count, t + 1);
      for (let i = mgr.count; i < 50; i++) mgr.createCheckpoint("rebuilt-" + i, []);
    }
  });
});

describe("Stress: AgentTeam large task set", () => {
  it("100 serial task dependencies", () => {
    const team = new AgentTeam({ teamName: "serial-stress", workspace: tmpDir });
    const tasks = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(team.addTask({ title: "T" + i, detail: "Task " + i, depends: i > 0 ? [tasks[i-1].id] : [] }));
    }
    // Only first task should be available
    const next = team.getNextTask();
    assert.equal(next.id, tasks[0].id);
  });
  it("1000 mailbox messages", () => {
    const team = new AgentTeam({ teamName: "mail-stress", workspace: tmpDir });
    for (let i = 0; i < 1000; i++) team.sendMessage("sender", "receiver", "Msg " + i);
    assert.equal(team.mailbox.length, 1000);
  });
  it("diamond dependency pattern", () => {
    const team = new AgentTeam({ teamName: "diamond-stress", workspace: tmpDir });
    const root = team.addTask({ title: "Root", detail: "Root task" });
    const branches = [];
    for (let i = 0; i < 50; i++) branches.push(team.addTask({ title: "B" + i, detail: "", depends: [root.id] }));
    team.addTask({ title: "Sink", detail: "", depends: branches.map(b => b.id) });
    // Only root should be next
    assert.equal(team.getNextTask().id, root.id);
    // Complete root
    team.claimTask(root.id, "agent-0");
    team.completeTask(root.id, "done");
    // All branches should now be available (50 of them)
    let available = 0;
    for (let i = 0; i < 50; i++) {
      const t = team.getNextTask();
      if (t) { team.claimTask(t.id, "agent-" + (i+1)); available++; }
    }
    assert.equal(available, 50);
  });
});

describe("Stress: PermissionManager 10K checks", () => {
  it("10000 permission checks < 5s", () => {
    const pm = new PermissionManager("approval");
    const tools = ["Read", "Write", "Bash", "Edit", "Glob", "Grep"];
    const start = Date.now();
    for (let i = 0; i < 10000; i++) pm.check(tools[i % 6], { path: "/tmp/f-" + i });
    assert.ok(Date.now() - start < 5000);
  });
});

describe("Stress: Sandbox 5K path checks", () => {
  it("5000 path checks fast", () => {
    const sb = new Sandbox({ mode: "on", workspace: tmpDir });
    sb.init();
    const start = Date.now();
    for (let i = 0; i < 5000; i++) {
      sb.checkPath(path.join(tmpDir, "src", "f-" + i + ".js"));
    }
    assert.ok(Date.now() - start < 3000);
  });
  it("blocks sensitive paths at scale", () => {
    const sb = new Sandbox({ mode: "on", workspace: tmpDir });
    sb.init();
    const home = process.env.HOME || "/root";
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      if (!sb.checkPath(path.join(home, ".ssh", "key-" + i)).allowed) blocked++;
    }
    assert.equal(blocked, 1000, "All .ssh paths should be blocked");
  });
});

describe("Stress: Token estimation large strings", () => {
  it("1MB string", () => {
    const big = "Hello world token. ".repeat(55000);
    const est = estimateTokens(big);
    assert.ok(est > 100000 && est < 2000000);
  });
  it("500 large messages array", () => {
    const msgs = [];
    for (let i = 0; i < 500; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(2000) });
    assert.ok(estimateMessagesTokens(msgs) > 0);
  });
});

describe("Stress: AST extraction large file", () => {
  it("1000-function JS file", async () => {
    const f = path.join(tmpDir, "big.js");
    let code = "";
    for (let i = 0; i < 500; i++) code += "function fn_" + i + "(a,b){return a+b+" + i + ";}\nclass C_" + i + "{constructor(){this.v=" + i + ";}}\n";
    await writeFile(f, code, "utf-8");
    const syms = await searchSymbols(tmpDir, "fn_");
    assert.ok(syms.length > 0);
    const ol = await fileOutline(f);
    assert.ok(ol.length > 100);
  });
});

describe("Stress: Labs 1000 toggles", () => {
  it("1000 feature checks", () => {
    for (let i = 0; i < 1000; i++) assert.ok(typeof labs.isActive("memory") === "boolean");
  });
});

describe("Stress: ToolExecutor 50 rapid ops", () => {
  it("50 rapid Reads", async () => {
    for (let i = 0; i < 50; i++) await writeFile(path.join(tmpDir, "f-" + i + ".txt"), "Content " + i + "\n".repeat(100), "utf-8");
    const exec = new ToolExecutor({ workspace: tmpDir, trustMode: "open" });
    for (let i = 0; i < 50; i++) {
      const r = await exec.execute("Read", { file_path: path.join(tmpDir, "f-" + i + ".txt") });
      assert.ok(r.includes("Content " + i));
    }
  });
  it("50 rapid Writes", async () => {
    const exec = new ToolExecutor({ workspace: tmpDir, trustMode: "open" });
    for (let i = 0; i < 50; i++) {
      const r = await exec.execute("Write", { file_path: path.join(tmpDir, "w-" + i + ".txt"), content: "Written " + i });
      assert.ok(!r.includes("Error"), "Write " + i + " failed: " + (r||"").slice(0, 80));
    }
  });
});

describe("Stress: Mixed concurrent patterns", () => {
  it("conversation + memory + rollback combined", async () => {
    const conv = new Conversation("Stress sys prompt");
    const mem = new MemoryManager(tmpDir);
    const rb = new RollbackManager("/tmp");
    for (let i = 0; i < 50; i++) {
      conv.addUserMessage("User " + i + " " + "d ".repeat(20));
      conv.addAssistantMessage("Asst " + i + " " + "r ".repeat(20));
      await mem.append("Turn " + i + " facts");
      rb.createCheckpoint("Turn " + i, conv.messages);
    }
    assert.equal(conv.messages.length, 100);
    assert.equal(rb.count, 50);
    const r = rb.contextRollback(25);
    assert.ok(r.restored);
    assert.equal(r.messages.length, 52);
  });
  it("sandbox + permissions combined", () => {
    const sb = new Sandbox({ mode: "on", workspace: tmpDir });
    sb.init();
    const pm = new PermissionManager("approval");
    for (let i = 0; i < 2000; i++) {
      sb.checkPath(path.join(tmpDir, "src", "f-" + i + ".js"));
      pm.check("Read", { path: path.join(tmpDir, "src", "f-" + i) });
      pm.check("Bash", { command: "echo " + i });
    }
    // Just verify no crashes
    assert.ok(true);
  });
});
