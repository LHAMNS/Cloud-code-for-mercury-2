import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MercuryClient } from "../src/client.js";

describe("MercuryClient._buildRequestBody", () => {
  const client = new MercuryClient({ apiKey: "test-key" });
  it("includes model", () => { const b = client._buildRequestBody([{ role: "user", content: "hi" }]); assert.ok(b.model); });
  it("includes messages", () => { const b = client._buildRequestBody([{ role: "user", content: "hi" }]); assert.deepEqual(b.messages, [{ role: "user", content: "hi" }]); });
  it("sets max_tokens", () => { assert.ok(client._buildRequestBody([]).max_tokens > 0); });
  it("respects overrides", () => { assert.equal(client._buildRequestBody([], { temperature: 0.5 }).temperature, 0.5); });
  it("handles null content", () => { const b = client._buildRequestBody([{ role: "assistant", content: null }]); assert.ok(b.messages); });
  it("includes tools when provided", () => { const tools = [{ type: "function", function: { name: "Read", parameters: {} } }]; const b = client._buildRequestBody([], { tools }); assert.deepEqual(b.tools, tools); });
  it("includes tool_choice", () => { const b = client._buildRequestBody([], { tool_choice: "auto" }); assert.equal(b.tool_choice, "auto"); });
  it("includes stop sequences", () => { const b = client._buildRequestBody([], { stop: ["END"] }); assert.deepEqual(b.stop, ["END"]); });
  it("uses configured model", () => { const c2 = new MercuryClient({ apiKey: "k", model: "custom-model" }); assert.equal(c2._buildRequestBody([]).model, "custom-model"); });
});

describe("MercuryClient constructor", () => {
  it("accepts apiKey", () => { const c = new MercuryClient({ apiKey: "k" }); assert.ok(c); });
  it("sets baseURL", () => { const c = new MercuryClient({ apiKey: "k", baseURL: "https://custom.api" }); assert.equal(c.baseURL, "https://custom.api"); });
  it("merges config", () => { const c = new MercuryClient({ apiKey: "k", model: "m1", temperature: 0.7 }); assert.equal(c.config.temperature, 0.7); });
});
