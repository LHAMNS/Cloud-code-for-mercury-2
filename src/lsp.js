// Mercury Code - LSP (Language Server Protocol) Integration
// Provides semantic code intelligence: go-to-definition, find-references,
// hover info, diagnostics, symbols, etc. by connecting to language servers.
//
// This module auto-detects and starts language servers for the project,
// then exposes their capabilities as tool-callable functions.
//
// Supported languages (auto-detected):
//   TypeScript/JavaScript → typescript-language-server
//   Python              → pylsp / pyright-langserver
//   Go                  → gopls
//   Rust                → rust-analyzer
//   Java                → jdtls
//   C/C++               → clangd

import { execSync, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// ── Language server configurations ────────────────────────────────────────────

const LANGUAGE_SERVERS = {
  typescript: {
    cmd: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    markers: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageId: "typescript",
  },
  python: {
    cmd: "pylsp",
    fallbackCmd: "pyright-langserver",
    fallbackArgs: ["--stdio"],
    args: [],
    extensions: [".py"],
    markers: ["setup.py", "pyproject.toml", "requirements.txt", "Pipfile"],
    languageId: "python",
  },
  go: {
    cmd: "gopls",
    args: ["serve", "-rpc.trace"],
    extensions: [".go"],
    markers: ["go.mod", "go.sum"],
    languageId: "go",
  },
  rust: {
    cmd: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    markers: ["Cargo.toml"],
    languageId: "rust",
  },
  cpp: {
    cmd: "clangd",
    args: ["--background-index"],
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx"],
    markers: ["CMakeLists.txt", "Makefile", "compile_commands.json"],
    languageId: "cpp",
  },
};

// ── LSP message protocol ─────────────────────────────────────────────────────

let _requestId = 0;

function lspMessage(method, params) {
  _requestId++;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: _requestId,
    method,
    params,
  });
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return { id: _requestId, raw: header + body };
}

function lspNotification(method, params) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
  });
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return header + body;
}

// ── LSP Client ────────────────────────────────────────────────────────────────

export class LspClient {
  constructor(workspace) {
    this.workspace = workspace;
    this._process = null;
    this._language = null;
    this._config = null;
    this._initialized = false;
    this._responseHandlers = new Map();
    this._buffer = "";
    this._diagnostics = new Map(); // uri → diagnostics[]
  }

  /**
   * Detect the primary language of the workspace and start the appropriate LSP.
   * Returns true if a server was started successfully.
   */
  async start() {
    this._language = this._detectLanguage();
    if (!this._language) return false;

    this._config = LANGUAGE_SERVERS[this._language];
    if (!this._config) return false;

    // Check if the LSP binary is available
    const cmd = this._findCmd();
    if (!cmd) return false;

    try {
      this._process = spawn(cmd, this._config.args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      this._process.stdout.on("data", (data) => this._onData(data));
      this._process.stderr.on("data", () => {}); // Suppress stderr
      this._process.on("exit", () => {
        this._process = null;
        this._initialized = false;
      });

      // Initialize
      await this._initialize();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop the language server.
   */
  stop() {
    if (this._process) {
      this._send(lspNotification("exit", null));
      setTimeout(() => {
        if (this._process) {
          this._process.kill();
          this._process = null;
        }
      }, 2000);
    }
    this._initialized = false;
  }

  /**
   * Get the detected language and server status.
   */
  getStatus() {
    return {
      language: this._language,
      server: this._config?.cmd || null,
      running: this._initialized && this._process !== null,
    };
  }

  // ── LSP Operations ──────────────────────────────────────────────────────

  /**
   * Go to definition of symbol at position.
   * @param {string} filePath - Absolute path to file
   * @param {number} line - 0-based line number
   * @param {number} character - 0-based column number
   * @returns {Promise<object[]>} Array of locations [{uri, range}]
   */
  async gotoDefinition(filePath, line, character) {
    if (!this._initialized) return [];
    await this._openFile(filePath);
    const resp = await this._request("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    });
    return this._normalizeLocations(resp);
  }

  /**
   * Find all references to symbol at position.
   */
  async findReferences(filePath, line, character) {
    if (!this._initialized) return [];
    await this._openFile(filePath);
    const resp = await this._request("textDocument/references", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return this._normalizeLocations(resp);
  }

  /**
   * Get hover information for symbol at position.
   */
  async hover(filePath, line, character) {
    if (!this._initialized) return null;
    await this._openFile(filePath);
    const resp = await this._request("textDocument/hover", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    });
    if (!resp) return null;
    const contents = resp.contents;
    if (typeof contents === "string") return contents;
    if (contents?.value) return contents.value;
    if (Array.isArray(contents)) return contents.map((c) => c.value || c).join("\n");
    return JSON.stringify(contents);
  }

  /**
   * Get document symbols (functions, classes, variables, etc.)
   */
  async documentSymbols(filePath) {
    if (!this._initialized) return [];
    await this._openFile(filePath);
    const resp = await this._request("textDocument/documentSymbol", {
      textDocument: { uri: `file://${filePath}` },
    });
    return resp || [];
  }

  /**
   * Search workspace symbols by query.
   */
  async workspaceSymbols(query) {
    if (!this._initialized) return [];
    const resp = await this._request("workspace/symbol", { query });
    return resp || [];
  }

  /**
   * Get diagnostics (errors, warnings) for a file.
   */
  getDiagnostics(filePath) {
    const uri = `file://${filePath}`;
    return this._diagnostics.get(uri) || [];
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  _detectLanguage() {
    for (const [lang, config] of Object.entries(LANGUAGE_SERVERS)) {
      for (const marker of config.markers) {
        if (fs.existsSync(path.join(this.workspace, marker))) {
          return lang;
        }
      }
    }
    // Fallback: check most common file extensions
    try {
      const files = fs.readdirSync(this.workspace);
      for (const [lang, config] of Object.entries(LANGUAGE_SERVERS)) {
        if (files.some((f) => config.extensions.some((ext) => f.endsWith(ext)))) {
          return lang;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  _findCmd() {
    const config = this._config;
    try {
      // Use execFileSync to avoid shell injection — receives cmd as a safe argv element
      const whichCmd = process.platform === "win32" ? "where" : "which";
      execFileSync(whichCmd, [config.cmd], { stdio: "pipe", timeout: 5000 });
      return config.cmd;
    } catch {
      // Try fallback
      if (config.fallbackCmd) {
        try {
          const whichCmd = process.platform === "win32" ? "where" : "which";
          execFileSync(whichCmd, [config.fallbackCmd], { stdio: "pipe", timeout: 5000 });
          return config.fallbackCmd;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  _send(data) {
    if (this._process?.stdin?.writable) {
      this._process.stdin.write(typeof data === "string" ? data : data.raw);
    }
  }

  async _request(method, params, timeoutMs = 10000) {
    const msg = lspMessage(method, params);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._responseHandlers.delete(msg.id);
        resolve(null);
      }, timeoutMs);

      this._responseHandlers.set(msg.id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      this._send(msg);
    });
  }

  _onData(data) {
    this._buffer += data.toString();

    while (true) {
      const headerEnd = this._buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this._buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length: (\d+)/);
      if (!lengthMatch) {
        this._buffer = this._buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this._buffer.length < bodyStart + contentLength) break;

      const bodyStr = this._buffer.slice(bodyStart, bodyStart + contentLength);
      this._buffer = this._buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(bodyStr);
        this._handleMessage(message);
      } catch {
        // Ignore malformed messages
      }
    }
  }

  _handleMessage(message) {
    // Response to our request
    if (message.id !== undefined && this._responseHandlers.has(message.id)) {
      const handler = this._responseHandlers.get(message.id);
      this._responseHandlers.delete(message.id);
      handler(message.result || null);
      return;
    }

    // Notification from server
    if (message.method === "textDocument/publishDiagnostics") {
      const { uri, diagnostics } = message.params;
      this._diagnostics.set(uri, diagnostics);
    }
  }

  async _initialize() {
    const resp = await this._request("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { openClose: true, change: 1 },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
      rootUri: `file://${this.workspace}`,
      workspaceFolders: [{ uri: `file://${this.workspace}`, name: path.basename(this.workspace) }],
    });

    if (resp) {
      this._send(lspNotification("initialized", {}));
      this._initialized = true;
    }
  }

  _openedFiles = new Set();

  async _openFile(filePath) {
    const uri = `file://${filePath}`;
    if (this._openedFiles.has(uri)) return;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      this._send(
        lspNotification("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: this._config.languageId,
            version: 1,
            text: content,
          },
        })
      );
      this._openedFiles.add(uri);
    } catch {
      // File can't be read
    }
  }

  _normalizeLocations(result) {
    if (!result) return [];
    const locations = Array.isArray(result) ? result : [result];
    return locations.map((loc) => {
      const uri = loc.uri || loc.targetUri;
      const range = loc.range || loc.targetSelectionRange || loc.targetRange;
      const filePath = uri ? uri.replace("file://", "") : "";
      return {
        file: filePath,
        line: range ? range.start.line + 1 : 0,
        character: range ? range.start.character : 0,
        endLine: range ? range.end.line + 1 : 0,
      };
    });
  }
}

/**
 * Format LSP locations for display.
 */
export function formatLocations(locations) {
  if (!locations || locations.length === 0) return "No results found.";
  return locations
    .map((loc) => `${loc.file}:${loc.line}:${loc.character}`)
    .join("\n");
}

/**
 * Format document symbols for display.
 */
export function formatSymbols(symbols, indent = 0) {
  if (!symbols || symbols.length === 0) return "No symbols found.";

  const SYMBOL_KINDS = {
    1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
    6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
    11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
    15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
    20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
    25: "Operator", 26: "TypeParameter",
  };

  const lines = [];
  const prefix = "  ".repeat(indent);

  for (const sym of symbols) {
    const name = sym.name;
    const kind = SYMBOL_KINDS[sym.kind] || `Kind(${sym.kind})`;
    const range = sym.range || sym.location?.range;
    const line = range ? range.start.line + 1 : "?";
    const detail = sym.detail ? ` — ${sym.detail}` : "";

    lines.push(`${prefix}${kind} ${name} (line ${line})${detail}`);

    // Recurse into children (DocumentSymbol has children, SymbolInformation doesn't)
    if (sym.children && sym.children.length > 0) {
      lines.push(formatSymbols(sym.children, indent + 1));
    }
  }

  return lines.join("\n");
}
