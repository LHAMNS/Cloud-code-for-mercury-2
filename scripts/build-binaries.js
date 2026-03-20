#!/usr/bin/env node
// Mercury Code - Cross-Platform Binary Builder
// Packages mercury-code into standalone executables for Windows, macOS, and Linux
// using @yao-pkg/pkg (maintained fork of vercel/pkg).
//
// Usage:
//   node scripts/build-binaries.js              Build all platforms
//   node scripts/build-binaries.js --windows    Build only Windows
//   node scripts/build-binaries.js --macos      Build only macOS
//   node scripts/build-binaries.js --linux      Build only Linux

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const VERSION = PKG.version;

// ── Configuration ────────────────────────────────────────────────────────────

const TARGETS = {
  "win-x64":     { pkg: "node18-win-x64",     ext: ".exe", os: "windows", arch: "x64"   },
  "win-arm64":   { pkg: "node18-win-arm64",    ext: ".exe", os: "windows", arch: "arm64" },
  "macos-x64":   { pkg: "node18-macos-x64",    ext: "",     os: "macos",   arch: "x64"   },
  "macos-arm64": { pkg: "node18-macos-arm64",   ext: "",     os: "macos",   arch: "arm64" },
  "linux-x64":   { pkg: "node18-linux-x64",    ext: "",     os: "linux",   arch: "x64"   },
  "linux-arm64": { pkg: "node18-linux-arm64",   ext: "",     os: "linux",   arch: "arm64" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`\x1b[36m[build]\x1b[0m ${msg}`); }
function ok(msg)  { console.log(`\x1b[32m[build]\x1b[0m ${msg}`); }
function err(msg) { console.error(`\x1b[31m[build]\x1b[0m ${msg}`); }

function run(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  });
}

// ── Step 1: Create a CJS entry point for pkg ─────────────────────────────────
// pkg doesn't support ESM natively, so we create a thin CJS wrapper that
// uses dynamic import() to load the ESM cli.js.

function createPkgEntry() {
  const entryPath = join(ROOT, "_pkg_entry.cjs");
  writeFileSync(entryPath, `#!/usr/bin/env node
// Auto-generated CJS entry point for pkg bundling
// This wrapper loads the ESM cli.js via dynamic import
'use strict';

const { join } = require('path');
const { readFileSync } = require('fs');

// Detect if we're running inside a pkg snapshot
const isSnapshot = __dirname.startsWith('/snapshot') || __dirname.startsWith('C:\\\\snapshot');

async function main() {
  try {
    // When running from pkg, we need to use the snapshot filesystem
    // pkg bundles all files referenced in pkg.assets into the snapshot
    await import('./cli.js');
  } catch (err) {
    console.error('Mercury Code startup error:', err.message);
    process.exit(1);
  }
}

main();
`, "utf-8");
  return entryPath;
}

// ── Step 2: Ensure pkg is available ──────────────────────────────────────────

function ensurePkg() {
  try {
    execSync("npx --yes @yao-pkg/pkg@5 --version", { cwd: ROOT, stdio: "pipe" });
    ok("@yao-pkg/pkg is available");
  } catch {
    log("Installing @yao-pkg/pkg@5...");
    run("npm", ["install", "--no-save", "@yao-pkg/pkg@5"]);
  }
}

// ── Step 3: Build binaries ───────────────────────────────────────────────────

function buildTargets(selectedTargets) {
  // Create dist directory
  if (!existsSync(DIST)) {
    mkdirSync(DIST, { recursive: true });
  }

  const entry = createPkgEntry();

  // Build the pkg config in package.json temporarily
  const pkgConfig = {
    scripts: [
      "cli.js",
      "src/**/*.js",
    ],
    assets: [
      "package.json",
      "src/**/*.js",
      "src/tools/**/*.js",
      "src/ui/**/*.js",
      "src/web-ui/**",
    ],
    outputPath: DIST,
  };

  // Write temporary pkg config — wrapped in try/finally to guarantee package.json is restored
  const originalPkg = readFileSync(join(ROOT, "package.json"), "utf-8");
  const pkgJson = JSON.parse(originalPkg);
  pkgJson.pkg = pkgConfig;
  writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n", "utf-8");

  try {
    for (const [name, target] of Object.entries(selectedTargets)) {
      const outName = `mercury-code-v${VERSION}-${name}${target.ext}`;
      const outPath = join(DIST, outName);

      log(`Building ${name} → ${outName}`);

      try {
        run("npx", [
          "@yao-pkg/pkg",
          entry,
          "--target", target.pkg,
          "--output", outPath,
          "--compress", "GZip",
        ]);
        ok(`Built: ${outName}`);
      } catch (e) {
        err(`Failed to build ${name}: ${e.message}`);
        // Clean up partial binary file from failed build
        try { if (existsSync(outPath)) rmSync(outPath); } catch {}
      }
    }
  } finally {
    // Always restore package.json, even if the build crashes
    writeFileSync(join(ROOT, "package.json"), originalPkg, "utf-8");
    // Always clean up the temporary CJS entry point
    try { if (existsSync(entry)) rmSync(entry); } catch {}
  }
}

// ── Step 4: Create platform-specific archives ────────────────────────────────

function createArchives() {
  log("Creating platform archives...");
  const files = readdirSync(DIST);

  const MIN_BINARY_SIZE = 5 * 1024 * 1024; // 5 MB

  for (const file of files) {
    if (file.startsWith("mercury-code-v") && !file.endsWith(".zip") && !file.endsWith(".tar.gz")) {
      const filePath = join(DIST, file);

      // Validate binary file size before archiving
      const fileSize = statSync(filePath).size;
      if (fileSize < MIN_BINARY_SIZE) {
        err(`WARNING: ${file} is only ${(fileSize / 1024 / 1024).toFixed(2)} MB (expected >= 5 MB). Binary may be corrupt or incomplete.`);
      }

      if (file.endsWith(".exe")) {
        // Windows: create .zip
        const zipName = file.replace(".exe", ".zip");
        try {
          execSync(`cd "${DIST}" && zip "${zipName}" "${file}"`, { stdio: "pipe" });
          ok(`Archive: ${zipName}`);
        } catch {
          log(`zip not available, skipping archive for ${file}`);
        }
      } else {
        // Unix: create .tar.gz
        const tarName = file + ".tar.gz";
        try {
          execSync(`cd "${DIST}" && tar czf "${tarName}" "${file}"`, { stdio: "pipe" });
          ok(`Archive: ${tarName}`);
        } catch {
          log(`tar not available, skipping archive for ${file}`);
        }
      }
    }
  }
}

// ── Step 5: Generate checksums ───────────────────────────────────────────────

function generateChecksums() {
  log("Generating checksums...");
  const files = readdirSync(DIST).filter(f =>
    f.endsWith(".zip") || f.endsWith(".tar.gz") || (f.startsWith("mercury-code-v") && !f.includes("SHA256"))
  );

  let checksums = "";
  for (const file of files) {
    try {
      const shaCmd = platform() === "darwin" ? "shasum -a 256" : "sha256sum";
      const result = execSync(`cd "${DIST}" && ${shaCmd} "${file}"`, { encoding: "utf-8" }).trim();
      checksums += result + "\n";
    } catch {
      // skip
    }
  }

  if (checksums) {
    writeFileSync(join(DIST, `mercury-code-v${VERSION}-SHA256SUMS.txt`), checksums, "utf-8");
    ok("SHA256SUMS written");
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("");
  log(`Mercury Code v${VERSION} - Binary Builder`);
  console.log("");

  // Parse args
  const args = process.argv.slice(2);
  let selectedTargets = TARGETS;

  if (args.includes("--windows") || args.includes("--win")) {
    selectedTargets = Object.fromEntries(
      Object.entries(TARGETS).filter(([k]) => k.startsWith("win"))
    );
  } else if (args.includes("--macos") || args.includes("--mac")) {
    selectedTargets = Object.fromEntries(
      Object.entries(TARGETS).filter(([k]) => k.startsWith("macos"))
    );
  } else if (args.includes("--linux")) {
    selectedTargets = Object.fromEntries(
      Object.entries(TARGETS).filter(([k]) => k.startsWith("linux"))
    );
  }

  log(`Targets: ${Object.keys(selectedTargets).join(", ")}`);
  console.log("");

  ensurePkg();
  buildTargets(selectedTargets);
  createArchives();
  generateChecksums();

  console.log("");
  ok(`Release artifacts are in: dist/`);
  console.log("");

  // List files
  const files = readdirSync(DIST);
  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log("");
}

main();
