import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

process.env.INCEPTION_API_KEY = process.env.INCEPTION_API_KEY || "test-key-for-unit-tests";

import { Sandbox, SANDBOX_ON } from "../src/sandbox.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { Conversation } from "../src/conversation.js";
import { AgentTeam } from "../src/agent-teams.js";
import { MercuryRepl } from "../src/repl.js";
import { PermissionManager } from "../src/permissions.js";
import { MemoryManager } from "../src/memory.js";

describe("hardening regressions", () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "mercury-hardening-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("blocks sensitive paths when HOME is a symlink", async () => {
    // Skip on Windows where symlink creation requires admin privileges
    if (process.platform === "win32") return;

    const realHome = path.join(tempRoot, "real-home");
    const linkedHome = path.join(tempRoot, "linked-home");
    await mkdir(realHome, { recursive: true });
    fs.symlinkSync(realHome, linkedHome, "dir");

    const originalHome = process.env.HOME;
    process.env.HOME = linkedHome;
    try {
      const sandbox = new Sandbox({ mode: SANDBOX_ON, workspace: tempRoot }).init();
      const result = sandbox.checkPath(path.join(linkedHome, ".aws", "credentials"), "read");
      assert.equal(result.allowed, false);
      assert.match(result.reason, /sensitive credentials path/i);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("blocks outside-workspace reads in sandbox on mode", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const outsidePath = path.join(os.homedir(), "mercury-hardening-outside", "secret.txt");

    const sandbox = new Sandbox({ mode: SANDBOX_ON, workspace }).init();
    const result = sandbox.checkPath(outsidePath, "read");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /outside/i);
  });

  it("blocks glob, grep, and listdir outside workspace when sandbox is off", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.js"), "token=123", "utf-8");

    const executor = new ToolExecutor({ workspace, trustMode: "open" });
    const globResult = await executor.execute("glob", { path: outside, pattern: "**/*.js" });
    const grepResult = await executor.execute("grep", { path: outside, pattern: "token" });
    const listResult = await executor.execute("listdir", { path: outside });

    assert.match(globResult, /outside workspace/i);
    assert.match(grepResult, /outside workspace/i);
    assert.match(listResult, /outside workspace/i);
  });

  it("blocks diff outside workspace when sandbox is off", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });

    const a = path.join(outside, "a.txt");
    const b = path.join(outside, "b.txt");
    await writeFile(a, "a", "utf-8");
    await writeFile(b, "b", "utf-8");

    const executor = new ToolExecutor({ workspace, trustMode: "open" });
    const result = await executor.execute("diff", { file_a: a, file_b: b });
    assert.match(result, /outside workspace/i);
  });

  it("uses prompt_tokens instead of total_tokens for incremental token estimation", () => {
    const conversation = new Conversation("system");
    conversation.addUserMessage("hello");
    conversation.updateUsage({ prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 });
    conversation.addAssistantMessage("world");

    const estimate = conversation.getTokenEstimate();
    assert.ok(estimate >= 100);
    assert.ok(estimate < 180, `token estimate reused total_tokens baseline: ${estimate}`);
  });

  it("requeues an in-progress task when a teammate is shut down", () => {
    const team = new AgentTeam({ teamName: "requeue-test", workspace: tempRoot });
    const task = team.addTask({ title: "Task", detail: "Detail" });
    const mate = team.spawnTeammate({ name: "Worker" });

    assert.equal(team.claimTask(task.id, mate.id), true);
    mate.currentTaskId = task.id;
    mate.status = "working";

    team.shutdownTeammate(mate.id);

    const updated = team.tasks.get(task.id);
    assert.equal(updated.status, "pending");
    assert.equal(updated.assignee, null);
  });

  it("fails fast when pending tasks have no teammates", async () => {
    const team = new AgentTeam({ teamName: "deadlock-test", workspace: tempRoot });
    const task = team.addTask({ title: "Task", detail: "Detail" });

    const results = await team.run();
    assert.match(results.get(task.id), /No teammates are available/i);
    assert.equal(team.tasks.get(task.id).error, true);
  });

  it("fails dependent tasks instead of hanging after a prerequisite error", async () => {
    const team = new AgentTeam({ teamName: "blocked-deps", workspace: tempRoot });
    const parent = team.addTask({ title: "Parent", detail: "Parent" });
    const child = team.addTask({ title: "Child", detail: "Child", depends: [parent.id] });
    team.spawnTeammate({ name: "Worker" });

    await team.completeTask(parent.id, "failed", true);
    const results = await team.run();

    assert.match(results.get(child.id), /failed dependencies/i);
    assert.equal(team.tasks.get(child.id).error, true);
  });

  it("reloads workspace state with fresh memory and project instructions", async () => {
    const ws1 = path.join(tempRoot, "ws1");
    const ws2 = path.join(tempRoot, "ws2");
    await mkdir(path.join(ws1, ".mercury"), { recursive: true });
    await mkdir(path.join(ws2, ".mercury"), { recursive: true });
    await writeFile(path.join(ws2, "MERCURY.md"), "Use strict formatting.", "utf-8");
    await writeFile(path.join(ws2, ".mercury", "memory.md"), "project-two-memory", "utf-8");

    const repl = new MercuryRepl({ workspace: ws1, trustMode: "approval" });
    repl.sandbox.init();
    repl.conversation = new Conversation("old");
    repl.conversation.addUserMessage("from workspace one");

    repl.workspace = ws2;
    await repl._reloadWorkspaceState({
      resetConversation: true,
      reloadMcp: false,
      reloadSkills: false,
      announceProjectConfig: false,
    });

    assert.deepEqual(repl.conversation.messages, []);
    const allMessages = repl.conversation.getMessages();
    const flattened = allMessages.map((msg) => msg.content || "").join("\n\n");
    assert.match(flattened, /Use strict formatting\./);
    assert.match(flattened, /project-two-memory/);
  });

  it("honors explicit permission rules in main-agent permission checks", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const repl = new MercuryRepl({ workspace, trustMode: "readonly" });
    repl.permissionManager = new PermissionManager({ workspace, trustMode: "readonly" });
    repl.permissionManager.allowRules = ["Write"];
    repl.permissionManager.denyRules = ["Read"];

    const deniedRead = await repl._checkPermission("Read", { file_path: path.join(workspace, "a.txt") });
    const allowedWrite = await repl._checkPermission("Write", { file_path: path.join(workspace, "a.txt") });

    assert.equal(deniedRead.allowed, false);
    assert.equal(allowedWrite.allowed, true);
    assert.equal(allowedWrite.needsApproval, false);
  });

  it("supports sandbox workspace updates after init", () => {
    const sandbox = new Sandbox({ mode: SANDBOX_ON, workspace: tempRoot }).init();
    const nextWorkspace = path.join(tempRoot, "other");
    sandbox.setWorkspace(nextWorkspace);
    assert.equal(sandbox.workspace, nextWorkspace);
  });

  it("serializes concurrent memory appends without dropping entries", async () => {
    const memory = new MemoryManager(tempRoot);
    await Promise.all([
      memory.append("first entry"),
      memory.append("second entry"),
    ]);

    const content = await memory.read();
    assert.match(content, /first entry/);
    assert.match(content, /second entry/);
  });

  it("refreshes the system prompt after sandbox mode changes", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    const repl = new MercuryRepl({ workspace, trustMode: "approval" });
    repl.sandbox.init();
    await repl._reloadWorkspaceState({
      resetConversation: true,
      reloadMcp: false,
      reloadSkills: false,
      announceProjectConfig: false,
    });

    const promptBefore = repl.conversation.systemPrompt;
    await repl._handleSandbox(["off"]);
    const promptOff = repl.conversation.systemPrompt;
    await repl._handleSandbox(["strict"]);
    const promptStrict = repl.conversation.systemPrompt;

    assert.notEqual(promptBefore, promptOff);
    assert.match(promptOff, /No sandbox isolation is active/i);
    assert.match(promptStrict, /<sandbox mode="strict"/i);
  });

  it("rejects invalid boolean settings instead of silently coercing them", async () => {
    const repl = new MercuryRepl({ workspace: tempRoot, trustMode: "approval" });
    const original = repl.client.config.stream;

    await repl._handleSettings(["stream", "maybe"]);

    assert.equal(repl.client.config.stream, original);
  });

  it("history restore reloads the saved workspace, config, trust, sandbox, and message shape", async () => {
    const ws1 = path.join(tempRoot, "history-ws1");
    const ws2 = path.join(tempRoot, "history-ws2");
    await mkdir(path.join(ws1, ".mercury"), { recursive: true });
    await mkdir(path.join(ws2, ".mercury"), { recursive: true });

    const repl = new MercuryRepl({ workspace: ws1, trustMode: "approval" });
    repl.sandbox.init();
    repl.history.dir = path.join(tempRoot, "sessions");
    await repl._reloadWorkspaceState({
      resetConversation: true,
      reloadMcp: false,
      reloadSkills: false,
      announceProjectConfig: false,
    });

    repl.client.config.model = "saved-model";
    repl.trustMode = "dontAsk";
    repl.planMode = false;
    repl.sandbox.setMode("strict");
    repl.sandbox.allowNetwork = false;
    repl.conversation.addUserMessage("saved-message");
    await repl._handleHistory(["save"]);

    repl.workspace = ws2;
    await repl._reloadWorkspaceState({
      resetConversation: true,
      reloadMcp: false,
      reloadSkills: false,
      announceProjectConfig: false,
    });
    repl.client.config.model = "different-model";
    repl.trustMode = "approval";
    repl.sandbox.setMode("on");
    repl.sandbox.allowNetwork = true;

    await repl._handleHistory(["restore", "1"]);

    assert.equal(repl.workspace, ws1);
    assert.equal(repl.client.config.model, "saved-model");
    assert.equal(repl.trustMode, "dontAsk");
    // Clamping: saved "strict"(2) >= current "on"(1), so restores to "strict"
    assert.equal(repl.sandbox.mode, "strict");
    assert.equal(repl.sandbox.allowNetwork, false);
    assert.equal(repl.conversation.messages.length, 1);
    assert.equal(repl.conversation.messages[0].role, "user");
    assert.equal(
      repl.conversation.getMessages().filter((msg) => msg.role === "system").length,
      1
    );
  });

  it("keeps AI safety client credentials in sync with settings updates", async () => {
    const repl = new MercuryRepl({ workspace: tempRoot, trustMode: "aiSafetyDecide", apiKey: "old-key" });
    const originalBase = repl._aiSafetyDecider.client.baseURL;

    await repl._handleSettings(["api_key", "new-key"]);
    await repl._handleSettings(["api_base", "https://example.invalid/v1"]);

    assert.equal(repl._aiSafetyDecider.client.apiKey, "new-key");
    assert.notEqual(repl._aiSafetyDecider.client.baseURL, originalBase);
    assert.equal(repl._aiSafetyDecider.client.baseURL, "https://example.invalid/v1");
  });
});
