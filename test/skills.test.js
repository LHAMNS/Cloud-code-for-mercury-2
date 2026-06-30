// Tests for src/skills.js — Skill class, frontmatter parsing, SkillManager
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Skill, SkillManager } from "../src/skills.js";

describe("Skill constructor", () => {
  it("sets all fields from options", () => {
    const skill = new Skill({
      name: "test-skill",
      description: "A test skill",
      prompt: "Do the thing",
      argumentHint: "what to do",
      userInvocable: true,
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["Write"],
      model: "gpt-4o",
      context: "fork",
      agent: "coder",
      disableModelInvocation: true,
      source: "/path/to/skill.md",
      isProjectLevel: true,
    });

    assert.equal(skill.name, "test-skill");
    assert.equal(skill.description, "A test skill");
    assert.equal(skill.prompt, "Do the thing");
    assert.equal(skill.argumentHint, "what to do");
    assert.equal(skill.userInvocable, true);
    assert.deepEqual(skill.allowedTools, ["Bash", "Read"]);
    assert.deepEqual(skill.disallowedTools, ["Write"]);
    assert.equal(skill.model, "gpt-4o");
    assert.equal(skill.context, "fork");
    assert.equal(skill.agent, "coder");
    assert.equal(skill.disableModelInvocation, true);
    assert.equal(skill.source, "/path/to/skill.md");
    assert.equal(skill.isProjectLevel, true);
  });

  it("uses safe defaults for missing options", () => {
    const skill = new Skill({ name: "minimal" });
    assert.equal(skill.description, "");
    assert.equal(skill.prompt, "");
    assert.equal(skill.argumentHint, "");
    assert.equal(skill.userInvocable, true);
    assert.equal(skill.allowedTools, null);
    assert.equal(skill.disallowedTools, null);
    assert.equal(skill.model, null);
    assert.equal(skill.context, null);
    assert.equal(skill.agent, null);
    assert.equal(skill.disableModelInvocation, false);
    assert.equal(skill.isProjectLevel, false);
  });
});

describe("Skill.render", () => {
  it("replaces {{argument}} with provided argument", () => {
    const skill = new Skill({ name: "test", prompt: "Create a {{argument}} file" });
    assert.equal(skill.render("README"), "Create a README file");
  });

  it("replaces $ARGUMENTS with provided argument", () => {
    const skill = new Skill({ name: "test", prompt: "Run: $ARGUMENTS" });
    assert.equal(skill.render("npm test"), "Run: npm test");
  });

  it("replaces multiple occurrences", () => {
    const skill = new Skill({ name: "test", prompt: "{{argument}} and {{argument}}" });
    assert.equal(skill.render("hello"), "hello and hello");
  });

  it("replaces with empty string when no argument provided", () => {
    const skill = new Skill({ name: "test", prompt: "Do {{argument}} now" });
    assert.equal(skill.render(), "Do  now");
  });

  it("is case insensitive for {{argument}}", () => {
    const skill = new Skill({ name: "test", prompt: "{{Argument}} and {{ARGUMENT}}" });
    assert.equal(skill.render("val"), "val and val");
  });
});

describe("SkillManager", () => {
  it("starts empty and not loaded", () => {
    const mgr = new SkillManager();
    assert.equal(mgr.count, 0);
    assert.equal(mgr.isLoaded, false);
    assert.equal(mgr.has("anything"), false);
    assert.equal(mgr.get("anything"), null);
  });

  it("getAll returns empty array when no skills", () => {
    const mgr = new SkillManager();
    assert.deepEqual(mgr.getAll(), []);
  });

  it("getUserInvocable returns empty array when no skills", () => {
    const mgr = new SkillManager();
    assert.deepEqual(mgr.getUserInvocable(), []);
  });

  it("getCompletions returns empty array when no skills", () => {
    const mgr = new SkillManager();
    assert.deepEqual(mgr.getCompletions(), []);
  });

  it("getToolDefinition returns null when no model-invocable skills", () => {
    const mgr = new SkillManager();
    assert.equal(mgr.getToolDefinition(), null);
  });

  it("formatList shows 'No skills found' when empty", () => {
    const mgr = new SkillManager();
    assert.ok(mgr.formatList().includes("No skills found"));
  });

  it("_parseSkillFile parses frontmatter and body", () => {
    const mgr = new SkillManager();
    const content = `---
name: commit
description: Create a git commit
argument-hint: commit message
user-invocable: true
allowed-tools: Bash, Read, Grep
model: mercury-2
---
Write a clear commit message for the staged changes.
Use {{argument}} if provided.`;

    const skill = mgr._parseSkillFile(content, "/fake/commit.md");
    assert.ok(skill);
    assert.equal(skill.name, "commit");
    assert.equal(skill.description, "Create a git commit");
    assert.equal(skill.argumentHint, "commit message");
    assert.equal(skill.userInvocable, true);
    assert.deepEqual(skill.allowedTools, ["Bash", "Read", "Grep"]);
    assert.equal(skill.model, "mercury-2");
    assert.ok(skill.prompt.includes("clear commit message"));
    assert.ok(skill.prompt.includes("{{argument}}"));
  });

  it("_parseSkillFile falls back to filename for name", () => {
    const mgr = new SkillManager();
    const content = `---
description: No name field here
---
Some prompt body.`;

    const skill = mgr._parseSkillFile(content, "/fake/my-skill.md");
    assert.ok(skill);
    assert.equal(skill.name, "my-skill");
  });

  it("_parseSkillFile handles content without frontmatter", () => {
    const mgr = new SkillManager();
    const content = "Just a prompt body with no frontmatter.";
    const skill = mgr._parseSkillFile(content, "/fake/plain.md");
    assert.ok(skill);
    assert.equal(skill.name, "plain");
    assert.equal(skill.prompt, content);
  });

  it("_parseSkillFile handles boolean false for user-invocable", () => {
    const mgr = new SkillManager();
    const content = `---
name: internal
user-invocable: false
disable-model-invocation: true
---
Internal prompt.`;

    const skill = mgr._parseSkillFile(content, "/fake/internal.md");
    assert.ok(skill);
    assert.equal(skill.userInvocable, false);
    assert.equal(skill.disableModelInvocation, true);
  });

  it("_parseSkillFile strips quotes from values", () => {
    const mgr = new SkillManager();
    const content = `---
name: "quoted-skill"
description: 'single quoted description'
---
Body.`;

    const skill = mgr._parseSkillFile(content, "/fake/quoted.md");
    assert.equal(skill.name, "quoted-skill");
    assert.equal(skill.description, "single quoted description");
  });
});
