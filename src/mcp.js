// Mercury Code - MCP (Model Context Protocol) Server Manager
// Manages external tool servers connected via stdio or HTTP transports.
// Configuration: .mercury/mcp.json or --mcp-config CLI flag
//
// MCP tool naming convention: mcp__<server-name>__<tool-name>
// e.g., mcp__filesystem__readFile, mcp__github__createIssue

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── MCP Transport Types ────────────────────────────────────────────────────

const TRANSPORT_STDIO = "stdio";
const TRANSPORT_HTTP = "http";

// ── McpServer ──────────────────────────────────────────────────────────────

/**
 * Represents a single MCP server connection.
 */
class McpServer {
  /**
   * @param {string} name - Server name (used in tool namespace)
   * @param {object} config - Server configuration
   * @param {string} config.command - Command to execute (stdio transport)
   * @param {string[]} [config.args] - Command arguments
   * @param {object} [config.env] - Environment variables to set
   * @param {string} [config.url] - HTTP endpoint (http transport)
   * @param {string} [config.transport] - Transport type: 'stdio' or 'http'
   */
  constructor(name, config) {
    this.name = name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.url = config.url || null;
    this.transport = config.transport || (config.url ? TRANSPORT_HTTP : TRANSPORT_STDIO);

    this._process = null;
    this._tools = [];
    this._ready = false;
    this._requestId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._buffer = "";
  }

  /**
   * Start the MCP server process and discover available tools.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.transport === TRANSPORT_HTTP) {
      await this._startHttp();
    } else {
      await this._startStdio();
    }
  }

  async _startStdio() {
    const env = {
      ...process.env,
      ...this.env,
    };

    // Strip sensitive env vars from child process
    delete env.INCEPTION_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;

    this._process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: process.cwd(),
    });

    this._process.stdout.setEncoding("utf-8");
    this._process.stdout.on("data", (data) => this._onData(data));
    this._process.stderr.setEncoding("utf-8");
    this._process.stderr.on("data", (data) => {
      // Log stderr for debugging but don't crash
      if (process.env.MERCURY_VERBOSE) {
        process.stderr.write(`[mcp:${this.name}:stderr] ${data}`);
      }
    });

    this._process.on("error", (err) => {
      this._ready = false;
      // Reject all pending requests
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server ${this.name} error: ${err.message}`));
      }
      this._pending.clear();
    });

    this._process.on("exit", (code) => {
      this._ready = false;
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server ${this.name} exited with code ${code}`));
      }
      this._pending.clear();
    });

    // Initialize: send initialize request
    await this._initialize();

    // Discover tools
    await this._listTools();
    this._ready = true;
  }

  async _startHttp() {
    // For HTTP transport, discover tools via HTTP
    await this._listToolsHttp();
    this._ready = true;
  }

  /**
   * Send JSON-RPC initialize request.
   */
  async _initialize() {
    return this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "mercury-code",
        version: "1.3.0",
      },
    });
  }

  /**
   * Discover tools from the MCP server.
   */
  async _listTools() {
    const result = await this._request("tools/list", {});
    if (result && Array.isArray(result.tools)) {
      this._tools = result.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      }));
    }
  }

  async _listToolsHttp() {
    try {
      const response = await fetch(`${this.url}/tools/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this._requestId,
          method: "tools/list",
          params: {},
        }),
      });
      const data = await response.json();
      if (data.result && Array.isArray(data.result.tools)) {
        this._tools = data.result.tools.map((t) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object", properties: {} },
        }));
      }
    } catch {
      this._tools = [];
    }
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} toolName - Tool name (without namespace prefix)
   * @param {object} args - Tool arguments
   * @returns {Promise<string>} Tool result as string
   */
  async callTool(toolName, args) {
    if (this.transport === TRANSPORT_HTTP) {
      return this._callToolHttp(toolName, args);
    }
    const result = await this._request("tools/call", {
      name: toolName,
      arguments: args,
    });
    if (result && result.content) {
      // MCP returns content as array of {type, text} blocks
      return result.content
        .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(result);
  }

  async _callToolHttp(toolName, args) {
    const response = await fetch(`${this.url}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this._requestId,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    const data = await response.json();
    if (data.result?.content) {
      return data.result.content
        .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }
    return JSON.stringify(data.result);
  }

  /**
   * Send a JSON-RPC request via stdio.
   */
  _request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n";

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeout}ms`));
      }, timeout);

      this._pending.set(id, { resolve, reject, timer });

      if (!this._process || !this._process.stdin.writable) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`MCP server ${this.name} not running`));
        return;
      }

      this._process.stdin.write(msg);
    });
  }

  /**
   * Handle incoming data from MCP server stdout.
   */
  _onData(data) {
    this._buffer += data;
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const pending = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications (no id) are logged but not acted upon
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  /**
   * Get the list of discovered tools with namespaced names.
   * @returns {Array<{name: string, description: string, inputSchema: object}>}
   */
  getTools() {
    return this._tools.map((t) => ({
      ...t,
      namespacedName: `mcp__${this.name}__${t.name}`,
    }));
  }

  /**
   * Stop the MCP server process.
   */
  async stop() {
    if (this._process) {
      try {
        this._process.stdin.end();
        this._process.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      } catch {
        // Already dead
      }
      this._process = null;
    }
    this._ready = false;
    this._tools = [];
  }

  get isReady() {
    return this._ready;
  }
}

// ── McpManager ─────────────────────────────────────────────────────────────

/**
 * Manages multiple MCP server connections and provides unified tool access.
 */
export class McpManager {
  constructor() {
    /** @type {Map<string, McpServer>} */
    this._servers = new Map();
    this._loaded = false;
  }

  /**
   * Load MCP configuration from file.
   * Searches (in order):
   *   1. Explicit path (--mcp-config)
   *   2. .mercury/mcp.json (project)
   *   3. .mcp.json (project root)
   *   4. ~/.mercury/mcp.json (global)
   *
   * @param {string} workspace - Project workspace root
   * @param {string} [explicitPath] - Explicit config file path from CLI
   */
  async loadConfig(workspace, explicitPath) {
    const candidates = [];
    if (explicitPath) candidates.push(path.resolve(explicitPath));
    candidates.push(
      path.join(workspace, ".mercury", "mcp.json"),
      path.join(workspace, ".mcp.json"),
      path.join(os.homedir(), ".mercury", "mcp.json"),
    );

    for (const configPath of candidates) {
      try {
        const data = await readFile(configPath, "utf-8");
        const config = JSON.parse(data);
        if (config.mcpServers && typeof config.mcpServers === "object") {
          await this._startServers(config.mcpServers);
          this._loaded = true;
          return { loaded: true, path: configPath, count: this._servers.size };
        }
      } catch {
        continue;
      }
    }

    this._loaded = true;
    return { loaded: false, path: null, count: 0 };
  }

  /**
   * Start all configured MCP servers.
   */
  async _startServers(serversConfig) {
    const startPromises = [];

    for (const [name, config] of Object.entries(serversConfig)) {
      if (!config.command && !config.url) continue;

      const server = new McpServer(name, config);
      this._servers.set(name, server);

      startPromises.push(
        server.start().catch((err) => {
          // Server failed to start — log but don't crash
          if (process.env.MERCURY_VERBOSE) {
            console.error(`[mcp] Failed to start server "${name}": ${err.message}`);
          }
        })
      );
    }

    // Wait for all servers to start (with timeout)
    await Promise.race([
      Promise.allSettled(startPromises),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
  }

  /**
   * Get all available MCP tools as OpenAI function calling format definitions.
   * @returns {Array<object>} Tool definitions
   */
  getToolDefinitions() {
    const defs = [];
    for (const server of this._servers.values()) {
      if (!server.isReady) continue;
      for (const tool of server.getTools()) {
        defs.push({
          type: "function",
          function: {
            name: tool.namespacedName,
            description: `[MCP: ${server.name}] ${tool.description}`,
            parameters: tool.inputSchema,
          },
        });
      }
    }
    return defs;
  }

  /**
   * Execute an MCP tool by its namespaced name.
   * @param {string} namespacedName - e.g., "mcp__filesystem__readFile"
   * @param {object} args - Tool arguments
   * @returns {Promise<string>} Tool result
   */
  async executeTool(namespacedName, args) {
    const parts = namespacedName.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") {
      throw new Error(`Invalid MCP tool name: ${namespacedName}`);
    }

    const serverName = parts[1];
    const toolName = parts.slice(2).join("__");

    const server = this._servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    if (!server.isReady) {
      throw new Error(`MCP server not ready: ${serverName}`);
    }

    return server.callTool(toolName, args);
  }

  /**
   * Check if a tool name is an MCP tool.
   */
  isMcpTool(name) {
    return name.startsWith("mcp__");
  }

  /**
   * Get status of all MCP servers.
   * @returns {Array<{name: string, ready: boolean, tools: number}>}
   */
  getStatus() {
    const status = [];
    for (const [name, server] of this._servers) {
      status.push({
        name,
        ready: server.isReady,
        tools: server.getTools().length,
        transport: server.transport,
      });
    }
    return status;
  }

  /**
   * Shutdown all MCP servers.
   */
  async shutdown() {
    const promises = [];
    for (const server of this._servers.values()) {
      promises.push(server.stop());
    }
    await Promise.allSettled(promises);
    this._servers.clear();
  }

  get serverCount() {
    return this._servers.size;
  }

  get isLoaded() {
    return this._loaded;
  }
}
