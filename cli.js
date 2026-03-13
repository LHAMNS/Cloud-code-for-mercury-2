#!/usr/bin/env node

// Mercury Code - CLI Entry Point
// Interactive AI coding assistant powered by Mercury-2 from Inception Labs
// Cross-platform: Linux, macOS (Intel + Apple Silicon), Windows

import { MercuryRepl } from "./src/repl.js";
import { startWebServer } from "./src/web-server.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";
import { listProviders, getProvider, listProvidersDetailed } from "./src/providers.js";

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
\x1b[2mInteractive AI coding assistant — multi-provider (Mercury-2, OpenAI, etc.)\x1b[0m

\x1b[1mUsage:\x1b[0m
  mercury [options]
  mercury --web
  mercury -p "your prompt here"
  mercury --provider openai --model gpt-4o

\x1b[1mOptions:\x1b[0m
  -h, --help                Show this help message and exit
  -v, --version             Print the version number and exit
      --verbose             Enable verbose / debug output
      --cli                 Force command-line mode
      --web                 Start browser-hosted web console mode
      --no-sandbox          Disable sandbox isolation
      --sandbox <mode>      Set sandbox mode: on (default), strict, off
      --workspace <path>    Set initial workspace directory
      --host <host>         Web mode bind host (default: 127.0.0.1)
      --port <port>         Web mode bind port (default: random free port)
  -p, --prompt <text>       Run in non-interactive (single-shot) mode
      --plan                Start in plan mode (read-only, creates a plan file)
      --trust-mode <mode>   Permission mode: readonly, approval (default),
                            acceptEdits, open, dontAsk, aiSafetyDecide
      --provider <name>     AI provider: mercury (default), openai
      --model <name>        Model to use (e.g., gpt-4o, mercury-2)
      --mcp-config <path>   Path to MCP servers config file
      --allow-project-mcp   Allow workspace .mercury/mcp.json or .mcp.json
      --allow-project-hooks Allow workspace .mercury/hooks.json

\x1b[1mProviders:\x1b[0m
  mercury    Mercury-2 diffusion model (INCEPTION_API_KEY)
  openai     OpenAI ChatGPT models  (OPENAI_API_KEY)
             Models: gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini,
                     gpt-4.1-nano, o3, o4-mini, gpt-4-turbo, gpt-3.5-turbo

\x1b[1mExamples:\x1b[0m
  mercury                             Start with Mercury-2 (default)
  mercury --provider openai           Start with OpenAI (gpt-4o default)
  mercury --provider openai --model gpt-4.1   Use GPT-4.1
  mercury -p "Explain this repo"      Ask a single question and exit
  mercury --plan                      Start in plan mode
  mercury --verbose                   Start with verbose logging

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
let launchMode = null;
let workspace = process.cwd();
let webHost = "127.0.0.1";
let webPort = 0;
let allowProjectMcp = false;
let allowProjectHooks = false;
let providerName = process.env.MERCURY_PROVIDER || "mercury";
let modelName = null;

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

  if (arg === "--cli") {
    launchMode = "cli";
    continue;
  }

  if (arg === "--web") {
    launchMode = "web";
    continue;
  }

  if (arg === "--cli-child") {
    launchMode = "cli-child";
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

  if (arg === "--allow-project-mcp") {
    allowProjectMcp = true;
    continue;
  }

  if (arg === "--allow-project-hooks") {
    allowProjectHooks = true;
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

  if (arg === "--workspace") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --workspace requires a path.");
      process.exit(1);
    }
    workspace = next;
    i++;
    continue;
  }

  if (arg === "--host") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --host requires a hostname.");
      process.exit(1);
    }
    webHost = next;
    i++;
    continue;
  }

  if (arg === "--port") {
    const next = args[i + 1];
    const port = Number.parseInt(next, 10);
    if (!next || Number.isNaN(port) || port < 0 || port > 65535) {
      console.error("Error: --port must be an integer between 0 and 65535.");
      process.exit(1);
    }
    webPort = port;
    i++;
    continue;
  }

  if (arg === "--provider") {
    const next = args[i + 1];
    const validProviders = listProviders();
    if (!next || !validProviders.includes(next)) {
      console.error(`Error: --provider must be one of: ${validProviders.join(", ")}`);
      process.exit(1);
    }
    providerName = next;
    i++;
    continue;
  }

  if (arg === "--model") {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) {
      console.error("Error: --model requires a model name.");
      process.exit(1);
    }
    modelName = next;
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

async function promptLaunchMode() {
  if (promptText || launchMode || process.env.MERCURY_WEB_CHILD === "1") {
    return launchMode || "cli";
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "cli";
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer = "";
  try {
    console.log("");
    console.log("\x1b[36m\x1b[1m☿ Mercury Code Launch\x1b[0m");
    console.log("  1. Command line");
    console.log("  2. Web console");
    answer = await rl.question("\nSelect mode [1]: ");
  } finally {
    rl.close();
  }

  const normalized = answer.trim().toLowerCase();
  if (normalized === "2" || normalized === "web" || normalized === "w") {
    return "web";
  }
  return "cli";
}

/**
 * Read a line of input from stdin without echoing characters (for secrets).
 * Falls back to normal readline if stdin is not a TTY.
 */
function askSecret(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    let input = '';
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (c === '\u0003') { // Ctrl+C
        process.stdout.write('\n');
        process.exit(1);
      } else if (c === '\u007f' || c === '\b') { // Backspace
        input = input.slice(0, -1);
      } else {
        input += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function resolveApiKey(selectedMode) {
  const provider = getProvider(providerName);
  const envVarName = provider?.envKey || "INCEPTION_API_KEY";
  const envValue = process.env[envVarName];

  if (envValue) {
    return envValue;
  }

  if (selectedMode === "cli-child") {
    return null;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${envVarName} environment variable is required for provider "${providerName}".\n` +
      `Set it with:\n` +
      `  export ${envVarName}=your_key_here`
    );
  }

  const providerLabel = provider?.displayName || providerName;
  console.log("");
  console.log("\x1b[33m\x1b[1mAPI key required.\x1b[0m");
  console.log(`Provider: ${providerLabel}`);
  console.log(`Paste your API key for this session (env: ${envVarName}).`);
  console.log("It will only be kept in memory unless you export it yourself.");
  const apiKey = await askSecret(`\n${envVarName}: `);

  if (!apiKey.trim()) {
    throw new Error(
      `${envVarName} is required to start Mercury Code with provider "${providerName}".\n` +
      `Set it with:\n` +
      `  export ${envVarName}=your_key_here`
    );
  }

  return apiKey.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const selectedMode = await promptLaunchMode();
  const initialTrustMode = planMode ? "readonly" : (trustMode || "approval");
  const resolvedApiKey = await resolveApiKey(selectedMode);

  if (selectedMode === "web") {
    // Security warning: binding to non-localhost exposes the web UI to the network
    if (webHost !== "127.0.0.1" && webHost !== "localhost" && webHost !== "::1") {
      console.warn("");
      console.warn("\x1b[33m\x1b[1m⚠  Security Warning:\x1b[0m");
      console.warn(`\x1b[33m   Binding to ${webHost} will expose Mercury Code to the network.\x1b[0m`);
      console.warn("\x1b[33m   Anyone on the network could access your AI coding assistant.\x1b[0m");
      console.warn("\x1b[33m   Only use this if you understand the risks.\x1b[0m");
      console.warn("");
    }
    const provider = getProvider(providerName);
    const keyName = provider?.envKey || "INCEPTION_API_KEY";
    const webServer = await startWebServer({
      host: webHost,
      port: webPort,
      workspace,
      trustMode: initialTrustMode,
      sandboxMode,
      verbose,
      provider: providerName,
      model: modelName,
      childEnv: {
        ...(resolvedApiKey ? { [keyName]: resolvedApiKey } : {}),
        MERCURY_PROVIDER: providerName,
        ...(modelName ? { MERCURY_MODEL: modelName } : {}),
        ...(allowProjectHooks ? { MERCURY_ALLOW_PROJECT_HOOKS: "1" } : {}),
        ...(allowProjectMcp ? { MERCURY_ALLOW_PROJECT_MCP: "1" } : {}),
      },
    });
    const opened = await webServer.openBrowser();
    if (opened) {
      console.log(`Mercury Web UI listening at ${webServer.url}`);
    } else {
      console.log(`Mercury Web UI listening at ${webServer.launchUrl}`);
      console.log("Automatic browser open failed. Open the launch URL above manually.");
    }
    const shutdown = async () => {
      await webServer.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  const replOptions = {
    verbose,
    sandboxMode,
    workspace,
    skipStartupFlow: selectedMode === "cli-child",
    webBridgeMode: selectedMode === "cli-child",
    apiKey: resolvedApiKey || undefined,
    allowProjectHooks,
    allowProjectMcp,
    provider: providerName,
  };

  // Apply explicit model override
  if (modelName) {
    replOptions.model = modelName;
  }

  // Apply CLI trust mode (takes precedence)
  if (planMode) {
    replOptions.trustMode = "readonly";
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

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (verbose && err?.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
