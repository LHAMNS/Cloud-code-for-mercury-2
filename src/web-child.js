import { MercuryRepl } from "./repl.js";
import { printWelcome, printInfo, printWarning, spinner } from "./ui/display.js";

const workspace = process.env.MERCURY_WORKSPACE || process.cwd();
const trustMode = process.env.MERCURY_TRUST_MODE || "approval";
const sandboxMode = process.env.MERCURY_SANDBOX_MODE || "on";
const verbose = process.env.MERCURY_VERBOSE === "1";
const historyDir = process.env.MERCURY_HISTORY_DIR || undefined;
const allowProjectHooks = process.env.MERCURY_ALLOW_PROJECT_HOOKS === "1";
const allowProjectMcp = process.env.MERCURY_ALLOW_PROJECT_MCP === "1";
const provider = process.env.MERCURY_PROVIDER || "mercury";
const model = process.env.MERCURY_MODEL || null;

const repl = new MercuryRepl({
  workspace,
  trustMode,
  sandboxMode,
  verbose,
  historyDir,
  allowProjectHooks,
  allowProjectMcp,
  provider,
  ...(model ? { model } : {}),
  skipStartupFlow: true,
  webBridgeMode: true,
});

function bridgeWrite(streamName, originalWrite) {
  return function bridgedWrite(chunk, encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf-8") : String(chunk);
    if (process.send) {
      process.send({ type: streamName, text });
      if (typeof encoding === "function") encoding();
      if (typeof callback === "function") callback();
      return true;
    }
    return originalWrite.call(this, chunk, encoding, callback);
  };
}

process.stdout.write = bridgeWrite("stdout", process.stdout.write.bind(process.stdout));
process.stderr.write = bridgeWrite("stderr", process.stderr.write.bind(process.stderr));

repl._rl = {
  line: "",
  cursor: 0,
  setPrompt() {},
  prompt() {},
};

const pendingAnswers = [];
let queue = Promise.resolve();
let initPromise = null;
let initError = null;

function ensureInit() {
  if (!initPromise || initError) {
    initError = null;
    initPromise = init().catch((err) => {
      initError = err;
      console.error(`Web child initialization failed: ${err.message}`);
      if (verbose && err?.stack) {
        console.error(err.stack);
      }
      throw err;
    });
  }
  return initPromise;
}

repl._ask = async (prompt) => {
  if (prompt) {
    process.stdout.write(prompt);
  }
  return await new Promise((resolve) => pendingAnswers.push(resolve));
};

async function init() {
  if (repl.sandbox) await repl.sandbox.init();
  const { labs } = await import("./labs.js");
  await labs.load();
  await repl._reloadWorkspaceState({
    resetConversation: true,
    reloadMcp: true,
    reloadSkills: true,
    announceProjectConfig: true,
  });
  await printWelcome({ showPlanet: repl.showPlanet });
  repl._printStatusBar();
  console.log("");
}

async function processInput(line) {
  if (pendingAnswers.length > 0) {
    const resolve = pendingAnswers.shift();
    resolve(line);
    return;
  }

  if (repl._processing || repl._inRollbackMode) {
    return;
  }

  repl._processing = true;
  repl._aborted = false;
  try {
    await repl._handleInput(line);
  } catch (err) {
    console.error(`Web child error: ${err.message}`);
    if (verbose && err?.stack) {
      console.error(err.stack);
    }
  } finally {
    repl._processing = false;
    repl._aborted = false;
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type !== "input") return;

  const text = String(message.text ?? "");
  if (message.mode === "multiline") {
    queue = queue
      .then(() => ensureInit())
      .then(() => processInput(`/_web_submit ${Buffer.from(text, "utf-8").toString("base64")}`))
      .catch((err) => {
        if (process.send) {
          process.send({ type: "stderr", text: `[Web child error] ${err.message}\n` });
        }
      });
    return;
  }

  queue = queue
    .then(() => ensureInit())
    .then(() => processInput(text))
    .catch((err) => {
      if (process.send) {
        process.send({ type: "stderr", text: `[Web child error] ${err.message}\n` });
      }
    });
});

process.on("disconnect", async () => {
  try {
    await repl._gracefulExit();
  } catch {
    process.exit(0);
  }
});

process.on("SIGINT", () => {
  if (repl._processing) {
    repl._aborted = true;
    spinner.stop();
    printWarning("Interrupted by web client.");
  } else {
    printInfo("Interrupt received.");
  }
});

process.on("SIGTERM", async () => {
  try { await repl._gracefulExit(); } catch { process.exit(0); }
});

await ensureInit();
