// Test: Shared utility modules — path-safety, fence, debug-log
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { isInWorkspace, resolveViaAncestor, isValidGitRef, isValidGitHash } from "../src/utils/path-safety.js";
import { createFenceMarkers, escapeFenceContent } from "../src/utils/fence.js";
import { debugLog, isDebugEnabled } from "../src/utils/debug-log.js";

// ── path-safety: isInWorkspace ──────────────────────────────────────────────

describe("path-safety: isInWorkspace", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc2-ws-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("allows paths within workspace", () => {
    const filePath = path.join(tmpDir, "src", "index.js");
    assert.equal(isInWorkspace(filePath, tmpDir), true,
      "path inside workspace should be allowed");
  });

  it("allows the workspace root itself", () => {
    assert.equal(isInWorkspace(tmpDir, tmpDir), true,
      "workspace root path itself should be allowed");
  });

  it("allows deeply nested paths within workspace", () => {
    const deep = path.join(tmpDir, "a", "b", "c", "d", "e", "file.txt");
    assert.equal(isInWorkspace(deep, tmpDir), true,
      "deeply nested path should be allowed");
  });

  it("blocks paths outside workspace", () => {
    const outside = path.resolve(tmpDir, "..", "outside-file.txt");
    assert.equal(isInWorkspace(outside, tmpDir), false,
      "path outside workspace should be blocked");
  });

  it("blocks absolute paths to system directories", () => {
    // Use a path that is definitely outside any temp workspace
    const sysPath = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";
    assert.equal(isInWorkspace(sysPath, tmpDir), false,
      "system directory path should be blocked");
  });

  it("blocks path traversal with ..", () => {
    const traversal = path.join(tmpDir, "subdir", "..", "..", "escaped.txt");
    assert.equal(isInWorkspace(traversal, tmpDir), false,
      "path traversal with .. should be blocked");
  });

  it("handles non-existent file within workspace", () => {
    const nonExistent = path.join(tmpDir, "does-not-exist", "file.txt");
    assert.equal(isInWorkspace(nonExistent, tmpDir), true,
      "non-existent path within workspace should be allowed");
  });
});

// ── path-safety: resolveViaAncestor ─────────────────────────────────────────

describe("path-safety: resolveViaAncestor", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc2-rva-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves existing path to itself", () => {
    const result = resolveViaAncestor(tmpDir);
    // Should resolve to the real path of the tmpdir
    assert.ok(typeof result === "string", "should return a string");
    assert.ok(path.isAbsolute(result), "should return an absolute path");
  });

  it("resolves non-existent child via existing ancestor", () => {
    const child = path.join(tmpDir, "nonexistent-child", "deep", "file.txt");
    const result = resolveViaAncestor(child);
    assert.ok(result.includes("nonexistent-child") || result.includes("file.txt"),
      "resolved path should include the child segments");
    assert.ok(path.isAbsolute(result), "should return an absolute path");
  });

  it("returns an absolute path for relative input", () => {
    const result = resolveViaAncestor("relative/path/file.txt");
    assert.ok(path.isAbsolute(result), "should resolve relative paths to absolute");
  });
});

// ── path-safety: isValidGitHash ─────────────────────────────────────────────

describe("path-safety: isValidGitHash", () => {
  it("accepts valid 40-char full SHA hash", () => {
    assert.equal(isValidGitHash("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"), true,
      "40-char hex should be valid");
  });

  it("accepts valid 7-char short SHA hash", () => {
    assert.equal(isValidGitHash("a1b2c3d"), true,
      "7-char hex should be valid");
  });

  it("accepts valid 8-char SHA hash", () => {
    assert.equal(isValidGitHash("abcdef12"), true,
      "8-char hex should be valid");
  });

  it("accepts mixed-case hex", () => {
    assert.equal(isValidGitHash("AbCdEf0123456789"), true,
      "mixed-case hex should be valid");
  });

  it("rejects non-hex strings", () => {
    assert.equal(isValidGitHash("not-a-hash"), false,
      "non-hex string should be rejected");
    assert.equal(isValidGitHash("zzzzzzzz"), false,
      "non-hex characters should be rejected");
    assert.equal(isValidGitHash("g1234567"), false,
      "g is not a hex character");
  });

  it("rejects too-short strings (less than 7 chars)", () => {
    assert.equal(isValidGitHash("abcdef"), false,
      "6-char hex should be rejected");
    assert.equal(isValidGitHash("abc"), false,
      "3-char hex should be rejected");
    assert.equal(isValidGitHash(""), false,
      "empty string should be rejected");
  });

  it("rejects too-long strings (more than 40 chars)", () => {
    assert.equal(isValidGitHash("a".repeat(41)), false,
      "41-char hex should be rejected");
  });

  it("rejects null, undefined, and non-string inputs", () => {
    assert.equal(isValidGitHash(null), false, "null should be rejected");
    assert.equal(isValidGitHash(undefined), false, "undefined should be rejected");
    assert.equal(isValidGitHash(12345678), false, "number should be rejected");
  });
});

// ── path-safety: isValidGitRef ──────────────────────────────────────────────

describe("path-safety: isValidGitRef", () => {
  it("accepts branch names like 'main'", () => {
    assert.equal(isValidGitRef("main"), true, "main should be valid");
  });

  it("accepts branch names with slashes like 'feature/new-thing'", () => {
    assert.equal(isValidGitRef("feature/new-thing"), true,
      "feature/new-thing should be valid");
  });

  it("accepts refs/heads/main", () => {
    assert.equal(isValidGitRef("refs/heads/main"), true,
      "refs/heads/main should be valid");
  });

  it("accepts HEAD", () => {
    assert.equal(isValidGitRef("HEAD"), true, "HEAD should be valid");
  });

  it("accepts FETCH_HEAD, ORIG_HEAD, MERGE_HEAD", () => {
    assert.equal(isValidGitRef("FETCH_HEAD"), true, "FETCH_HEAD should be valid");
    assert.equal(isValidGitRef("ORIG_HEAD"), true, "ORIG_HEAD should be valid");
    assert.equal(isValidGitRef("MERGE_HEAD"), true, "MERGE_HEAD should be valid");
  });

  it("accepts hex hashes (7-40 chars)", () => {
    assert.equal(isValidGitRef("abcdef1"), true, "7-char hex should be valid");
    assert.equal(isValidGitRef("abcdef1234567890abcdef1234567890abcdef12"), true,
      "40-char hex should be valid");
  });

  it("accepts branch names with dots and underscores", () => {
    assert.equal(isValidGitRef("release/v1.0.0"), true,
      "branch with dots should be valid");
    assert.equal(isValidGitRef("my_branch"), true,
      "branch with underscores should be valid");
  });

  it("rejects invalid refs with ..", () => {
    assert.equal(isValidGitRef("feature..branch"), false,
      "double dots should be rejected");
  });

  it("rejects refs ending with .lock", () => {
    assert.equal(isValidGitRef("branch.lock"), false,
      ".lock suffix should be rejected");
  });

  it("rejects null, undefined, empty string", () => {
    assert.equal(isValidGitRef(null), false, "null should be rejected");
    assert.equal(isValidGitRef(undefined), false, "undefined should be rejected");
    assert.equal(isValidGitRef(""), false, "empty string should be rejected");
  });

  it("rejects refs with special characters", () => {
    assert.equal(isValidGitRef("branch name"), false,
      "spaces should be rejected");
    assert.equal(isValidGitRef("branch;cmd"), false,
      "semicolons should be rejected");
    assert.equal(isValidGitRef("branch$(cmd)"), false,
      "command injection should be rejected");
    assert.equal(isValidGitRef("branch`cmd`"), false,
      "backtick injection should be rejected");
  });
});

// ── fence: createFenceMarkers ───────────────────────────────────────────────

describe("fence: createFenceMarkers", () => {
  it("generates unique nonces across multiple calls", () => {
    const m1 = createFenceMarkers();
    const m2 = createFenceMarkers();
    const m3 = createFenceMarkers();

    assert.notEqual(m1.nonce, m2.nonce, "nonces should be different (1 vs 2)");
    assert.notEqual(m2.nonce, m3.nonce, "nonces should be different (2 vs 3)");
    assert.notEqual(m1.nonce, m3.nonce, "nonces should be different (1 vs 3)");
  });

  it("nonce is 16 hex chars (8 bytes)", () => {
    const markers = createFenceMarkers();
    assert.equal(markers.nonce.length, 16, "nonce should be 16 chars");
    assert.ok(/^[a-f0-9]{16}$/.test(markers.nonce),
      `nonce should be lowercase hex, got: ${markers.nonce}`);
  });

  it("start marker contains the nonce", () => {
    const markers = createFenceMarkers();
    assert.ok(markers.start.includes(markers.nonce),
      "start marker should contain the nonce");
  });

  it("end marker contains the nonce", () => {
    const markers = createFenceMarkers();
    assert.ok(markers.end.includes(markers.nonce),
      "end marker should contain the nonce");
  });

  it("start marker contains TOOL_OUTPUT_BEGIN", () => {
    const markers = createFenceMarkers();
    assert.ok(markers.start.includes("TOOL_OUTPUT_BEGIN"),
      "start marker should contain TOOL_OUTPUT_BEGIN");
  });

  it("end marker contains TOOL_OUTPUT_END", () => {
    const markers = createFenceMarkers();
    assert.ok(markers.end.includes("TOOL_OUTPUT_END"),
      "end marker should contain TOOL_OUTPUT_END");
  });

  it("start marker includes untrusted content warning", () => {
    const markers = createFenceMarkers();
    assert.ok(markers.start.includes("untrusted"),
      "start marker should warn about untrusted content");
  });

  it("returns an object with start, end, and nonce properties", () => {
    const markers = createFenceMarkers();
    assert.ok("start" in markers, "should have start property");
    assert.ok("end" in markers, "should have end property");
    assert.ok("nonce" in markers, "should have nonce property");
    assert.equal(typeof markers.start, "string");
    assert.equal(typeof markers.end, "string");
    assert.equal(typeof markers.nonce, "string");
  });
});

// ── fence: escapeFenceContent ───────────────────────────────────────────────

describe("fence: escapeFenceContent", () => {
  it("removes TOOL_OUTPUT_BEGIN markers from content", () => {
    const input = "before [TOOL_OUTPUT_BEGIN_abc123] after";
    const result = escapeFenceContent(input);
    assert.ok(!result.includes("[TOOL_OUTPUT_BEGIN"),
      "TOOL_OUTPUT_BEGIN markers should be replaced");
    assert.ok(result.includes("T00L_0UTPUT_BEGIN"),
      "should replace with visually similar substitution");
  });

  it("removes TOOL_OUTPUT_END markers from content", () => {
    const input = "before [TOOL_OUTPUT_END_abc123] after";
    const result = escapeFenceContent(input);
    assert.ok(!result.includes("[TOOL_OUTPUT_END"),
      "TOOL_OUTPUT_END markers should be replaced");
    assert.ok(result.includes("T00L_0UTPUT_END"),
      "should replace with visually similar substitution");
  });

  it("handles case-insensitive marker matching", () => {
    const input = "[tool_output_begin_test] content [TOOL_OUTPUT_END_test]";
    const result = escapeFenceContent(input);
    assert.ok(!result.includes("[tool_output_begin"),
      "lowercase markers should also be replaced");
    assert.ok(!result.includes("[TOOL_OUTPUT_END"),
      "uppercase markers should be replaced");
  });

  it("handles non-string input by converting to string", () => {
    assert.equal(escapeFenceContent(42), "42",
      "number should be converted to string");
    assert.equal(escapeFenceContent(true), "true",
      "boolean should be converted to string");
  });

  it("handles null input", () => {
    const result = escapeFenceContent(null);
    assert.equal(result, "", "null should become empty string");
  });

  it("handles undefined input", () => {
    const result = escapeFenceContent(undefined);
    assert.equal(result, "", "undefined should become empty string");
  });

  it("preserves normal content without markers", () => {
    const input = "This is normal content with no markers at all.";
    const result = escapeFenceContent(input);
    assert.equal(result, input, "normal content should be unchanged");
  });

  it("handles multiple markers in the same string", () => {
    const input = "[TOOL_OUTPUT_BEGIN_a] some content [TOOL_OUTPUT_END_a] more [TOOL_OUTPUT_BEGIN_b]";
    const result = escapeFenceContent(input);
    assert.ok(!result.includes("[TOOL_OUTPUT_BEGIN"),
      "all BEGIN markers should be replaced");
    assert.ok(!result.includes("[TOOL_OUTPUT_END"),
      "all END markers should be replaced");
  });

  it("handles empty string input", () => {
    assert.equal(escapeFenceContent(""), "", "empty string should remain empty");
  });
});

// ── debug-log ───────────────────────────────────────────────────────────────

describe("debug-log: debugLog", () => {
  it("does not throw when called with context and Error", () => {
    assert.doesNotThrow(
      () => debugLog("test-context", new Error("test error")),
      "debugLog should not throw with Error argument"
    );
  });

  it("does not throw when called with context and string", () => {
    assert.doesNotThrow(
      () => debugLog("test-context", "string error"),
      "debugLog should not throw with string argument"
    );
  });

  it("does not throw when called with null error", () => {
    assert.doesNotThrow(
      () => debugLog("test-context", null),
      "debugLog should not throw with null argument"
    );
  });

  it("does not throw when called with undefined error", () => {
    assert.doesNotThrow(
      () => debugLog("test-context", undefined),
      "debugLog should not throw with undefined argument"
    );
  });

  it("does not throw with no arguments", () => {
    assert.doesNotThrow(
      () => debugLog(),
      "debugLog should not throw with no arguments"
    );
  });
});

describe("debug-log: isDebugEnabled", () => {
  it("returns a boolean", () => {
    const result = isDebugEnabled();
    assert.equal(typeof result, "boolean", "isDebugEnabled should return a boolean");
  });

  it("returns consistent value across multiple calls", () => {
    const first = isDebugEnabled();
    const second = isDebugEnabled();
    assert.equal(first, second, "isDebugEnabled should return the same value");
  });
});
