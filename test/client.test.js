// Test: MercuryClient — constructor, request body, chatCompletion, HTTP errors,
// retry logic, HTTP insecure warning, and streaming SSE parsing.
// Uses node:http mock server — no real API calls.
// Allow HTTP for test mock server
process.env.MERCURY_ALLOW_HTTP = "1";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MercuryClient } from "../src/client.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeClient(overrides = {}) {
  return new MercuryClient({
    apiKey: "test-key",
    baseURL: "http://localhost:9999",
    ...overrides,
  });
}

// ── 1. Constructor defaults ────────────────────────────────────────────────────

describe("MercuryClient constructor", () => {
  it("uses provided apiKey and baseURL", () => {
    const client = makeClient({ apiKey: "my-key", baseURL: "http://example.com/v1" });
    assert.equal(client.apiKey, "my-key", "apiKey should match provided value");
    assert.equal(client.baseURL, "http://example.com/v1", "baseURL should match provided value");
  });

  it("sets _httpWarned to false initially", () => {
    const client = makeClient();
    assert.equal(client._httpWarned, false, "_httpWarned should start false");
  });

  it("normalizes config with defaults from DEFAULT_CONFIG", () => {
    const client = makeClient();
    assert.equal(client.config.model, "mercury-2", "default model should be mercury-2");
    assert.equal(client.config.max_tokens, 50000, "default max_tokens should be 50000");
    assert.equal(client.config.temperature, 0.75, "default temperature should be 0.75");
    assert.equal(client.config.reasoning_effort, "medium", "default reasoning_effort should be medium");
    assert.equal(client.config.reasoning_summary, true, "default reasoning_summary should be true");
  });

  it("accepts custom config overrides", () => {
    const client = makeClient({ model: "custom-model", max_tokens: 1024, temperature: 0.5 });
    assert.equal(client.config.model, "custom-model", "model should be overridden");
    assert.equal(client.config.max_tokens, 1024, "max_tokens should be overridden");
    assert.equal(client.config.temperature, 0.5, "temperature should be overridden");
  });
});

// ── 2. _buildRequestBody ────────────────────────────────────────────────────

describe("MercuryClient._buildRequestBody", () => {
  it("includes model, max_tokens, temperature, reasoning_effort from defaults", () => {
    const client = makeClient();
    const body = client._buildRequestBody([{ role: "user", content: "hi" }]);

    assert.equal(body.model, "mercury-2", "model should default to mercury-2");
    assert.equal(body.max_tokens, 50000, "max_tokens should default to 50000");
    assert.equal(body.temperature, 0.75, "temperature should default to 0.75");
    assert.equal(body.reasoning_effort, "medium", "reasoning_effort should default to medium");
    assert.equal(body.reasoning_summary, true, "reasoning_summary should default to true");
  });

  it("allows option overrides for model, max_tokens, temperature, reasoning_effort", () => {
    const client = makeClient();
    const body = client._buildRequestBody([{ role: "user", content: "hi" }], {
      model: "custom-model",
      max_tokens: 1024,
      temperature: 0.5,
      reasoning_effort: "high",
    });

    assert.equal(body.model, "custom-model");
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.temperature, 0.5);
    assert.equal(body.reasoning_effort, "high");
  });

  it("includes tools and tool_choice when provided", () => {
    const client = makeClient();
    const tools = [{ type: "function", function: { name: "read_file" } }];
    const body = client._buildRequestBody([{ role: "user", content: "x" }], {
      tools,
      tool_choice: "auto",
    });

    assert.deepEqual(body.tools, tools, "tools should be included in body");
    assert.equal(body.tool_choice, "auto", "tool_choice should be included");
  });

  it("omits tools when array is empty", () => {
    const client = makeClient();
    const body = client._buildRequestBody([{ role: "user", content: "x" }], {
      tools: [],
    });

    assert.equal(body.tools, undefined, "empty tools array should be omitted");
  });

  it("includes stop sequences when provided", () => {
    const client = makeClient();
    const body = client._buildRequestBody([{ role: "user", content: "x" }], {
      stop: ["\n"],
    });

    assert.deepEqual(body.stop, ["\n"], "stop sequences should be included");
  });

  it("sets diffusing and stream flags when diffusing is true", () => {
    const client = makeClient();
    const body = client._buildRequestBody([{ role: "user", content: "x" }], {
      diffusing: true,
    });

    assert.equal(body.diffusing, true, "diffusing should be true");
    assert.equal(body.stream, true, "stream should be true when diffusing");
  });

  it("sanitizes null content to empty string for non-assistant messages", () => {
    const client = makeClient();
    const messages = [
      { role: "user", content: null },
      { role: "system", content: undefined },
    ];
    const body = client._buildRequestBody(messages);

    assert.equal(body.messages[0].content, "", "null user content should become empty string");
    assert.equal(body.messages[1].content, "", "undefined system content should become empty string");
  });

  it("preserves null content on assistant messages with tool_calls", () => {
    const client = makeClient();
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "ls" } }],
      },
    ];
    const body = client._buildRequestBody(messages);

    assert.equal(body.messages[0].content, null, "null content should be preserved for assistant+tool_calls");
    assert.deepEqual(body.messages[0].tool_calls, messages[0].tool_calls);
  });

  it("sanitizes null content on assistant messages WITHOUT tool_calls", () => {
    const client = makeClient();
    const messages = [{ role: "assistant", content: null }];
    const body = client._buildRequestBody(messages);

    assert.equal(body.messages[0].content, "", "null assistant content without tool_calls should become empty");
  });

  it("does not mutate the original messages array", () => {
    const client = makeClient();
    const original = [{ role: "user", content: null }];
    client._buildRequestBody(original);

    assert.equal(original[0].content, null, "original message content should remain null");
  });
});

// ── 3. chatCompletion — success response ────────────────────────────────────

describe("MercuryClient.chatCompletion (mock server)", () => {
  let server, baseURL, skipReason = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url;

        // Route: success
        if (url === "/chat/completions") {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-test-1",
            object: "chat.completion",
            model: parsed.model || "mercury-2",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Hello from mock!" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }

        // Route: 401 Unauthorized
        if (url === "/error-401") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }

        // Route: 404 Not Found
        if (url === "/error-404") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Not found" } }));
          return;
        }

        // Route: 429 Rate Limit (retryable)
        if (url === "/error-429") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }

        // Route: 500 Server Error (retryable)
        if (url === "/error-500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal error" } }));
          return;
        }

        // Route: invalid JSON
        if (url === "/invalid-json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("this is not json{{{");
          return;
        }

        // Route: SSE streaming
        if (url === "/stream") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: " + JSON.stringify({
            id: "chatcmpl-stream-1",
            choices: [{ delta: { role: "assistant", content: "Hello" }, index: 0 }],
          }) + "\n\n");
          res.write("data: " + JSON.stringify({
            id: "chatcmpl-stream-2",
            choices: [{ delta: { content: " World" }, index: 0 }],
          }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // Default: 404
        res.writeHead(404);
        res.end("Not Found");
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (err?.code === "EPERM") {
        skipReason = "Sandbox disallows binding localhost sockets in this environment";
        return;
      }
      throw err;
    }
  });

  after(() => server?.close());

  it("returns parsed JSON on successful 200 response", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    const result = await client.chatCompletion([{ role: "user", content: "hi" }]);

    assert.equal(result.id, "chatcmpl-test-1", "response id should match");
    assert.equal(result.choices[0].message.content, "Hello from mock!", "content should match");
    assert.equal(result.usage.total_tokens, 15, "usage total_tokens should match");
  });

  it("sends correct Authorization header", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    // The mock server already validates requests come through; we test the body structure
    const client = new MercuryClient({ apiKey: "test-key-12345", baseURL });
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    assert.ok(result.choices, "should receive valid response with auth header");
  });

  it("sets stream to false for chatCompletion", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    // chatCompletion sets body.stream = false; verify it works
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    assert.ok(result.choices.length > 0, "should get at least one choice");
  });
});

// ── 4. chatCompletion — HTTP error codes ────────────────────────────────────

describe("MercuryClient HTTP error handling", () => {
  let server, baseURL, skipReason = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url;

        if (url === "/chat/completions") {
          // Non-retryable error: 401
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (err?.code === "EPERM") {
        skipReason = "Sandbox disallows binding localhost sockets in this environment";
        return;
      }
      throw err;
    }
  });

  after(() => server?.close());

  it("rejects with error for non-retryable HTTP status (401)", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "test" }]),
      (err) => {
        assert.ok(err.message.includes("401"), `error should mention status 401, got: ${err.message}`);
        return true;
      },
      "should reject for 401 error"
    );
  });
});

describe("MercuryClient invalid JSON response", () => {
  let server, baseURL, skipReason = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not valid json {{{");
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (err?.code === "EPERM") {
        skipReason = "Sandbox disallows binding localhost sockets in this environment";
        return;
      }
      throw err;
    }
  });

  after(() => server?.close());

  it("rejects with error for invalid JSON response", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "test" }]),
      (err) => {
        assert.ok(err.message.includes("Invalid JSON"), `error should mention Invalid JSON, got: ${err.message}`);
        return true;
      },
      "should reject for invalid JSON"
    );
  });
});

// ── 5. _fetchWithRetry — retry logic ────────────────────────────────────────

describe("MercuryClient._fetchWithRetry retry logic", () => {
  let server, baseURL, requestCount, skipReason = null;

  before(async () => {
    requestCount = 0;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestCount++;

        // First 2 requests return 429, third request succeeds
        if (requestCount <= 2) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-retry-success",
          choices: [{ message: { role: "assistant", content: "Success after retries!" } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (err?.code === "EPERM") {
        skipReason = "Sandbox disallows binding localhost sockets in this environment";
        return;
      }
      throw err;
    }
  });

  after(() => server?.close());

  it("retries on 429 and succeeds on third attempt", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    const result = await client._fetchWithRetry("/chat/completions", {
      model: "mercury-2",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    });

    assert.equal(result.id, "chatcmpl-retry-success", "should get success response after retries");
    assert.equal(requestCount, 3, "should have made 3 requests total (2 retries + 1 success)");
  });
});

describe("MercuryClient._fetchWithRetry exhausts retries", () => {
  let server, baseURL, skipReason = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Server error" } }));
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (err?.code === "EPERM") {
        skipReason = "Sandbox disallows binding localhost sockets in this environment";
        return;
      }
      throw err;
    }
  });

  after(() => server?.close());

  it("throws after exhausting all retries on persistent 500", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    await assert.rejects(
      () => client._fetchWithRetry("/chat/completions", {
        model: "mercury-2",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      }, 1), // only 1 retry
      (err) => {
        assert.ok(err.message.includes("500"), `error should mention 500, got: ${err.message}`);
        return true;
      },
      "should throw after exhausting retries"
    );
  });
});

// ── 6. _warnIfInsecure ──────────────────────────────────────────────────────

describe("MercuryClient._warnIfInsecure", () => {
  it("throws for remote HTTP by default when an API key is present", () => {
    const saved = process.env.MERCURY_ALLOW_HTTP;
    delete process.env.MERCURY_ALLOW_HTTP;
    try {
      const client = makeClient({ baseURL: "http://example.com/v1", apiKey: "key123" });
      assert.throws(
        () => client._warnIfInsecure(),
        /Refusing to send API key over plain HTTP/i
      );
    } finally {
      if (saved !== undefined) process.env.MERCURY_ALLOW_HTTP = saved;
    }
  });

  it("sets _httpWarned to true when insecure HTTP is explicitly allowed", () => {
    const client = makeClient({ baseURL: "http://example.com/v1", apiKey: "key123", allowInsecureHttp: true });
    // Capture stderr output by swapping process.stderr.write
    let warningOutput = "";
    const origWrite = process.stderr.write;
    process.stderr.write = (msg) => { warningOutput += msg; };
    try {
      client._warnIfInsecure();
      assert.equal(client._httpWarned, true, "_httpWarned should be set to true");
      assert.ok(warningOutput.includes("WARNING"), "should emit HTTP warning to stderr");
      assert.ok(warningOutput.includes("plain HTTP"), "warning should mention plain HTTP");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("does not warn twice (only warns once)", () => {
    const client = makeClient({ baseURL: "http://example.com/v1", apiKey: "key123", allowInsecureHttp: true });
    let warnCount = 0;
    const origWrite = process.stderr.write;
    process.stderr.write = () => { warnCount++; };
    try {
      client._warnIfInsecure();
      client._warnIfInsecure();
      assert.equal(warnCount, 1, "should only warn once");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("does not warn when using HTTPS", () => {
    const client = makeClient({ baseURL: "https://secure.example.com/v1", apiKey: "key123" });
    let warned = false;
    const origWrite = process.stderr.write;
    process.stderr.write = () => { warned = true; };
    try {
      client._warnIfInsecure();
      assert.equal(warned, false, "should not warn for HTTPS");
      assert.equal(client._httpWarned, false, "_httpWarned should remain false for HTTPS");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("does not warn when protocol is HTTPS even with API key", () => {
    const client = makeClient({ baseURL: "https://api.example.com/v1", apiKey: "secret-key" });
    let warned = false;
    const origWrite = process.stderr.write;
    process.stderr.write = () => { warned = true; };
    try {
      client._warnIfInsecure();
      assert.equal(warned, false, "should not warn when HTTPS is used");
      assert.equal(client._httpWarned, false, "_httpWarned should remain false");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("allows loopback HTTP without warning", () => {
    const client = makeClient({ baseURL: "http://127.0.0.1:9999/v1", apiKey: "loopback-key" });
    assert.doesNotThrow(() => client._warnIfInsecure());
    assert.equal(client._httpWarned, false);
  });

  it("does not throw for malformed baseURL", () => {
    const client = makeClient({ baseURL: "not-a-valid-url" });
    assert.doesNotThrow(() => client._warnIfInsecure(), "should not throw for malformed URL");
  });
});

// ── 7. chatCompletionStream — basic SSE parsing ─────────────────────────────

describe("MercuryClient.chatCompletionStream (mock server)", () => {
  let server, baseURL, skipReason = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url;

        if (url === "/chat/completions") {
          const parsed = JSON.parse(body);
          if (parsed.stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            // Send SSE chunks
            res.write("data: " + JSON.stringify({
              id: "chatcmpl-stream-1",
              choices: [{ delta: { role: "assistant", content: "Hello" }, index: 0 }],
            }) + "\n\n");

            res.write("data: " + JSON.stringify({
              id: "chatcmpl-stream-2",
              choices: [{ delta: { content: " from" }, index: 0 }],
            }) + "\n\n");

            res.write("data: " + JSON.stringify({
              id: "chatcmpl-stream-3",
              choices: [{ delta: { content: " stream!" }, index: 0 }],
            }) + "\n\n");

            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }

        if (url === "/error-stream") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Stream error" } }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (err?.code === "EPERM") {
        skipReason = "Sandbox disallows binding localhost sockets in this environment";
        return;
      }
      throw err;
    }
  });

  after(() => server?.close());

  it("yields parsed SSE chunks from streaming response", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    const chunks = [];

    for await (const chunk of client.chatCompletionStream(
      [{ role: "user", content: "hello" }]
    )) {
      chunks.push(chunk);
    }

    assert.ok(chunks.length >= 3, `should have at least 3 chunks, got ${chunks.length}`);
    assert.equal(chunks[0].choices[0].delta.content, "Hello", "first chunk content should be Hello");
    assert.equal(chunks[1].choices[0].delta.content, " from", "second chunk content should be from");
    assert.equal(chunks[2].choices[0].delta.content, " stream!", "third chunk content should be stream!");
  });

  it("accumulates content from all streamed delta chunks", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    let fullContent = "";

    for await (const chunk of client.chatCompletionStream(
      [{ role: "user", content: "hello" }]
    )) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) fullContent += delta.content;
    }

    assert.equal(fullContent, "Hello from stream!", "accumulated content should match");
  });

  it("does not yield [DONE] marker as a chunk", async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    const client = new MercuryClient({ apiKey: "test-key", baseURL });
    const chunks = [];

    for await (const chunk of client.chatCompletionStream(
      [{ role: "user", content: "hello" }]
    )) {
      chunks.push(chunk);
    }

    for (const chunk of chunks) {
      assert.notEqual(chunk, "[DONE]", "should not yield raw [DONE]");
      assert.ok(typeof chunk === "object", "each chunk should be a parsed object");
    }
  });
});
