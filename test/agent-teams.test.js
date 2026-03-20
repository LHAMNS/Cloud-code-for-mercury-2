// Tests for src/agent-teams.js — AgentTeam class
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AgentTeam } from "../src/agent-teams.js";

describe("AgentTeam", () => {
  let team;

  beforeEach(() => {
    team = new AgentTeam({
      teamName: "test-team",
      workspace: "/tmp/test-workspace",
    });
  });

  describe("task management", () => {
    it("adds tasks with correct initial state", () => {
      const task = team.addTask({ title: "Test task", detail: "Do something" });
      assert.equal(task.status, "pending");
      assert.equal(task.assignee, null);
      assert.equal(task.result, null);
      assert.ok(task.id.startsWith("task-"));
    });

    it("generates sequential task IDs", () => {
      const t1 = team.addTask({ title: "Task 1", detail: "" });
      const t2 = team.addTask({ title: "Task 2", detail: "" });
      assert.equal(t1.id, "task-1");
      assert.equal(t2.id, "task-2");
    });

    it("getNextTask returns unblocked pending task", () => {
      team.addTask({ title: "Task 1", detail: "" });
      const next = team.getNextTask();
      assert.ok(next);
      assert.equal(next.title, "Task 1");
    });

    it("getNextTask respects dependencies", () => {
      const t1 = team.addTask({ title: "Task 1", detail: "" });
      team.addTask({ title: "Task 2", detail: "", depends: [t1.id] });
      const next = team.getNextTask();
      assert.equal(next.title, "Task 1"); // Task 2 blocked
    });

    it("dependent task becomes available after dependency completes", async () => {
      const t1 = team.addTask({ title: "Task 1", detail: "" });
      const t2 = team.addTask({ title: "Task 2", detail: "", depends: [t1.id] });

      team.claimTask(t1.id, "mate-1");
      await team.completeTask(t1.id, "done");

      const next = team.getNextTask();
      assert.equal(next.id, t2.id);
    });

    it("claimTask changes status to in_progress", () => {
      const t1 = team.addTask({ title: "Task 1", detail: "" });
      const claimed = team.claimTask(t1.id, "mate-1");
      assert.equal(claimed, true);
      assert.equal(team.tasks.get(t1.id).status, "in_progress");
      assert.equal(team.tasks.get(t1.id).assignee, "mate-1");
    });

    it("claimTask fails for non-pending task", () => {
      const t1 = team.addTask({ title: "Task 1", detail: "" });
      team.claimTask(t1.id, "mate-1");
      const secondClaim = team.claimTask(t1.id, "mate-2");
      assert.equal(secondClaim, false);
    });

    it("completeTask sets result and timestamp", () => {
      const t1 = team.addTask({ title: "Task 1", detail: "" });
      team.claimTask(t1.id, "mate-1");
      team.completeTask(t1.id, "Result here");

      const task = team.tasks.get(t1.id);
      assert.equal(task.status, "completed");
      assert.equal(task.result, "Result here");
      assert.ok(task.completedAt);
    });

    it("getTaskSummary categorizes tasks correctly", () => {
      team.addTask({ title: "T1", detail: "" });
      const t2 = team.addTask({ title: "T2", detail: "" });
      const t3 = team.addTask({ title: "T3", detail: "" });

      team.claimTask(t2.id, "mate-1");
      team.claimTask(t3.id, "mate-2");
      team.completeTask(t3.id, "done");

      const summary = team.getTaskSummary();
      assert.equal(summary.pending.length, 1);
      assert.equal(summary.inProgress.length, 1);
      assert.equal(summary.completed.length, 1);
      assert.equal(summary.total, 3);
    });
  });

  describe("mailbox", () => {
    it("sends direct messages", () => {
      team.sendMessage("lead", "mate-1", "Hello");
      assert.equal(team.mailbox.length, 1);
      assert.equal(team.mailbox[0].from, "lead");
      assert.equal(team.mailbox[0].to, "mate-1");
      assert.equal(team.mailbox[0].content, "Hello");
    });

    it("getMessages filters by recipient", () => {
      team.sendMessage("lead", "mate-1", "Hello 1");
      team.sendMessage("lead", "mate-2", "Hello 2");

      const msgs = team.getMessages("mate-1");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].content, "Hello 1");
    });

    it("getMessages includes broadcast messages", () => {
      team.sendMessage("lead", "all", "Broadcast");
      team.sendMessage("lead", "mate-1", "Direct");

      const msgs = team.getMessages("mate-1");
      assert.equal(msgs.length, 2);
    });
  });

  describe("team lifecycle", () => {
    it("stop() sets _running to false", () => {
      team._running = true;
      team.stop();
      assert.equal(team._running, false);
    });
  });
});
