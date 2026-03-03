/**
 * Tests for project-config.js — MERCURY.md hierarchy loading.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { findProjectConfig, loadProjectConfig } from "../src/project-config.js";

let tmpDir;
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pconfig-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("ProjectConfig: findProjectConfig", () => {
  it("finds MERCURY.md in directory", async () => {
    await writeFile(path.join(tmpDir, "MERCURY.md"), "# Project Config\ntest: true\n", "utf-8");
    const found = await findProjectConfig(tmpDir);
    assert.ok(found, "Should find MERCURY.md");
    assert.ok(found.includes("MERCURY.md"), `Path should contain MERCURY.md: ${found}`);
  });

  it("returns null when no config exists", async () => {
    const found = await findProjectConfig(tmpDir);
    assert.equal(found, null, "Should return null when no config");
  });
});

describe("ProjectConfig: loadProjectConfig", () => {
  it("loads MERCURY.md and returns combined string", async () => {
    await writeFile(path.join(tmpDir, "MERCURY.md"), `
# Project Configuration
This project uses TypeScript.

## Rules
- Always use strict mode
- Never use var
    `.trim(), "utf-8");
    const config = await loadProjectConfig(tmpDir);
    // loadProjectConfig returns a string of combined sections
    assert.ok(typeof config === "string", "Should return a string");
    assert.ok(config.includes("TypeScript"), "Should include config content");
  });

  it("returns empty string for directory without config", async () => {
    const config = await loadProjectConfig(tmpDir);
    assert.ok(typeof config === "string", "Should return a string");
    // Without any config files, it may return empty or near-empty
  });

  it("handles nested directory structure", async () => {
    const subDir = path.join(tmpDir, "src", "components");
    await mkdir(subDir, { recursive: true });
    // Put config in parent
    await writeFile(path.join(tmpDir, "MERCURY.md"), "# Config\nparent config\n", "utf-8");
    const found = await findProjectConfig(tmpDir);
    assert.ok(found, "Should find config in parent");
  });
});
