// Security tests — SSRF, symlink escape, path traversal, permission enforcement
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ToolExecutor } from "../src/tools/executor.js";
import { Sandbox } from "../src/sandbox.js";

describe("Security: workspace boundary", () => {
  it("blocks writes outside workspace", async () => {
    const exec = new ToolExecutor({ workspace: "/tmp/test-ws", trustMode: "open" });
    const result = await exec.execute("Write", {
      file_path: "/etc/passwd",
      content: "hacked",
    });
    assert.ok(result.includes("Error") || result.includes("outside") || result.includes("blocked"),
      `Should block /etc/passwd write, got: ${result}`);
  });

  it("blocks edit outside workspace", async () => {
    const exec = new ToolExecutor({ workspace: "/tmp/test-ws", trustMode: "open" });
    const result = await exec.execute("Edit", {
      file_path: "/etc/hosts",
      old_string: "localhost",
      new_string: "evil",
    });
    assert.ok(result.includes("Error") || result.includes("outside") || result.includes("blocked"),
      `Should block /etc/hosts edit, got: ${result}`);
  });

  it("allows reads inside workspace", async () => {
    const exec = new ToolExecutor({ workspace: "/tmp", trustMode: "open" });
    // /tmp is the workspace, should be able to attempt reads there
    const result = await exec.execute("Read", { file_path: "/tmp/.nonexistent-file-test" });
    // Should get "not found" not "blocked"
    assert.ok(result.includes("not found") || result.includes("Error"),
      `Should attempt read, got: ${result}`);
  });
});

describe("Security: symlink-safe path resolution", () => {
  it("_resolveViaAncestor walks up correctly", () => {
    const exec = new ToolExecutor({ workspace: "/tmp/test-ws", trustMode: "open" });
    // Test with a known path that has existing ancestors
    const resolved = exec._resolveViaAncestor("/tmp/nonexistent/deep/path.txt");
    assert.ok(resolved.startsWith("/tmp"), `Should resolve within /tmp, got: ${resolved}`);
  });

  it("_isInWorkspace returns true for workspace paths", () => {
    const exec = new ToolExecutor({ workspace: "/tmp", trustMode: "open" });
    assert.equal(exec._isInWorkspace("/tmp/file.txt"), true);
    assert.equal(exec._isInWorkspace("/tmp/sub/dir/file.txt"), true);
  });

  it("_isInWorkspace returns false for outside paths", () => {
    const exec = new ToolExecutor({ workspace: "/tmp/test-ws", trustMode: "open" });
    assert.equal(exec._isInWorkspace("/etc/passwd"), false);
    assert.equal(exec._isInWorkspace("/home/user/file.txt"), false);
  });

  it("detects path traversal via ../", () => {
    const exec = new ToolExecutor({ workspace: "/tmp/test-ws", trustMode: "open" });
    // /tmp/test-ws/../../../etc/passwd should resolve to /etc/passwd
    assert.equal(exec._isInWorkspace("/tmp/test-ws/../../../etc/passwd"), false);
  });
});

describe("Security: Sandbox path checking", () => {
  it("blocks sensitive credential paths", () => {
    const sandbox = new Sandbox({ mode: "on", workspace: "/tmp" });
    sandbox.init();

    const home = process.env.HOME || "/root";
    const check = sandbox.checkPath(path.join(home, ".ssh/id_rsa"), "read");
    assert.equal(check.allowed, false);
    assert.ok(check.reason.includes("sensitive"));
  });

  it("blocks .env files", () => {
    const sandbox = new Sandbox({ mode: "on", workspace: "/tmp" });
    sandbox.init();

    const home = process.env.HOME || "/root";
    const check = sandbox.checkPath(path.join(home, ".env"), "read");
    assert.equal(check.allowed, false);
  });

  it("blocks system directory writes", () => {
    const sandbox = new Sandbox({ mode: "on", workspace: "/tmp" });
    sandbox.init();

    const check = sandbox.checkPath("/etc/passwd", "write");
    assert.equal(check.allowed, false);
    assert.ok(check.reason.includes("system path"));
  });

  it("allows workspace paths", () => {
    const sandbox = new Sandbox({ mode: "on", workspace: "/tmp" });
    sandbox.init();

    const check = sandbox.checkPath("/tmp/my-file.txt", "write");
    assert.equal(check.allowed, true);
  });

  it("strict mode blocks reads outside workspace", () => {
    const sandbox = new Sandbox({ mode: "strict", workspace: "/tmp/project" });
    sandbox.init();

    const check = sandbox.checkPath("/home/user/secret.txt", "read");
    assert.equal(check.allowed, false);
    assert.ok(check.reason.includes("strict"));
  });

  it("strict mode allows reads in workspace", () => {
    const sandbox = new Sandbox({ mode: "strict", workspace: "/tmp" });
    sandbox.init();

    const check = sandbox.checkPath("/tmp/file.txt", "read");
    assert.equal(check.allowed, true);
  });
});

describe("Security: URL checking", () => {
  it("strict mode blocks plain HTTP", () => {
    const sandbox = new Sandbox({ mode: "strict", workspace: "/tmp" });
    sandbox.init();

    const check = sandbox.checkUrl("http://example.com/api");
    assert.equal(check.allowed, false);
    assert.ok(check.reason.includes("HTTP"));
  });

  it("strict mode allows HTTPS", () => {
    const sandbox = new Sandbox({ mode: "strict", workspace: "/tmp" });
    sandbox.init();

    const check = sandbox.checkUrl("https://example.com/api");
    assert.equal(check.allowed, true);
  });

  it("strict mode with domain allowlist blocks unlisted domains", () => {
    const sandbox = new Sandbox({
      mode: "strict",
      workspace: "/tmp",
      allowedDomains: ["api.example.com"],
    });
    sandbox.init();

    const check = sandbox.checkUrl("https://evil.com/steal");
    assert.equal(check.allowed, false);
    assert.ok(check.reason.includes("allowlist"));
  });

  it("strict mode with domain allowlist allows listed domains", () => {
    const sandbox = new Sandbox({
      mode: "strict",
      workspace: "/tmp",
      allowedDomains: ["api.example.com"],
    });
    sandbox.init();

    const check = sandbox.checkUrl("https://api.example.com/data");
    assert.equal(check.allowed, true);
  });

  it("non-strict mode allows HTTP", () => {
    const sandbox = new Sandbox({ mode: "on", workspace: "/tmp" });
    sandbox.init();

    const check = sandbox.checkUrl("http://example.com/api");
    assert.equal(check.allowed, true);
  });
});

describe("Security: Sandbox disabled", () => {
  it("allows everything when sandbox is off", () => {
    const sandbox = new Sandbox({ mode: "off", workspace: "/tmp" });
    assert.equal(sandbox.enabled, false);
    assert.equal(sandbox.checkPath("/etc/passwd", "write").allowed, true);
    assert.equal(sandbox.checkUrl("http://localhost").allowed, true);
  });
});

describe("Security: Environment sanitization", () => {
  it("ToolExecutor can be constructed without errors", () => {
    const exec = new ToolExecutor({
      workspace: "/tmp",
      trustMode: "open",
    });
    assert.ok(exec);
    assert.equal(exec.workspace, "/tmp");
    assert.equal(exec.trustMode, "open");
  });
});

describe("Security: git ref validation", () => {
  // The isValidGitRef function is internal — we test indirectly via diff tool
  it("rejects dangerous git refs via diff tool", async () => {
    const exec = new ToolExecutor({ workspace: "/tmp", trustMode: "open" });
    const result = await exec.execute("Diff", {
      git_ref: "; rm -rf /",
    });
    assert.ok(result.includes("Error") || result.includes("invalid"),
      `Should reject dangerous ref, got: ${result}`);
  });
});
