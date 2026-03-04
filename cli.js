#!/usr/bin/env node

// Mercury Code - CLI Entry Point
// Interactive AI coding assistant powered by Mercury-2 from Inception Labs
// Cross-platform: Linux, macOS (Intel + Apple Silicon), Windows

import { MercuryRepl } from "./src/repl.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf-8")
).version;

// ---------------------------------------------------------------------------
// Argument parsing (zero dependencies)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
\x1b[36m\x1b[1m☿ Mercury Code\x1b[0m v${PKG_VERSION}
\x1b[2mInteractive AI coding assistant powered by Mercury-2 diffusion model\x1b[0m

\x1b[1mUsage:\x1b[0m
  mercury [options]
  mercury -p "your prompt here"
  mercury --plan "design a new feature"

\x1b[1mOptions:\x1b[0m
  -h, --help                Show this help message and exit
  -v, --version             Print the version number and exit
      --verbose             Enable verbose / debug output
      --no-sandbox          Disable sandbox isolation
      --sandbox <mode>      Set sandbox mode: on (default), strict, off
  -p, --prompt <text>       Run in non-interactive (single-shot) mode
      --plan                Start in plan mode (read-only, creates a plan file)
      --trust-mode <mode>   Permission mode: readonly, approval (default),
                            acceptEdits, open, dontAsk, aiSafetyDecide
      --mcp-config <path>   Path to MCP servers config file

\x1b[1mExamples:\x1b[0m
  mercury                            Start an interactive REPL session
  mercury -p "Explain this repo"     Ask a single question and exit
  mercury --plan                     Start in plan mode
  mercury --trust-mode acceptEdits   Auto-approve file edits
  mercury --verbose                  Start with verbose logging

\x1b[1mInstallation:\x1b[0m
  npm install -g mercury-code        Install globally via npm
  mercury --help                     Show this help

\x1b[2mDocumentation: https://github.com/LHAMNS/Cloud-code-for-mercury-2\x1b[0m
`.trim());
}

function printVersion() {
  console.log(`mercury-code v${PKG_VERSION}`);
}

let verbose = false;
let promptText = null;
let sandboxMode = "on";
let trustMode = null;
let planMode = false;
let mcpConfigPath = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(0);
  }

  if (arg === "--version" || arg === "-v") {
    printVersion();
    process.exit(0);
  }

  if (arg === "--verbose") {
    verbose = true;
    continue;
  }

  if (arg === "--no-sandbox") {
    sandboxMode = "off";
    continue;
  }

  if (arg === "--sandbox") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --sandbox requires a mode: on, strict, off");
      process.exit(1);
    }
    if (!["on", "strict", "off"].includes(next)) {
      console.error("Error: --sandbox mode must be: on, strict, or off");
      process.exit(1);
    }
    sandboxMode = next;
    i++;
    continue;
  }

  if (arg === "-p" || arg === "--prompt") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --prompt requires a text argument.");
      process.exit(1);
    }
    promptText = next;
    i++;
    continue;
  }

  if (arg === "--plan") {
    planMode = true;
    continue;
  }

  if (arg === "--trust-mode") {
    const next = args[i + 1];
    const validModes = ["readonly", "approval", "acceptEdits", "open", "dontAsk", "aiSafetyDecide"];
    if (!next || !validModes.includes(next)) {
      console.error(`Error: --trust-mode must be one of: ${validModes.join(", ")}`);
      process.exit(1);
    }
    trustMode = next;
    i++;
    continue;
  }

  if (arg === "--mcp-config") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --mcp-config requires a file path.");
      process.exit(1);
    }
    mcpConfigPath = next;
    i++;
    continue;
  }

  // Unknown flag
  console.error(`Unknown option: ${arg}`);
  console.error('Run "mercury --help" for usage information.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  console.error("Fatal error:", err.message);
  if (verbose) {
    console.error(err.stack);
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  if (verbose && reason instanceof Error) {
    console.error(reason.stack);
  }
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const replOptions = {
    verbose,
    sandboxMode,
  };

  // Apply CLI trust mode (takes precedence)
  if (planMode) {
    replOptions.trustMode = "plan";
  } else if (trustMode) {
    replOptions.trustMode = trustMode;
  }

  // MCP config path
  if (mcpConfigPath) {
    replOptions.mcpConfigPath = mcpConfigPath;
  }

  const repl = new MercuryRepl(replOptions);

  if (promptText) {
    // Non-interactive / single-shot mode
    await repl.runOnce(promptText);
  } else {
    // Interactive REPL mode
    await repl.start();
  }
}

main();
