/**
 * Tests for client.js — MercuryClient constructor and request building.
 * Note: MercuryClient requires INCEPTION_API_KEY. We test with a fake key.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Set a fake API key before importing the client
const origKey = process.env.INCEPTION_API_KEY;
process.env.INCEPTION_API_KEY = "test-fake-key-for-testing";

import { MercuryClient } from "../src/client.js";

afterEach(() => {
  // Restore original
  if (origKey) process.env.INCEPTION_API_KEY = origKey;
  else process.env.INCEPTION_API_KEY = "test-fake-key-for-testing";
});

describe("MercuryClient: constructor", () => {
  it("creates with default config", () => {
    const client = new MercuryClient();
    assert.ok(client);
    assert.ok(client.apiKey);
  });
  it("accepts custom apiKey and baseURL", () => {
    const client = new MercuryClient({ apiKey: "custom-key", baseURL: "http://localhost:8080" });
    assert.equal(client.apiKey, "custom-key");
    assert.equal(client.baseURL, "http://localhost:8080");
  });
  it("handles empty options", () => {
    const client = new MercuryClient({});
    assert.ok(client);
  });
});

describe("MercuryClient: _buildRequestBody", () => {
  it("builds body with messages and model", () => {
    const client = new MercuryClient();
    const body = client._buildRequestBody([{ role: "user", content: "Hello" }]);
    assert.ok(body);
    assert.ok(body.messages);
    assert.ok(body.model);
  });
  it("includes system message", () => {
    const client = new MercuryClient();
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const body = client._buildRequestBody(messages);
    assert.ok(body.messages.length >= 2);
  });
  it("handles tool definitions", () => {
    const client = new MercuryClient();
    const messages = [{ role: "user", content: "Read file" }];
    const tools = [{ type: "function", function: { name: "read", description: "Read a file", parameters: {} } }];
    const body = client._buildRequestBody(messages, { tools });
    assert.ok(body);
  });
});

describe("MercuryClient: methods exist", () => {
  it("has chatCompletion method", () => {
    const client = new MercuryClient();
    assert.ok(typeof client.chatCompletion === "function");
  });
  it("has chatCompletionStream method", () => {
    const client = new MercuryClient();
    assert.ok(typeof client.chatCompletionStream === "function");
  });
});
