#!/usr/bin/env node
// Mercury Code - Cross-platform postinstall script
// Works on Linux, macOS (Intel + Apple Silicon), and Windows

import { platform, arch } from "node:os";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const os = platform();    // 'linux', 'darwin', 'win32'
const cpu = arch();       // 'x64', 'arm64', 'arm'

// Make cli.js executable on Unix-like systems
if (os !== "win32") {
  try {
    chmodSync(join(ROOT, "cli.js"), 0o755);
  } catch {
    // Not critical — npm handles this via bin links
  }
}

// Create ~/.mercury config directory
const home = process.env.HOME || process.env.USERPROFILE || "";
if (home) {
  const configDir = join(home, ".mercury");
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      // Not critical
    }
  }
}

// Print install summary
const platformName = { linux: "Linux", darwin: "macOS", win32: "Windows" }[os] || os;
const cpuName = { x64: "x86_64", arm64: "Apple Silicon / ARM64", arm: "ARM" }[cpu] || cpu;

console.log("");
console.log(`  \x1b[36m\x1b[1m☿ Mercury Code\x1b[0m installed successfully!`);
console.log(`  \x1b[2mPlatform: ${platformName} (${cpuName})\x1b[0m`);
console.log("");
console.log(`  \x1b[33mGet started:\x1b[0m`);
console.log(`    \x1b[32m$ mercury\x1b[0m              Start interactive session`);
console.log(`    \x1b[32m$ mercury -p "..."\x1b[0m     Single-shot mode`);
console.log("");
console.log(`  \x1b[2mSet your API key: export INCEPTION_API_KEY=your_key\x1b[0m`);
console.log("");
