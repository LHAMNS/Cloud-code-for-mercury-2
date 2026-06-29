// Tests for src/utils/path-safety.js — workspace boundary checks, git ref validation
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInWorkspace, isValidGitRef, isValidGitHash } from "../src/utils/path-safety.js";

describe("isInWorkspace", () => {
  it("returns true for paths inside workspace", () => {
    assert.ok(isInWorkspace("/workspace/src/file.js", "/workspace"));
    assert.ok(isInWorkspace("/workspace/deep/nested/file.ts", "/workspace"));
  });

  it("returns true for workspace root itself", () => {
    assert.ok(isInWorkspace("/workspace", "/workspace"));
  });

  it("returns false for paths outside workspace", () => {
    assert.ok(!isInWorkspace("/etc/passwd", "/workspace"));
    assert.ok(!isInWorkspace("/home/user/other/file.js", "/workspace"));
  });

  it("returns false for path traversal attempts", () => {
    assert.ok(!isInWorkspace("/workspace/../etc/passwd", "/workspace"));
  });

  it("handles workspace prefix that matches a longer directory name", () => {
    assert.ok(!isInWorkspace("/workspace-other/file.js", "/workspace"));
  });

  it("handles relative paths by resolving them", () => {
    const cwd = process.cwd();
    assert.ok(isInWorkspace("./file.js", cwd));
  });
});

describe("isValidGitRef", () => {
  it("validates hex hashes (7-40 chars)", () => {
    assert.ok(isValidGitRef("abcdef1"));
    assert.ok(isValidGitRef("a".repeat(40)));
    assert.ok(isValidGitRef("1234567890abcdef1234567890abcdef12345678"));
  });

  it("accepts short strings as branch names (not just hashes)", () => {
    assert.ok(isValidGitRef("abc"));
    assert.ok(isValidGitRef("abcde"));
  });

  it("validates branch-like names", () => {
    assert.ok(isValidGitRef("main"));
    assert.ok(isValidGitRef("feature/my-branch"));
    assert.ok(isValidGitRef("refs/heads/main"));
    assert.ok(isValidGitRef("v1.0.0"));
  });

  it("rejects names with ..", () => {
    assert.ok(!isValidGitRef("main..branch"));
  });

  it("rejects names ending with .lock", () => {
    assert.ok(!isValidGitRef("branch.lock"));
  });

  it("validates special refs", () => {
    assert.ok(isValidGitRef("HEAD"));
    assert.ok(isValidGitRef("FETCH_HEAD"));
    assert.ok(isValidGitRef("ORIG_HEAD"));
    assert.ok(isValidGitRef("MERGE_HEAD"));
    assert.ok(isValidGitRef("CHERRY_PICK_HEAD"));
  });

  it("rejects null/undefined/empty", () => {
    assert.ok(!isValidGitRef(null));
    assert.ok(!isValidGitRef(undefined));
    assert.ok(!isValidGitRef(""));
  });

  it("rejects non-string types", () => {
    assert.ok(!isValidGitRef(12345));
  });
});

describe("isValidGitHash", () => {
  it("validates proper hex hashes", () => {
    assert.ok(isValidGitHash("abcdef1"));
    assert.ok(isValidGitHash("a".repeat(40)));
    assert.ok(isValidGitHash("1234567"));
  });

  it("rejects too-short strings", () => {
    assert.ok(!isValidGitHash("abc"));
    assert.ok(!isValidGitHash("a"));
  });

  it("rejects too-long strings", () => {
    assert.ok(!isValidGitHash("a".repeat(41)));
  });

  it("rejects non-hex characters", () => {
    assert.ok(!isValidGitHash("ghijklm"));
    assert.ok(!isValidGitHash("main"));
    assert.ok(!isValidGitHash("HEAD"));
  });

  it("rejects null/undefined/empty", () => {
    assert.ok(!isValidGitHash(null));
    assert.ok(!isValidGitHash(undefined));
    assert.ok(!isValidGitHash(""));
  });
});
