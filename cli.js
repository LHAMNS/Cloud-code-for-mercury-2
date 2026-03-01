#!/usr/bin/env node

// Mercury Code - CLI Entry Point
// Interactive AI coding assistant powered by Mercury-2 from Inception Labs

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
mercury-code — Interactive AI coding assistant powered by Mercury-2

Usage:
  mercury-code [options]
  mercury-code -p "your prompt here"

Options:
  -h, --help        Show this help message and exit
  -v, --version     Print the version number and exit
      --verbose     Enable verbose / debug output
  -p, --prompt <text>
                    Run in non-interactive (single-shot) mode.
                    Sends the given prompt, prints the response, and exits.

Examples:
  mercury-code                          Start an interactive REPL session
  mercury-code -p "Explain this repo"   Ask a single question and exit
  mercury-code --verbose                Start the REPL with verbose logging
`.trim());
}

function printVersion() {
  console.log(`mercury-code v${PKG_VERSION}`);
}

let verbose = false;
let promptText = null;

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

  if (arg === "-p" || arg === "--prompt") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --prompt requires a text argument.");
      process.exit(1);
    }
    promptText = next;
    i++; // skip the next token — it's the prompt value
    continue;
  }

  // Unknown flag
  console.error(`Unknown option: ${arg}`);
  console.error('Run "mercury-code --help" for usage information.');
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
  const repl = new MercuryRepl({ verbose });

  if (promptText) {
    // Non-interactive / single-shot mode
    await repl.runOnce(promptText);
  } else {
    // Interactive REPL mode
    await repl.start();
  }
}

main();
