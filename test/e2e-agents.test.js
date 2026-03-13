// End-to-end tests for SubAgent and AgentTeam — communication, logic, lifecycle
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Set dummy API key so SubAgent/MercuryClient can be constructed without error.
// Tests only verify construction, logic, and communication — no actual API calls.
process.env.INCEPTION_API_KEY = process.env.INCEPTION_API_KEY || "test-key-for-unit-tests";

import { SubAgent, runSubAgentTeam, getBackgroundAgent, listBackgroundAgents } from "../src/subagent.js";
import { AgentTeam, executeAgentTeams, getTeam, listTeams } from "../src/agent-teams.js";
import { resolveAgentTools, discoverAgents, matchAgentForTask, formatAgentList, scaffoldAgent } from "../src/agent-definitions.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const WORKSPACE = process.cwd();

// ═══════════════════════════════════════════════════════════════
// 1. SubAgent 工具参数完整性
// ═══════════════════════════════════════════════════════════════

describe("SubAgent tool parameters", () => {
  const subagent = TOOL_DEFINITIONS.find((t) => t.function.name === "SubAgent");
  const props = subagent.function.parameters.properties;

  it("has all 8 expected parameters", () => {
    const expected = ["description", "task", "agent_type", "resume", "run_in_background", "isolation", "model", "max_turns"];
    for (const p of expected) {
      assert.ok(props[p], `Missing SubAgent parameter: ${p}`);
    }
  });

  it("description is type string", () => {
    assert.equal(props.description.type, "string");
  });

  it("model is type string", () => {
    assert.equal(props.model.type, "string");
  });

  it("max_turns is type number", () => {
    assert.equal(props.max_turns.type, "number");
  });

  it("isolation has worktree enum", () => {
    assert.deepEqual(props.isolation.enum, ["worktree"]);
  });

  it("task is the only required parameter", () => {
    assert.deepEqual(subagent.function.parameters.required, ["task"]);
  });
});

describe("SubAgent transcript hardening", () => {
  it("ignores persisted worktree paths outside the expected workspace location", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-subagent-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-outside-"));

    try {
      const agentId = "agent-secure";
      const agentDir = path.join(workspace, ".mercury", "agents", agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "transcript.json"), JSON.stringify({
        messages: [],
        turnCount: 0,
        worktree: {
          path: outside,
          branch: "evil-branch",
        },
      }), "utf-8");

      const agent = new SubAgent({ task: "test", workspace, agentId });
      const loaded = await agent._loadTranscript();

      assert.equal(loaded, true);
      assert.equal(agent._effectiveWorkspace, workspace);
      assert.equal(agent._worktreePath, null);
      assert.equal(agent._worktreeBranch, null);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. SubAgentTeam per-task model
// ═══════════════════════════════════════════════════════════════

describe("SubAgentTeam tool parameters", () => {
  const team = TOOL_DEFINITIONS.find((t) => t.function.name === "SubAgentTeam");
  const taskProps = team.function.parameters.properties.tasks.items.properties;

  it("supports per-task model override", () => {
    assert.ok(taskProps.model, "Missing per-task model parameter");
    assert.equal(taskProps.model.type, "string");
  });

  it("has maxItems 5", () => {
    assert.equal(team.function.parameters.properties.tasks.maxItems, 5);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. SubAgent 实例化和属性验证
// ═══════════════════════════════════════════════════════════════

describe("SubAgent instantiation", () => {
  it("creates agent with default properties", () => {
    const agent = new SubAgent({ task: "test", workspace: WORKSPACE });
    assert.ok(agent.agentId.startsWith("agent-"));
    assert.equal(agent.task, "test");
    assert.equal(agent.trustMode, "approval"); // default
    assert.equal(agent._turnCount, 0);
    assert.ok(Array.isArray(agent.messages));
    assert.equal(agent.messages.length, 0);
    assert.equal(agent.toolExecutor, null, "toolExecutor is lazily initialized");
    assert.ok(agent.log);
    assert.ok(agent.memory);
    assert.ok(agent.rollback);
  });

  it("applies model override from agentDef", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      agentDef: { model: "mercury-2-turbo", tools: null, disallowedTools: [] },
    });
    assert.equal(agent._modelOverride, "mercury-2-turbo");
  });

  it("applies maxTurns from constructor option", () => {
    const agent = new SubAgent({ task: "test", workspace: WORKSPACE, maxTurns: 10 });
    assert.equal(agent._maxTurnsOverride, 10);
  });

  it("sets background mode", () => {
    const agent = new SubAgent({ task: "test", workspace: WORKSPACE, runInBackground: true });
    assert.equal(agent._runInBackground, true);
  });

  it("sets isolation mode", () => {
    const agent = new SubAgent({ task: "test", workspace: WORKSPACE, isolation: "worktree" });
    assert.equal(agent._isolation, "worktree");
  });

  it("sets resume mode and preserves agentId", () => {
    const agent = new SubAgent({ task: "continue", workspace: WORKSPACE, resume: "agent-abc123" });
    assert.equal(agent.agentId, "agent-abc123");
    assert.equal(agent._isResume, true);
  });

  it("inherits trustMode from options", () => {
    const agent = new SubAgent({ task: "test", workspace: WORKSPACE, trustMode: "open" });
    assert.equal(agent.trustMode, "open");
  });

  it("applies permissionMode from agentDef over trustMode", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      trustMode: "open",
      agentDef: { permissionMode: "readonly", tools: null, disallowedTools: [] },
    });
    assert.equal(agent.trustMode, "readonly");
  });

  it("onProgress callback is set", () => {
    let called = false;
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      onProgress: () => { called = true; },
    });
    agent._emit("test", "data");
    assert.equal(called, true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Agent 定义和自动匹配
// ═══════════════════════════════════════════════════════════════

describe("Agent definitions and matching", () => {
  let agents;

  beforeEach(async () => {
    agents = await discoverAgents(WORKSPACE);
  });

  it("discovers all 3 builtin agents", () => {
    assert.ok(agents.has("explore"));
    assert.ok(agents.has("plan"));
    assert.ok(agents.has("general-purpose"));
    assert.ok(agents.size >= 3);
  });

  it("explore agent has correct tools", () => {
    const explore = agents.get("explore");
    assert.deepEqual(explore.tools, ["Read", "Glob", "Grep", "ListDir", "Diff", "Fetch", "AstSearch", "Lsp"]);
    assert.equal(explore.maxTurns, 20);
    assert.equal(explore.builtin, true);
  });

  it("plan agent has correct tools", () => {
    const plan = agents.get("plan");
    assert.deepEqual(plan.tools, ["Read", "Glob", "Grep", "ListDir", "Diff", "AstSearch", "Lsp"]);
    assert.equal(plan.maxTurns, 25);
  });

  it("general-purpose has null tools (= all)", () => {
    const gp = agents.get("general-purpose");
    assert.equal(gp.tools, null);
    assert.equal(gp.maxTurns, 30);
  });

  it("matches explore for search/find tasks", () => {
    assert.equal(matchAgentForTask(agents, "search the codebase for auth functions").name, "explore");
    assert.equal(matchAgentForTask(agents, "find all files matching *.ts").name, "explore");
    assert.equal(matchAgentForTask(agents, "locate the config module").name, "explore");
    assert.equal(matchAgentForTask(agents, "grep for TODO comments").name, "explore");
  });

  it("matches plan for design tasks", () => {
    assert.equal(matchAgentForTask(agents, "plan the architecture for new API").name, "plan");
    assert.equal(matchAgentForTask(agents, "design the database schema").name, "plan");
  });

  it("defaults to general-purpose for unmatched", () => {
    assert.equal(matchAgentForTask(agents, "refactor the user module").name, "general-purpose");
    assert.equal(matchAgentForTask(agents, "fix the login bug").name, "general-purpose");
  });

  it("formatAgentList includes all agents", () => {
    const output = formatAgentList(agents);
    assert.ok(output.includes("explore"));
    assert.ok(output.includes("plan"));
    assert.ok(output.includes("general-purpose"));
    assert.ok(output.includes("Built-in:"));
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 工具解析：权限/信任模式下的工具集
// ═══════════════════════════════════════════════════════════════

describe("Tool resolution by trust mode", () => {
  it("explore agent tools in open mode", () => {
    const tools = resolveAgentTools(
      { tools: ["Read", "Glob", "Grep", "ListDir", "Diff", "Fetch", "AstSearch", "Lsp"], disallowedTools: [] },
      "open"
    );
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes("Read"));
    assert.ok(names.includes("Glob"));
    assert.ok(!names.includes("SubAgent"), "SubAgent should be blocked");
    assert.ok(!names.includes("SubAgentTeam"), "SubAgentTeam should be blocked");
    assert.ok(!names.includes("ContextSearch"), "ContextSearch should be blocked");
  });

  it("readonly mode restricts to read-only tools", () => {
    const tools = resolveAgentTools({ tools: null, disallowedTools: [] }, "readonly");
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes("Read"));
    assert.ok(names.includes("Glob"));
    assert.ok(names.includes("Grep"));
    assert.ok(!names.includes("Write"), "Write should be blocked in readonly");
    assert.ok(!names.includes("Edit"), "Edit should be blocked in readonly");
    assert.ok(!names.includes("Bash"), "Bash should be blocked in readonly");
  });

  it("denylist removes specific tools", () => {
    const tools = resolveAgentTools({ tools: null, disallowedTools: ["Bash", "Write"] }, "open");
    const names = tools.map((t) => t.function.name);
    assert.ok(!names.includes("Bash"));
    assert.ok(!names.includes("Write"));
    assert.ok(names.includes("Read"));
  });

  it("recursion blockers always removed", () => {
    const tools = resolveAgentTools({ tools: null, disallowedTools: [] }, "open");
    const names = tools.map((t) => t.function.name);
    assert.ok(!names.includes("SubAgent"));
    assert.ok(!names.includes("SubAgentTeam"));
    assert.ok(!names.includes("ContextSearch"));
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. AgentTeam 任务依赖和阻塞逻辑
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam task dependencies", () => {
  let team;

  beforeEach(() => {
    team = new AgentTeam({ teamName: "dep-test", workspace: WORKSPACE });
  });

  it("blocks tasks with unfulfilled dependencies", () => {
    const t1 = team.addTask({ title: "Step 1", detail: "First" });
    const t2 = team.addTask({ title: "Step 2", detail: "Second", depends: [t1.id] });
    const t3 = team.addTask({ title: "Step 3", detail: "Third", depends: [t1.id, t2.id] });

    // t1 is available, t2 and t3 are blocked
    const next1 = team.getNextTask();
    assert.equal(next1.id, t1.id);

    // Claim and skip t1
    team.claimTask(t1.id, "worker");
    const next2 = team.getNextTask();
    assert.equal(next2, null, "No tasks should be available when t1 is in progress");
  });

  it("unblocks after dependency completes", async () => {
    const t1 = team.addTask({ title: "Step 1", detail: "First" });
    const t2 = team.addTask({ title: "Step 2", detail: "Second", depends: [t1.id] });

    team.claimTask(t1.id, "worker");
    await team.completeTask(t1.id, "Done");

    const next = team.getNextTask();
    assert.equal(next.id, t2.id, "t2 should be available after t1 completes");
  });

  it("blocks if dependency completed with error", async () => {
    const t1 = team.addTask({ title: "Step 1", detail: "First" });
    const t2 = team.addTask({ title: "Step 2", detail: "Second", depends: [t1.id] });

    team.claimTask(t1.id, "worker");
    await team.completeTask(t1.id, "Error occurred", true); // isError = true

    const next = team.getNextTask();
    assert.equal(next, null, "t2 should still be blocked when t1 errored");
  });

  it("handles multi-level dependency chains", async () => {
    const t1 = team.addTask({ title: "Build", detail: "Build code" });
    const t2 = team.addTask({ title: "Test", detail: "Run tests", depends: [t1.id] });
    const t3 = team.addTask({ title: "Deploy", detail: "Deploy to staging", depends: [t2.id] });

    // Only t1 available
    assert.equal(team.getNextTask().id, t1.id);

    team.claimTask(t1.id, "w1");
    await team.completeTask(t1.id, "Built");

    // Now t2 available but not t3
    assert.equal(team.getNextTask().id, t2.id);

    team.claimTask(t2.id, "w2");
    await team.completeTask(t2.id, "Tests passed");

    // Now t3 available
    assert.equal(team.getNextTask().id, t3.id);
  });

  it("parallel independent tasks all available", () => {
    team.addTask({ title: "A", detail: "Independent A" });
    team.addTask({ title: "B", detail: "Independent B" });
    team.addTask({ title: "C", detail: "Independent C" });

    // All three should be gettable one by one
    const got = [];
    let next;
    while ((next = team.getNextTask())) {
      got.push(next.id);
      team.claimTask(next.id, `w-${got.length}`);
    }
    assert.equal(got.length, 3, "All 3 independent tasks should be claimable");
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. AgentTeam 通讯系统
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam messaging system", () => {
  let team;

  beforeEach(() => {
    team = new AgentTeam({ teamName: "msg-test", workspace: WORKSPACE });
  });

  it("direct messages delivered to correct recipient", () => {
    team.sendMessage("lead", "mate-1", "Hello mate-1");
    team.sendMessage("lead", "mate-2", "Hello mate-2");
    team.sendMessage("mate-1", "mate-2", "Hi from mate-1");

    const m1msgs = team.getMessages("mate-1");
    assert.equal(m1msgs.length, 1);
    assert.equal(m1msgs[0].content, "Hello mate-1");

    const m2msgs = team.getMessages("mate-2");
    assert.equal(m2msgs.length, 2);
  });

  it("broadcast reaches all recipients", () => {
    team.broadcast("lead", "Attention everyone!");

    const m1msgs = team.getMessages("mate-1");
    const m2msgs = team.getMessages("mate-2");
    const m3msgs = team.getMessages("mate-3");

    assert.equal(m1msgs.length, 1);
    assert.equal(m2msgs.length, 1);
    assert.equal(m3msgs.length, 1);
    assert.equal(m1msgs[0].content, "Attention everyone!");
  });

  it("since filter works correctly", async () => {
    team.sendMessage("lead", "mate-1", "Old message");
    const cutoff = Date.now();
    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 5));
    team.sendMessage("lead", "mate-1", "New message");

    const newOnly = team.getMessages("mate-1", cutoff);
    assert.equal(newOnly.length, 1);
    assert.equal(newOnly[0].content, "New message");
  });

  it("mixed DM and broadcast ordering preserved", () => {
    team.sendMessage("lead", "mate-1", "DM 1");
    team.broadcast("lead", "Broadcast 1");
    team.sendMessage("lead", "mate-1", "DM 2");

    const msgs = team.getMessages("mate-1");
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].content, "DM 1");
    assert.equal(msgs[1].content, "Broadcast 1");
    assert.equal(msgs[2].content, "DM 2");
  });

  it("messages have correct sender info", () => {
    team.sendMessage("mate-1", "mate-2", "From mate-1");
    const msgs = team.getMessages("mate-2");
    assert.equal(msgs[0].from, "mate-1");
    assert.equal(msgs[0].to, "mate-2");
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. AgentTeam 队友管理
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam teammate management", () => {
  let team;

  beforeEach(() => {
    team = new AgentTeam({ teamName: "mate-test", workspace: WORKSPACE });
  });

  it("spawns teammates with unique IDs", () => {
    const m1 = team.spawnTeammate({ name: "Alpha" });
    const m2 = team.spawnTeammate({ name: "Beta" });
    assert.notEqual(m1.id, m2.id);
    assert.equal(m1.name, "Alpha");
    assert.equal(m2.name, "Beta");
    assert.equal(m1.status, "idle");
    assert.equal(team.teammates.size, 2);
  });

  it("shutdown removes teammate", () => {
    const m1 = team.spawnTeammate({ name: "Worker" });
    assert.equal(team.teammates.size, 1);
    team.shutdownTeammate(m1.id);
    assert.equal(team.teammates.size, 0);
  });

  it("teammate has SubAgent instance", () => {
    const m1 = team.spawnTeammate({ name: "Worker" });
    assert.ok(m1.agent instanceof SubAgent);
    assert.equal(m1.agent.workspace, WORKSPACE);
  });

  it("teammate inherits agent options", () => {
    const team2 = new AgentTeam({
      teamName: "opts-test",
      workspace: WORKSPACE,
      agentOptions: { trustMode: "open" },
    });
    const m1 = team2.spawnTeammate({ name: "Worker" });
    assert.equal(m1.agent.trustMode, "open");
  });

  it("auto-names teammates when no name given", () => {
    const m1 = team.spawnTeammate({});
    assert.ok(m1.name.startsWith("Teammate"));
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. AgentTeam 上下文构建 (teammate context)
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam teammate context building", () => {
  it("includes task title and detail in context", () => {
    const team = new AgentTeam({ teamName: "ctx-test", workspace: WORKSPACE });
    const mate = team.spawnTeammate({ name: "Worker" });
    const task = team.addTask({ title: "Analyze code", detail: "Read all JS files in src/" });

    const ctx = team._buildTeammateContext(mate.id, task);
    assert.ok(ctx.includes("Analyze code"), "Context should include task title");
    assert.ok(ctx.includes("Read all JS files in src/"), "Context should include task detail");
  });

  it("includes dependency results in context", async () => {
    const team = new AgentTeam({ teamName: "ctx-deps-test", workspace: WORKSPACE });
    const mate = team.spawnTeammate({ name: "Worker" });

    const t1 = team.addTask({ title: "Research", detail: "Find patterns" });
    const t2 = team.addTask({ title: "Implement", detail: "Build feature", depends: [t1.id] });

    team.claimTask(t1.id, mate.id);
    await team.completeTask(t1.id, "Found 5 relevant patterns in auth module");

    const ctx = team._buildTeammateContext(mate.id, t2);
    assert.ok(ctx.includes("Results from prerequisite tasks"), "Should include dependency section");
    assert.ok(ctx.includes("Research"), "Should include dependency title");
    assert.ok(ctx.includes("Found 5 relevant patterns"), "Should include dependency result");
  });

  it("includes recent messages in context", () => {
    const team = new AgentTeam({ teamName: "ctx-msgs-test", workspace: WORKSPACE });
    const mate = team.spawnTeammate({ name: "Worker" });
    const task = team.addTask({ title: "Task", detail: "Do work" });

    team.sendMessage("lead", mate.id, "Focus on the auth module");
    team.broadcast("lead", "Deadline is approaching");

    const ctx = team._buildTeammateContext(mate.id, task);
    assert.ok(ctx.includes("Messages from team"), "Should include messages section");
    assert.ok(ctx.includes("Focus on the auth module"), "Should include DM content");
    assert.ok(ctx.includes("Deadline is approaching"), "Should include broadcast content");
  });

  it("identifies teammate by name", () => {
    const team = new AgentTeam({ teamName: "ctx-name-test", workspace: WORKSPACE });
    const mate = team.spawnTeammate({ name: "Analyzer" });
    const task = team.addTask({ title: "Task", detail: "Do work" });

    const ctx = team._buildTeammateContext(mate.id, task);
    assert.ok(ctx.includes("Analyzer"), "Should include teammate name");
    assert.ok(ctx.includes("ctx-name-test"), "Should include team name");
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. AgentTeam 任务摘要
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam task summary", () => {
  it("categorizes tasks correctly", async () => {
    const team = new AgentTeam({ teamName: "summary-test", workspace: WORKSPACE });

    team.addTask({ title: "A", detail: "a" });
    team.addTask({ title: "B", detail: "b" });
    const t3 = team.addTask({ title: "C", detail: "c" });

    team.claimTask(t3.id, "w1");

    const s1 = team.getTaskSummary();
    assert.equal(s1.total, 3);
    assert.equal(s1.pending.length, 2);
    assert.equal(s1.inProgress.length, 1);
    assert.equal(s1.completed.length, 0);

    await team.completeTask(t3.id, "Done");
    const s2 = team.getTaskSummary();
    assert.equal(s2.completed.length, 1);
    assert.equal(s2.inProgress.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. executeAgentTeams 工具处理器
// ═══════════════════════════════════════════════════════════════

describe("executeAgentTeams handler", () => {
  it("create → add_task → status → shutdown lifecycle", async () => {
    try { await executeAgentTeams({ action: "shutdown", teamName: "handler-test" }); } catch {}
    const opts = { workspace: WORKSPACE };

    // Create
    const r1 = await executeAgentTeams({ action: "create", team_name: "handler-test" }, opts);
    assert.ok(r1.includes("handler-test"));
    assert.ok(r1.includes("created"));

    // Add tasks
    const r2 = await executeAgentTeams({ action: "add_task", team_name: "handler-test", title: "Task A", detail: "Do A" }, opts);
    assert.ok(r2.includes("task-1"));

    const r3 = await executeAgentTeams({ action: "add_task", team_name: "handler-test", title: "Task B", depends: ["task-1"] }, opts);
    assert.ok(r3.includes("task-2"));

    // Spawn teammate
    const r4 = await executeAgentTeams({ action: "spawn_teammate", team_name: "handler-test", name: "Agent Alpha" }, opts);
    assert.ok(r4.includes("Agent Alpha"));
    assert.ok(r4.includes("spawned"));

    // Status
    const r5 = await executeAgentTeams({ action: "status", team_name: "handler-test" }, opts);
    assert.ok(r5.includes("handler-test"));
    assert.ok(r5.includes("2 total"));
    assert.ok(r5.includes("Agent Alpha"));

    // Message
    const r6 = await executeAgentTeams({ action: "message", team_name: "handler-test", to: "mate-1", content: "Hello" }, opts);
    assert.ok(r6.includes("sent"));

    // Broadcast
    const r7 = await executeAgentTeams({ action: "broadcast", team_name: "handler-test", content: "Hi all" }, opts);
    assert.ok(r7.includes("Broadcast sent"));

    // Shutdown
    const r8 = await executeAgentTeams({ action: "shutdown", team_name: "handler-test" }, opts);
    assert.ok(r8.includes("shut down"));
  });

  it("returns error for missing action", async () => {
    const r = await executeAgentTeams({}, {});
    assert.ok(r.includes("Error"));
    assert.ok(r.includes("action is required"));
  });

  it("returns error for unknown action", async () => {
    const r = await executeAgentTeams({ action: "invalid", team_name: "x" }, {});
    assert.ok(r.includes("Error"));
    assert.ok(r.includes("Unknown action"));
  });

  it("returns error for nonexistent team", async () => {
    const r = await executeAgentTeams({ action: "status", team_name: "nonexistent" }, {});
    assert.ok(r.includes("Error"));
    assert.ok(r.includes("not found"));
  });

  it("prevents duplicate team names", async () => {
    await executeAgentTeams({ action: "create", team_name: "dup-test" }, { workspace: WORKSPACE });
    const r = await executeAgentTeams({ action: "create", team_name: "dup-test" }, { workspace: WORKSPACE });
    assert.ok(r.includes("Error"));
    assert.ok(r.includes("already exists"));
    // Cleanup
    await executeAgentTeams({ action: "shutdown", team_name: "dup-test" }, {});
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. 后台代理追踪和团队列表
// ═══════════════════════════════════════════════════════════════

describe("Background agent tracking", () => {
  it("getBackgroundAgent returns null for unknown ID", () => {
    assert.equal(getBackgroundAgent("nonexistent"), null);
  });

  it("listBackgroundAgents returns array", () => {
    const list = listBackgroundAgents();
    assert.ok(Array.isArray(list));
  });
});

describe("Team listing", () => {
  it("listTeams returns array of team names", () => {
    const list = listTeams();
    assert.ok(Array.isArray(list));
  });

  it("getTeam returns null for unknown name", () => {
    assert.equal(getTeam("nonexistent"), null);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. AgentTeam 事件回调
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam event callbacks", () => {
  it("fires events for task lifecycle", async () => {
    const events = [];
    const team = new AgentTeam({
      teamName: "event-test",
      workspace: WORKSPACE,
      onEvent: (event, detail) => events.push({ event, detail }),
    });

    team.addTask({ title: "Test", detail: "Test task" });
    assert.ok(events.some((e) => e.event === "task_added"));

    team.claimTask("task-1", "worker");
    assert.ok(events.some((e) => e.event === "task_claimed"));

    await team.completeTask("task-1", "Done");
    assert.ok(events.some((e) => e.event === "task_completed"));
  });

  it("fires events for teammate lifecycle", () => {
    const events = [];
    const team = new AgentTeam({
      teamName: "mate-event-test",
      workspace: WORKSPACE,
      onEvent: (event, detail) => events.push({ event, detail }),
    });

    const mate = team.spawnTeammate({ name: "Worker" });
    assert.ok(events.some((e) => e.event === "teammate_spawned"));

    team.shutdownTeammate(mate.id);
    assert.ok(events.some((e) => e.event === "teammate_shutdown"));
  });

  it("fires events for messages", () => {
    const events = [];
    const team = new AgentTeam({
      teamName: "msg-event-test",
      workspace: WORKSPACE,
      onEvent: (event, detail) => events.push({ event, detail }),
    });

    team.sendMessage("lead", "mate-1", "Hello");
    assert.ok(events.some((e) => e.event === "message_sent" && e.detail.content === "Hello"));

    team.broadcast("lead", "Attention");
    assert.ok(events.some((e) => e.event === "message_sent" && e.detail.to === "all"));
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. SubAgent 进度回调
// ═══════════════════════════════════════════════════════════════

describe("SubAgent progress callbacks", () => {
  it("emits events via onProgress", () => {
    const events = [];
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      onProgress: (event, detail) => events.push({ event, detail }),
    });

    agent._emit("thinking", "Processing...");
    agent._emit("tool_call", "Read → src/index.js");
    agent._emit("done", "Complete");

    assert.equal(events.length, 3);
    assert.equal(events[0].event, "thinking");
    assert.equal(events[1].event, "tool_call");
    assert.equal(events[2].event, "done");
  });

  it("swallows errors in onProgress callback", () => {
    const agent = new SubAgent({
      task: "test",
      workspace: WORKSPACE,
      onProgress: () => { throw new Error("callback error"); },
    });

    // Should not throw
    agent._emit("test", "data");
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. AgentTeam 持久化
// ═══════════════════════════════════════════════════════════════

describe("AgentTeam persistence", () => {
  it("saves and loads team state", async () => {
    const team1 = new AgentTeam({ teamName: "persist-test-e2e", workspace: WORKSPACE });
    team1.addTask({ title: "Task A", detail: "Details A" });
    team1.addTask({ title: "Task B", detail: "Details B" });
    team1.sendMessage("lead", "mate-1", "Test message");

    // _persist() is fire-and-forget from addTask/sendMessage, wait for disk I/O
    await team1._persist();

    // Load into new instance
    const team2 = new AgentTeam({ teamName: "persist-test-e2e", workspace: WORKSPACE });
    const loaded = await team2.load();
    assert.equal(loaded, true);
    assert.equal(team2.tasks.size, 2);
    assert.equal(team2.mailbox.length, 1);
    assert.equal(team2._taskIdCounter, 2);

    // Verify task content survived round-trip
    const taskA = team2.tasks.get("task-1");
    assert.equal(taskA.title, "Task A");
    assert.equal(taskA.detail, "Details A");
    assert.equal(taskA.status, "pending");

    // Verify message content survived round-trip
    assert.equal(team2.mailbox[0].from, "lead");
    assert.equal(team2.mailbox[0].to, "mate-1");
    assert.equal(team2.mailbox[0].content, "Test message");

    // Cleanup
    await team2.cleanup();
  });
});
