import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Sandbox, SANDBOX_ON, SANDBOX_OFF, SANDBOX_STRICT } from "../src/sandbox.js";

describe("Sandbox - mode & enabled", () => {
  it("defaults to ON", () => { const s = new Sandbox({ workspace: "/tmp/t" }); assert.equal(s.mode, SANDBOX_ON); assert.equal(s.enabled, true); });
  it("OFF disables", () => { const s = new Sandbox({ mode: SANDBOX_OFF, workspace: "/tmp/t" }); assert.equal(s.enabled, false); });
  it("STRICT enables", () => { const s = new Sandbox({ mode: SANDBOX_STRICT, workspace: "/tmp/t" }); assert.equal(s.enabled, true); });
  it("stores workspace", () => { assert.equal(new Sandbox({ workspace: "/a/b" }).workspace, "/a/b"); });
  it("ON string accepted", () => { assert.equal(new Sandbox({ mode: "on", workspace: "/tmp" }).enabled, true); });
});

describe("Sandbox - checkPath blocks sensitive home paths", () => {
  const s = new Sandbox({ workspace: "/tmp/t" });
  const HOME = process.env.HOME || "/root";
  const blocked = [
    ".ssh/id_rsa", ".ssh/id_ed25519", ".ssh/config",
    ".gnupg/secring.gpg",
    ".aws/credentials", ".aws/config",
    ".config/gcloud/credentials.db",
    ".azure/accessTokens.json",
    ".npmrc", ".pypirc",
    ".docker/config.json",
    ".kube/config",
    ".git-credentials",
    ".bash_history", ".zsh_history"
  ];
  for (const p of blocked) {
    const full = HOME + "/" + p;
    it(`blocks read of ~/${p}`, () => { assert.ok(!s.checkPath(full, "read").allowed, `Expected ${full} blocked`); });
  }
});

describe("Sandbox - checkPath blocks system writes", () => {
  const s = new Sandbox({ workspace: "/tmp/t" });
  const systemPaths = ["/usr/bin/test", "/usr/lib/x", "/usr/local/bin/y",
    "/bin/sh", "/sbin/init", "/lib/x",
    "/etc/hosts"];
  for (const p of systemPaths) {
    it(`denies write to ${p}`, () => { assert.ok(!s.checkPath(p, "write").allowed, `Expected write denied: ${p}`); });
  }
});

describe("Sandbox - workspace path allowed", () => {
  const s = new Sandbox({ workspace: "/tmp/t" });
  it("allows workspace read", () => { assert.ok(s.checkPath("/tmp/t/src/index.js", "read").allowed); });
  it("allows workspace write", () => { assert.ok(s.checkPath("/tmp/t/out.txt", "write").allowed); });
});

describe("Sandbox - additional deny paths", () => {
  const s = new Sandbox({ workspace: "/tmp/t", additionalDenyPaths: ["/custom/secret"] });
  it("blocks additional path", () => { assert.ok(!s.checkPath("/custom/secret/file.txt", "read").allowed); });
  it("allows non-denied path", () => { assert.ok(s.checkPath("/tmp/t/ok.txt", "read").allowed); });
});

describe("Sandbox - checkUrl", () => {
  const s = new Sandbox({ workspace: "/tmp/t" });
  it("allows HTTPS", () => { assert.ok(s.checkUrl("https://example.com").allowed); });
  it("allows HTTP", () => { assert.ok(s.checkUrl("http://example.com").allowed); });
  const sd = new Sandbox({ workspace: "/tmp/t", allowedDomains: ["api.example.com"] });
  it("allows whitelisted domain", () => { assert.ok(sd.checkUrl("https://api.example.com/v1").allowed); });
});

describe("Sandbox - toSubAgentConfig", () => {
  const s = new Sandbox({ mode: SANDBOX_STRICT, workspace: "/w", additionalDenyPaths: ["/x"] });
  it("propagates mode", () => { const c = s.toSubAgentConfig(); assert.equal(c.mode, SANDBOX_STRICT); });
  it("propagates workspace", () => { assert.equal(s.toSubAgentConfig().workspace, "/w"); });
});

describe("Sandbox - wrapCommand", () => {
  const s = new Sandbox({ workspace: "/tmp/t" });
  it("returns string", () => { assert.equal(typeof s.wrapCommand("echo hi"), "string"); });
  it("includes original command", () => { assert.ok(s.wrapCommand("ls -la").includes("ls")); });
  it("passthrough when OFF", () => { const off = new Sandbox({ mode: SANDBOX_OFF, workspace: "/tmp" }); assert.ok(off.wrapCommand("cmd").includes("cmd")); });
});

describe("Sandbox - getStatus", () => {
  it("returns object with mode", () => { const st = new Sandbox({ workspace: "/tmp" }).getStatus(); assert.equal(typeof st, "object"); assert.ok(st.mode); });
  it("returns off mode", () => { assert.equal(new Sandbox({ mode: SANDBOX_OFF, workspace: "/tmp" }).getStatus().mode, "off"); });
  it("returns strict mode", () => { assert.equal(new Sandbox({ mode: SANDBOX_STRICT, workspace: "/tmp" }).getStatus().mode, "strict"); });
});
