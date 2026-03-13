import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ToolExecutor } from "../src/tools/executor.js";
import { LspClient } from "../src/lsp.js";

describe("LSP hardening", () => {
  it("starts the LSP client once and converts 1-based lines", async () => {
    let startCalls = 0;
    const fakeClient = {
      async start() {
        startCalls++;
        return true;
      },
      async gotoDefinition(filePath, line, character) {
        assert.equal(filePath, "/tmp/example.js");
        assert.equal(line, 6);
        assert.equal(character, 2);
        return [{ file: "/tmp/example.js", line: 7, character: 2 }];
      },
      async findReferences() { return []; },
      async hover() { return null; },
      async documentSymbols() { return []; },
      async workspaceSymbols() { return []; },
      getDiagnostics() { return []; },
      stop() {},
    };

    const exec = new ToolExecutor({
      workspace: "/tmp",
      trustMode: "open",
      createLspClient: () => fakeClient,
    });

    const result = await exec.execute("Lsp", {
      action: "definition",
      file_path: "/tmp/example.js",
      line: 7,
      character: 2,
    });
    assert.match(result, /example\.js:7:2/);

    await exec.execute("Lsp", {
      action: "definition",
      file_path: "/tmp/example.js",
      line: 7,
      character: 2,
    });
    assert.equal(startCalls, 1);
  });

  it("normalizes file:// URIs back to local paths", () => {
    const client = new LspClient(process.cwd());
    const targetPath = path.join(process.cwd(), "test-output", "space path.js");
    const locations = client._normalizeLocations([
      {
        uri: pathToFileURL(targetPath).href,
        range: {
          start: { line: 4, character: 1 },
          end: { line: 4, character: 5 },
        },
      },
    ]);

    assert.equal(locations[0].file, targetPath);
    assert.equal(locations[0].line, 5);
  });
});


it("sanitizes environment variables before spawning the language server", async () => {
  const previousToken = process.env.INCEPTION_API_KEY;
  const previousPath = process.env.PATH;
  process.env.INCEPTION_API_KEY = "super-secret";
  process.env.PATH = previousPath || "C:/Windows/System32";

  let spawnOptions = null;
  const fakeProcess = {
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
  };

  try {
    const client = new LspClient(process.cwd(), {
      spawn: (_cmd, _args, options) => {
        spawnOptions = options;
        return fakeProcess;
      },
    });
    client._detectLanguage = () => "typescript";
    client._findCmd = () => "typescript-language-server";
    client._initialize = async () => {};

    const started = await client.start();
    assert.equal(started, true);
    assert.ok(spawnOptions);
    assert.equal(spawnOptions.env.INCEPTION_API_KEY, undefined);
    assert.ok(Object.keys(spawnOptions.env).length > 0);
  } finally {
    if (previousToken === undefined) delete process.env.INCEPTION_API_KEY;
    else process.env.INCEPTION_API_KEY = previousToken;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
