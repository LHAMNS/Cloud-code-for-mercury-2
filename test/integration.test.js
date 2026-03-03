/**
 * Integration tests — cross-module interactions for Mercury Code.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { Conversation } from "../src/conversation.js";
import { MemoryManager, ConversationLog } from "../src/memory.js";
import { RollbackManager } from "../src/rollback.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { Sandbox } from "../src/sandbox.js";
import { PermissionManager } from "../src/permissions.js";
import { AgentTeam } from "../src/agent-teams.js";
import { labs } from "../src/labs.js";
import { estimateTokens } from "../src/context.js";
import { searchSymbols, fileOutline } from "../src/ast-search.js";
import { loadProjectConfig } from "../src/project-config.js";

let tmpDir;
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "integ-"));
  labs.enabled = false;
  labs._overrides = new Map();
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// 1. Conversation + Memory
describe("Integration: Conversation + Memory", () => {
  it("conversation loads memory from MemoryManager", async () => {
    const mem = new MemoryManager(tmpDir);
    await mem.append("Important fact: the server runs on port 3000");
    const conv = new Conversation("You are a helpful assistant.");
    await conv.loadMemory(mem);
    const msgs = conv.getMessages();
    assert.ok(msgs[0].content.includes("port 3000"),
      "System message should include memory content");
  });

  it("memory persists across conversation clear", async () => {
    const mem = new MemoryManager(tmpDir);
    await mem.append("Persisted fact");
    const conv = new Conversation("System");
    await conv.loadMemory(mem);
    conv.addUserMessage("test");
    conv.clear();
    const msgs = conv.getMessages();
    assert.ok(msgs[0].content.includes("Persisted fact"),
      "Memory should persist after clear");
  });
});

// 2. Conversation + Rollback
describe("Integration: Conversation + Rollback", () => {
  it("rollback restores conversation state", () => {
    const conv = new Conversation("System prompt");
    const rb = new RollbackManager("/tmp");

    rb.createCheckpoint("Before first", conv.messages);
    conv.addUserMessage("Hello");
    conv.addAssistantMessage("Hi there");
    rb.createCheckpoint("After first exchange", conv.messages);

    const result = rb.contextRollback(0);
    assert.ok(result.restored);
    assert.equal(result.messages.length, 0, "Should restore empty state");
  });
});

// 3. Sandbox blocks sensitive paths
describe("Integration: Sandbox sensitive path blocking", () => {
  it("sandbox blocks sensitive credential paths", () => {
    const sandbox = new Sandbox({ mode: "on", workspace: tmpDir });
    sandbox.init();
    const home = process.env.HOME || "/root";
    const blocked = sandbox.checkPath(path.join(home, ".ssh", "id_rsa"));
    assert.ok(!blocked.allowed, "Should block .ssh paths");
    // Workspace paths should be allowed
    const allowed = sandbox.checkPath(path.join(tmpDir, "src", "index.js"));
    assert.ok(allowed.allowed, "Should allow workspace paths");
  });
});

// 4. AgentTeam task workflow
describe("Integration: AgentTeam task workflow", () => {
  it("full pipeline: add tasks, claim, complete with dependencies", () => {
    const team = new AgentTeam({ teamName: "dev-pipeline", workspace: tmpDir });
    const t1 = team.addTask({ title: "Plan", detail: "Create plan" });
    const t2 = team.addTask({ title: "Implement", detail: "Write code", depends: [t1.id] });
    const t3 = team.addTask({ title: "Test", detail: "Run tests", depends: [t2.id] });

    // Only t1 is available (no blocking deps)
    const next = team.getNextTask();
    assert.equal(next.id, t1.id);

    // Claim and complete t1
    team.claimTask(t1.id, "agent-1");
    team.completeTask(t1.id, "Plan done");

    // Now t2 is available
    const next2 = team.getNextTask();
    assert.equal(next2.id, t2.id);

    team.claimTask(t2.id, "agent-2");
    team.completeTask(t2.id, "Code written");

    // Now t3 is available
    const next3 = team.getNextTask();
    assert.equal(next3.id, t3.id);
  });

  it("mailbox messaging between teammates", () => {
    const team = new AgentTeam({ teamName: "msg-team", workspace: tmpDir });
    team.sendMessage("lead", "worker-1", "Please start task A");
    team.sendMessage("worker-1", "lead", "Started task A");
    assert.equal(team.mailbox.length, 2);
    assert.equal(team.mailbox[0].from, "lead");
    assert.equal(team.mailbox[1].content, "Started task A");
  });
});

// 5. ToolExecutor file operations
describe("Integration: ToolExecutor file operations", () => {
  it("executor reads and writes files in workspace", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    await writeFile(testFile, "Hello world\n", "utf-8");
    const exec = new ToolExecutor({ workspace: tmpDir, trustMode: "open" });
    const result = await exec.execute("Read", { file_path: testFile });
    assert.ok(result.includes("Hello world"), `Should read file: ${result.slice(0, 100)}`);
  });

  it("readonly mode blocks writes", async () => {
    const exec = new ToolExecutor({ workspace: tmpDir, trustMode: "readonly" });
    const result = await exec.execute("Write", {
      file_path: path.join(tmpDir, "blocked.txt"),
      content: "should not write",
    });
    assert.ok(result.includes("Error") || result.includes("read") || result.includes("disabled"),
      `Should block write in readonly: ${result.slice(0, 100)}`);
  });
});

// 6. Labs feature flags
describe("Integration: Labs feature flags", () => {
  it("consistent feature state", () => {
    const val1 = labs.isActive("memory");
    const val2 = labs.isActive("memory");
    assert.equal(val1, val2);
  });
});

// 7. AST search
describe("Integration: AST search", () => {
  it("search symbols in dynamically created file", async () => {
    const file = path.join(tmpDir, "dynamic.js");
    await writeFile(file, `
class DynamicHandler {
  handle(request) { return "ok"; }
}
function processRequest(req) { return new DynamicHandler().handle(req); }
    `.trim(), "utf-8");
    const symbols = await searchSymbols(tmpDir, "Dynamic");
    assert.ok(symbols.length > 0, "Should find DynamicHandler");
    const outline = await fileOutline(file);
    assert.ok(outline.includes("DynamicHandler"));
  });
});

// 8. ProjectConfig loading
describe("Integration: ProjectConfig loading", () => {
  it("loads MERCURY.md", async () => {
    await writeFile(path.join(tmpDir, "MERCURY.md"), "# Rules\n- Use TypeScript\n", "utf-8");
    const config = await loadProjectConfig(tmpDir);
    assert.ok(typeof config === "string");
    assert.ok(config.includes("TypeScript"));
  });
});

// 9. Token estimation
describe("Integration: Token estimation", () => {
  it("estimate grows with messages", () => {
    const conv = new Conversation("System prompt");
    const est1 = conv.getTokenEstimate();
    conv.addUserMessage("Hello, how are you?");
    conv.addAssistantMessage("I'm doing well!");
    const est2 = conv.getTokenEstimate();
    assert.ok(est2 > est1);
  });

  it("API usage baseline", () => {
    const conv = new Conversation("System");
    conv.addUserMessage("test");
    conv.addAssistantMessage("reply");
    conv.updateUsage({ prompt_tokens: 100, total_tokens: 150 });
    conv.addUserMessage("follow-up");
    const est = conv.getTokenEstimate();
    assert.ok(est >= 150);
  });
});
