import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolExecutor } from "../src/tools/executor.js";
import { Sandbox, SANDBOX_ON, SANDBOX_OFF } from "../src/sandbox.js";

function globToRegex(pattern) {
  let r = "", i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i+1] === "*") { if (pattern[i+2] === "/") { r += "(?:.+/)?"; i += 3; } else { r += ".*"; i += 2; } }
      else { r += "[^/]*"; i += 1; }
    } else if (ch === "?") { r += "[^/]"; i += 1; }
    else if (ch === "{") {
      const cb = pattern.indexOf("}", i);
      if (cb !== -1) { r += "(" + pattern.slice(i+1, cb).split(",").map(a => a.replace(/[.*+?^$|\\()[\]]/g, "\\$&")).join("|") + ")"; i = cb + 1; }
      else { r += "\\{"; i += 1; }
    } else if (ch === ".") { r += "\\."; i += 1; }
    else if ("(){}[]^$|+\\".includes(ch)) { r += "\\" + ch; i += 1; }
    else { r += ch; i += 1; }
  }
  return new RegExp("^" + r + "$");
}

function isValidGitRef(ref) {
  if (!ref || typeof ref !== "string") return false;
  return /^[a-zA-Z0-9._\-/~^]+$/.test(ref) && ref.length <= 200;
}

const SENSITIVE_PATTERNS = [/KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /CREDENTIAL/i, /AUTH/i, /^AWS_/, /^GCP_/, /^AZURE_/, /^GITHUB_TOKEN$/, /^NPM_TOKEN$/];
function _sanitizedEnv() {
  const c = {};
  for (const [k, v] of Object.entries(process.env)) { if (SENSITIVE_PATTERNS.some(re => re.test(k))) continue; c[k] = v; }
  return c;
}

describe("globToRegex", () => {
  it("matches *.js", () => { const re = globToRegex("*.js"); assert.ok(re.test("app.js") && !re.test("app.ts") && !re.test("src/app.js")); });
  it("matches **/*.js", () => { const re = globToRegex("**/*.js"); assert.ok(re.test("app.js") && re.test("src/app.js") && !re.test("src/app.ts")); });
  it("matches src/**/*.ts", () => { const re = globToRegex("src/**/*.ts"); assert.ok(re.test("src/index.ts") && !re.test("lib/i.ts")); });
  it("handles ?", () => { const re = globToRegex("file?.txt"); assert.ok(re.test("file1.txt") && !re.test("file12.txt")); });
  it("handles {a,b}", () => { const re = globToRegex("*.{js,ts}"); assert.ok(re.test("a.js") && re.test("a.ts") && !re.test("a.py")); });
  it("escapes dots", () => { assert.ok(globToRegex("*.test.js").test("app.test.js") && !globToRegex("*.test.js").test("apptestxjs")); });
  it("handles **", () => { assert.ok(globToRegex("src/**").test("src/f.js")); });
  it("exact filenames", () => { assert.ok(globToRegex("package.json").test("package.json") && !globToRegex("package.json").test("package.lock.json")); });
  it("escapes special chars", () => { assert.ok(globToRegex("file(1).txt").test("file(1).txt") && !globToRegex("file(1).txt").test("file1.txt")); });
});

describe("isValidGitRef (executor)", () => {
  it("accepts hex", () => { assert.ok(isValidGitRef("abc1234")); });
  it("accepts HEAD~N", () => { assert.ok(isValidGitRef("HEAD") && isValidGitRef("HEAD~3")); });
  it("accepts branches", () => { assert.ok(isValidGitRef("main") && isValidGitRef("feature/my-branch")); });
  it("rejects null/empty", () => { assert.ok(!isValidGitRef(null) && !isValidGitRef("")); });
  it("rejects shell injection", () => { assert.ok(!isValidGitRef("abc; rm -rf /") && !isValidGitRef("$(whoami)")); });
  it("rejects >200 chars", () => { assert.ok(!isValidGitRef("a".repeat(201))); });
});

describe("_sanitizedEnv", () => {
  it("preserves PATH", () => { if (process.env.PATH) assert.equal(_sanitizedEnv().PATH, process.env.PATH); });
  function testStrip(k, v) {
    const orig = process.env[k]; process.env[k] = v;
    try { assert.equal(_sanitizedEnv()[k], undefined); }
    finally { if (orig === undefined) delete process.env[k]; else process.env[k] = orig; }
  }
  it("strips KEY", () => { testStrip("MY_API_KEY", "s"); });
  it("strips SECRET", () => { testStrip("MY_SECRET", "s"); });
  it("strips TOKEN", () => { testStrip("ACCESS_TOKEN", "s"); });
  it("strips PASSWORD", () => { testStrip("DB_PASSWORD", "s"); });
  it("strips GITHUB_TOKEN", () => { testStrip("GITHUB_TOKEN", "s"); });
  it("strips NPM_TOKEN", () => { testStrip("NPM_TOKEN", "s"); });
  it("strips AWS_*", () => { testStrip("AWS_ACCESS_KEY_ID", "s"); });
  it("preserves normal vars", () => {
    const orig = process.env.MERCURY_SAFE; process.env.MERCURY_SAFE = "ok";
    try { assert.equal(_sanitizedEnv().MERCURY_SAFE, "ok"); }
    finally { if (orig === undefined) delete process.env.MERCURY_SAFE; else process.env.MERCURY_SAFE = orig; }
  });
});

describe("ToolExecutor - Read tool", () => {
  let tmpDir, executor;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-exec-")); executor = new ToolExecutor({ workspace: tmpDir, sandbox: new Sandbox({ mode: SANDBOX_OFF, workspace: tmpDir }) }); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("reads a file", async () => { await writeFile(path.join(tmpDir, "h.txt"), "Hello\nLine 2\n"); assert.ok((await executor.execute("Read", { file_path: path.join(tmpDir, "h.txt") })).includes("Hello")); });
  it("error for nonexistent", async () => { const r = await executor.execute("Read", { file_path: path.join(tmpDir, "nope.txt") }); assert.ok(r.toLowerCase().includes("error") || r.toLowerCase().includes("no such")); });
  it("respects offset/limit", async () => { await writeFile(path.join(tmpDir, "l.txt"), Array.from({length: 20}, (_, i) => "Line "+(i+1)).join("\n")); const r = await executor.execute("Read", { file_path: path.join(tmpDir, "l.txt"), offset: 5, limit: 3 }); assert.ok(r.includes("Line 5")); });
});

describe("ToolExecutor - Write tool", () => {
  let tmpDir, executor;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-exec-")); executor = new ToolExecutor({ workspace: tmpDir, sandbox: new Sandbox({ mode: SANDBOX_OFF, workspace: tmpDir }) }); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("creates a new file", async () => {
    const f = path.join(tmpDir, "new.txt");
    await executor.execute("Write", { file_path: f, content: "hello" });
    const { readFile: rf } = await import("node:fs/promises");
    assert.equal(await rf(f, "utf-8"), "hello");
  });
  it("creates parent dirs", async () => {
    const f = path.join(tmpDir, "deep", "f.txt");
    await executor.execute("Write", { file_path: f, content: "nested" });
    const { readFile: rf } = await import("node:fs/promises");
    assert.equal(await rf(f, "utf-8"), "nested");
  });
});

describe("ToolExecutor - Edit tool", () => {
  let tmpDir, executor;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-exec-")); executor = new ToolExecutor({ workspace: tmpDir, sandbox: new Sandbox({ mode: SANDBOX_OFF, workspace: tmpDir }) }); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("replaces exact match", async () => {
    const f = path.join(tmpDir, "e.txt");
    await writeFile(f, "Hello World\nFoo Bar\n");
    await executor.execute("Edit", { file_path: f, old_string: "Foo Bar", new_string: "Baz Qux" });
    const { readFile: rf } = await import("node:fs/promises");
    const c = await rf(f, "utf-8");
    assert.ok(c.includes("Baz Qux") && !c.includes("Foo Bar"));
  });
  it("error when not found", async () => {
    const f = path.join(tmpDir, "e.txt");
    await writeFile(f, "Hello\n");
    const r = await executor.execute("Edit", { file_path: f, old_string: "nope", new_string: "x" });
    assert.ok(r.toLowerCase().includes("not found") || r.toLowerCase().includes("no match") || r.toLowerCase().includes("error"));
  });
});

describe("ToolExecutor - Glob tool", () => {
  let tmpDir, executor;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-exec-"));
    executor = new ToolExecutor({ workspace: tmpDir, sandbox: new Sandbox({ mode: SANDBOX_OFF, workspace: tmpDir }) });
    await writeFile(path.join(tmpDir, "a.js"), "");
    await writeFile(path.join(tmpDir, "b.ts"), "");
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await writeFile(path.join(tmpDir, "src", "c.js"), "");
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("finds *.js", async () => { const r = await executor.execute("Glob", { pattern: "*.js", path: tmpDir }); assert.ok(r.includes("a.js") && !r.includes("b.ts")); });
  it("finds **/*.js", async () => { const r = await executor.execute("Glob", { pattern: "**/*.js", path: tmpDir }); assert.ok(r.includes("a.js") || r.includes("c.js")); });
});

describe("ToolExecutor - sandbox enforcement", () => {
  const HOME = process.env.HOME || "/root";
  it("blocks read of sensitive paths", async () => {
    const e = new ToolExecutor({ workspace: "/tmp/t", sandbox: new Sandbox({ mode: SANDBOX_ON, workspace: "/tmp/t" }) });
    const r = await e.execute("Read", { file_path: path.join(HOME, ".ssh/id_rsa") });
    assert.ok(r.includes("blocked") || r.includes("Sandbox") || r.includes("denied"), "Got: " + r.slice(0, 200));
  });
  it("blocks write to system paths", async () => {
    const e = new ToolExecutor({ workspace: "/tmp/t", sandbox: new Sandbox({ mode: SANDBOX_ON, workspace: "/tmp/t" }) });
    const r = await e.execute("Write", { file_path: "/etc/test.txt", content: "no" });
    assert.ok(r.includes("blocked") || r.includes("Sandbox") || r.includes("denied"), "Got: " + r.slice(0, 200));
  });
});
