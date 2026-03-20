// Mercury Code - MCP (Model Context Protocol) Server Manager
// Manages external tool servers connected via stdio or HTTP transports.
// Configuration: .mercury/mcp.json or --mcp-config CLI flag
//
// MCP tool naming convention: mcp__<server-name>__<tool-name>
// e.g., mcp__filesystem__readFile, mcp__github__createIssue
export const MCP_PREFIX = "mcp__";

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sanitizeEnv, SENSITIVE_ENV_PATTERNS } from "./utils/env-sanitize.js";
import { debugLog } from "./utils/debug-log.js";
import { checkSsrf } from "./utils/ssrf.js";

// ── MCP Transport Types ────────────────────────────────────────────────────

const TRANSPORT_STDIO = "stdio";
const TRANSPORT_HTTP = "http";
const MAX_MCP_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

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
   * @param {boolean} [config.isProjectConfig] - Whether this server comes from a project-level config
   */
  constructor(name, config) {
    this.name = name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.url = config.url || null;
    this.transport = config.transport || (config.url ? TRANSPORT_HTTP : TRANSPORT_STDIO);
    this.isProjectConfig = config.isProjectConfig || false;

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
    // Merge sanitized base env with MCP server env, then re-filter to prevent
    // the MCP config from re-injecting sensitive vars (LD_PRELOAD, NODE_OPTIONS, etc.)
    const baseEnv = sanitizeEnv();
    const merged = { ...baseEnv, ...this.env };
    // Re-filter: remove any keys from this.env that match sensitive patterns
    const PROTECTED_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TERM']);
    const env = {};
    for (const [key, value] of Object.entries(merged)) {
      if (key in baseEnv) {
        // Key came from sanitizeEnv — already safe
        env[key] = value;
      } else if (SENSITIVE_ENV_PATTERNS.some(re => re.test(key))) {
        // MCP config tried to set a sensitive env var — block it
        debugLog("McpServer._startStdio", `Blocked sensitive env var from MCP config: ${key}`);
        continue;
      } else {
        env[key] = value;
      }
    }
    // Re-apply sanitized values for protected keys that MCP config may have overwritten
    for (const key of PROTECTED_ENV_KEYS) {
      if (this.env[key] !== undefined) {
        env[key] = baseEnv[key]; // restore sanitized value
      }
    }

    // Validate the command is a simple executable name — spaces or shell
    // metacharacters would be misinterpreted by child_process.spawn() which
    // does NOT use a shell by default.
    if (!this.command || typeof this.command !== "string") {
      throw new Error(`MCP server ${this.name}: command must be a non-empty string`);
    }
    if (/[\s|;&$`"'\\()<>]/.test(this.command)) {
      throw new Error(`MCP server ${this.name}: command must be a simple executable name without spaces or shell metacharacters: ${this.command}`);
    }

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
      this._rejectAllPending(new Error(`MCP server ${this.name} error: ${err.message}`));
    });

    this._process.on("exit", (code) => {
      this._ready = false;
      this._rejectAllPending(new Error(`MCP server ${this.name} exited with code ${code}`));
    });

    // Initialize: send initialize request
    await this._initialize();

    // Discover tools
    await this._listTools();
    this._ready = true;
  }

  async _startHttp() {
    // For HTTP transport, discover tools via HTTP
    await this._validateHttpUrl();
    await this._listToolsHttp();
    this._ready = true;
  }

  /**
   * Block requests to private/internal addresses for project-level MCP configs.
   * User-level configs are allowed to reach localhost (most MCP servers run there).
   */
  async _validateHttpUrl() {
    if (!this.url) return;
    const parsed = new URL(this.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`MCP HTTP: unsupported protocol ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("MCP HTTP: URLs with embedded credentials are blocked");
    }
    if (!this.isProjectConfig) return;
    const ssrfCheck = await checkSsrf(parsed.hostname);
    if (!ssrfCheck.allowed) {
      throw new Error(`MCP HTTP: blocked request to private/internal address: ${parsed.hostname} (project-level config) - ${ssrfCheck.reason}`);
    }
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
      await this._validateHttpUrl();
      const response = await fetch(`${this.url}/tools/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this._requestId,
          method: "tools/list",
          params: {},
        }),
        signal: AbortSignal.timeout(30000),
      });
      const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_MCP_RESPONSE_SIZE) {
        throw new Error(`MCP HTTP response too large: ${contentLength} bytes (max ${MAX_MCP_RESPONSE_SIZE})`);
      }
      
      // Always use streaming to prevent OOM from unbounded response bodies.
      // Servers that omit Content-Length or lie about it cannot bypass this limit.
      let body = "";
      if (response.body) {
        for await (const chunk of response.body) {
          body += chunk.toString();
          if (body.length > MAX_MCP_RESPONSE_SIZE) {
            throw new Error(`MCP HTTP response exceeded maximum size of ${MAX_MCP_RESPONSE_SIZE} bytes while streaming`);
          }
        }
      } else {
        // response.body unavailable (rare / non-standard runtime) — reject rather
        // than falling back to response.text() which loads the entire payload into
        // memory without a streaming size guard, enabling OOM DoS.
        throw new Error("MCP HTTP: streaming body not available; cannot enforce response size limit safely");
      }
      const data = JSON.parse(body);
      if (data.result && Array.isArray(data.result.tools)) {
        this._tools = data.result.tools.map((t) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object", properties: {} },
        }));
      }
    } catch (err) {
      debugLog("McpServer._listToolsHttp", err);
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
    try {
      await this._validateHttpUrl();
      const response = await fetch(`${this.url}/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this._requestId,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_MCP_RESPONSE_SIZE) {
        throw new Error(`MCP HTTP response too large: ${contentLength} bytes (max ${MAX_MCP_RESPONSE_SIZE})`);
      }

      // Always use streaming to prevent OOM from unbounded response bodies.
      let body = "";
      if (response.body) {
        for await (const chunk of response.body) {
          body += chunk.toString();
          if (body.length > MAX_MCP_RESPONSE_SIZE) {
            throw new Error(`MCP HTTP response exceeded maximum size of ${MAX_MCP_RESPONSE_SIZE} bytes while streaming`);
          }
        }
      } else {
        throw new Error("MCP HTTP: streaming body not available; cannot enforce response size limit safely");
      }
      const data = JSON.parse(body);
      if (data.result?.content) {
        return data.result.content
          .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
      }
      if (data.error) {
        throw new Error(`MCP error: ${data.error.message}`);
      }
      return JSON.stringify(data.result);
    } catch (err) {
      debugLog("McpServer._callToolHttp", err);
      throw new Error(`MCP HTTP tool call failed for "${toolName}": ${err.message}`);
    }
  }

  /**
   * Send a JSON-RPC request via stdio.
   */
  _request(method, params, timeout = 30000) {
    // Prevent unbounded pending request accumulation
    if (this._pending.size >= 50) {
      return Promise.reject(new Error(`MCP server ${this.name}: too many pending requests (${this._pending.size})`));
    }
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n";

      const timer = setTimeout(() => {
        this._settlePending(id, "reject", new Error(`MCP request ${method} timed out after ${timeout}ms`));
      }, timeout);

      this._pending.set(id, { resolve, reject, timer });

      if (!this._process || !this._process.stdin.writable) {
        this._settlePending(id, "reject", new Error(`MCP server ${this.name} not running`));
        return;
      }

      try {
        this._process.stdin.write(msg, (err) => {
          if (err) {
            this._settlePending(id, "reject", new Error(`MCP server ${this.name} write failed: ${err.message}`));
          }
        });
      } catch (err) {
        this._settlePending(id, "reject", new Error(`MCP server ${this.name} write failed: ${err.message}`));
      }
    });
  }

  /**
   * Handle incoming data from MCP server stdout.
   */
  _onData(data) {
    this._buffer += data;
    // Safety: prevent unbounded buffer growth from malformed MCP servers
    if (this._buffer.length > 10 * 1024 * 1024) { // 10MB
      this._buffer = "";
      return;
    }
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          if (msg.error) {
            this._settlePending(msg.id, "reject", new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            this._settlePending(msg.id, "resolve", msg.result);
          }
        }
        // Notifications (no id) are logged but not acted upon
      } catch (err) {
        debugLog("McpServer._onData.parseJSON", err);
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
    this._rejectAllPending(new Error(`MCP server ${this.name} shutting down`));

    if (this._process) {
      try {
        this._process.stdin.end();
        this._process.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      } catch (err) {
        debugLog("McpServer.stop", err);
      }
      this._process = null;
    }
    this._ready = false;
    this._tools = [];
    this._buffer = "";
  }

  get isReady() {
    return this._ready;
  }

  _settlePending(id, action, value) {
    const pending = this._pending.get(id);
    if (!pending) return false;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (action === "resolve") pending.resolve(value);
    else pending.reject(value);
    return true;
  }

  _rejectAllPending(error) {
    for (const id of [...this._pending.keys()]) {
      this._settlePending(id, "reject", error);
    }
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
  async loadConfig(workspace, explicitPath, options = {}) {
    const allowProjectConfig = options.allowProjectConfig === true;
    const candidates = [];
    const resolvedExplicitPath = explicitPath ? path.resolve(explicitPath) : null;
    const globalConfigPath = path.join(os.homedir(), ".mercury", "mcp.json");
    if (resolvedExplicitPath) {
      candidates.push(resolvedExplicitPath);
    } else if (allowProjectConfig) {
      candidates.push(
        path.join(workspace, ".mercury", "mcp.json"),
        path.join(workspace, ".mcp.json"),
      );
    }
    candidates.push(globalConfigPath);

    for (const configPath of candidates) {
      try {
        const data = await readFile(configPath, "utf-8");
        const config = JSON.parse(data);
        if (config.mcpServers && typeof config.mcpServers === "object") {
          // Determine if this is a project-level config (potential supply-chain risk)
          const isProjectConfig = configPath !== globalConfigPath
            && configPath !== resolvedExplicitPath;
          if (isProjectConfig) {
            console.warn(
              `\x1b[33m[mcp] Warning: Loading MCP servers from project config: ${configPath}\x1b[0m\n` +
              `\x1b[33m[mcp] Project MCP configs can execute arbitrary commands. Verify this file is trusted.\x1b[0m`
            );
          }
          await this._startServers(config.mcpServers, { isProjectConfig });
          this._loaded = true;
          return { loaded: true, path: configPath, count: this._servers.size, isProjectConfig };
        }
      } catch (err) {
        debugLog("McpManager.loadConfig", err);
        continue;
      }
    }

    this._loaded = true;
    return { loaded: false, path: null, count: 0 };
  }

  /**
   * Start all configured MCP servers.
   */
  async _startServers(serversConfig, options = {}) {
    const startPromises = [];

    for (const [name, config] of Object.entries(serversConfig)) {
      if (!config.command && !config.url) continue;

      const server = new McpServer(name, { ...config, isProjectConfig: options.isProjectConfig || false });
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
    if (!toolName) {
      throw new Error(`Invalid MCP tool name (empty tool): ${namespacedName}`);
    }

    const server = this._servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    if (!server.isReady) {
      throw new Error(`MCP server not ready: ${serverName}`);
    }

    // Sanitize MCP tool arguments before passing to external server
    this._validateMcpArgs(args);
    return server.callTool(toolName, args);
  }

  /**
   * Validate MCP tool arguments for dangerous values.
   * Blocks null bytes and path traversal in path-like arguments.
   */
  _validateMcpArgs(args) {
    if (!args || typeof args !== 'object') return;
    for (const [key, value] of Object.entries(args)) {
      if (typeof value !== 'string') continue;
      if (value.includes('\0')) {
        throw new Error(`MCP argument "${key}" contains null bytes`);
      }
      const lk = key.toLowerCase();
      if ((lk.includes('path') || lk.includes('file') || lk.includes('dir'))
          && /\.\.[/\\]/.test(value)) {
        throw new Error(`MCP argument "${key}" contains path traversal (..)`);
      }
    }
  }

  /**
   * Check if a tool name is an MCP tool.
   */
  isMcpTool(name) {
    return name.startsWith(MCP_PREFIX);
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
