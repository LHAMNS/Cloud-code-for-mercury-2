import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeEnv } from "./utils/env-sanitize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WEB_CHILD_PATH = path.join(__dirname, "web-child.js");
const UI_DIR = path.join(__dirname, "web-ui");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const MAX_SESSIONS = 8;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_BACKLOG = 200;
const MAX_BACKLOG_BYTES = 2 * 1024 * 1024; // 2MB
const SESSION_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15000;
const AUTH_HEADER = "x-mercury-web-token";
const ORPHAN_GRACE_MS = 60_000;
const IDLE_REAP_INTERVAL_MS = 60_000;

function _setSecurityHeaders(res, isHtml = false) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (isHtml) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'"
    );
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  _setSecurityHeaders(res, false);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  _setSecurityHeaders(res, false);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function createSseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });

    req.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUiPath(urlPath) {
  if (urlPath.indexOf("\0") !== -1) return null;
  const pathname = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.resolve(UI_DIR, `.${pathname}`);
  const indexPath = path.join(UI_DIR, "index.html");
  if (resolved === indexPath || resolved.startsWith(UI_DIR + path.sep)) {
    // Follow symlinks and verify the real path is still within UI_DIR
    // to prevent symlink escape attacks.
    try {
      const real = fs.realpathSync(resolved);
      const realUiDir = fs.realpathSync(UI_DIR);
      if (real !== realUiDir && !real.startsWith(realUiDir + path.sep)) {
        return null; // Symlink points outside UI directory
      }
      return real;
    } catch {
      // File doesn't exist yet or can't be resolved — reject for safety
      return null;
    }
  }
  return null;
}

function clampWorkspace(rootWorkspace, requested) {
  if (!requested) return rootWorkspace;
  try {
    const realRoot = fs.realpathSync(rootWorkspace);
    const resolved = path.resolve(rootWorkspace, requested);
    const realRequested = fs.realpathSync(resolved);
    if (realRequested === realRoot || realRequested.startsWith(realRoot + path.sep)) {
      return resolved;
    }
    return rootWorkspace;
  } catch {
    return rootWorkspace; // If realpath fails (e.g. path doesn't exist), stay safe
  }
}

function getOpenCommand(url) {
  if (process.platform === "win32") {
    return [{ cmd: "cmd", args: ["/c", "start", "", url] }];
  }
  if (process.platform === "darwin") {
    return [{ cmd: "open", args: [url] }];
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return [
      { cmd: "cmd.exe", args: ["/c", "start", "", url] },
      { cmd: "powershell.exe", args: ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`] },
      { cmd: "xdg-open", args: [url] },
    ];
  }
  return [
    { cmd: "xdg-open", args: [url] },
  ];
}

function getCliSpawnConfig(options = {}) {
  return {
    command: process.execPath,
    args: [WEB_CHILD_PATH],
    usesPtyWrapper: false,
  };
}

class WebCliSession {
  constructor(options) {
    this.id = options.id;
    this.workspace = options.workspace;
    this.trustMode = options.trustMode || "approval";
    this.sandboxMode = options.sandboxMode || "on";
    this.verbose = options.verbose === true;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.closedAt = null;
    this.status = "starting";
    this.exitCode = null;
    this.exitSignal = null;
    this.pid = null;
    this.clients = new Set();
    this.backlog = [];
    this._seq = 0;
    this._reapTimer = null;
    this._orphanTimer = null;
    this._childExited = false;
    this._closing = false;
    this.provider = options.provider || "mercury";
    this.model = options.model || null;
    this.onReap = options.onReap || null;
    this.bootstrapInput = options.bootstrapInput ?? null;
    this.sessionHistoryDir = options.sessionHistoryDir || path.join(this.workspace, ".mercury", "web-sessions", this.id, "history");

    const spawnConfig = getCliSpawnConfig({
      workspace: this.workspace,
      trustMode: this.trustMode,
      sandboxMode: this.sandboxMode,
      verbose: this.verbose,
    });
    this.child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: this.workspace,
      env: {
        ...sanitizeEnv(),
        ...(options.childEnv || {}),
        MERCURY_WEB_CHILD: "1",
        MERCURY_WORKSPACE: this.workspace,
        MERCURY_TRUST_MODE: this.trustMode,
        MERCURY_SANDBOX_MODE: this.sandboxMode,
        MERCURY_VERBOSE: this.verbose ? "1" : "0",
        MERCURY_HISTORY_DIR: this.sessionHistoryDir,
        FORCE_COLOR: process.env.FORCE_COLOR || "1",
        TERM: process.env.TERM || "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    this.pid = this.child.pid;
    this.status = "running";
    this._emit("status", this.snapshot());
    this._wireChildStreams();

    if (this.bootstrapInput) {
      this.child.stdin.write(this.bootstrapInput);
    }
  }

  _scheduleReap() {
    if (this._reapTimer) return;
    this._reapTimer = setTimeout(() => {
      this.close("Session TTL expired");
    }, SESSION_TTL_MS);
    this._reapTimer.unref?.();
  }

  _scheduleOrphanKill() {
    if (this._orphanTimer) return;
    this._orphanTimer = setTimeout(() => {
      this._orphanTimer = null;
      if (this.clients.size === 0) {
        this.close("No connected clients (orphan timeout)");
      }
    }, ORPHAN_GRACE_MS);
    this._orphanTimer.unref?.();
  }

  _cancelOrphanKill() {
    if (this._orphanTimer) {
      clearTimeout(this._orphanTimer);
      this._orphanTimer = null;
    }
  }

  _wireChildStreams() {
    this.child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "stdout" || message.type === "stderr") {
        this._emit(message.type, {
          seq: ++this._seq,
          text: String(message.text || ""),
          ts: Date.now(),
        });
      }
    });

    this.child.stdout.on("data", (chunk) => {
      this._emit("stdout", {
        seq: ++this._seq,
        text: chunk.toString("utf-8"),
        ts: Date.now(),
      });
    });

    this.child.stderr.on("data", (chunk) => {
      this._emit("stderr", {
        seq: ++this._seq,
        text: chunk.toString("utf-8"),
        ts: Date.now(),
      });
    });

    this.child.on("error", (err) => {
      this.status = "errored";
      this.closedAt = this.closedAt || Date.now();
      this._emit("error", {
        message: err.message,
        ts: this.closedAt,
      });
    });

    this.child.on("exit", (code, signal) => {
      if (this._childExited) return; // prevent double-reap
      this._childExited = true;
      this.status = code === 0 ? "exited" : "errored";
      this.closedAt = this.closedAt || Date.now();
      this.exitCode = code;
      this.exitSignal = signal;
      this._emit("exit", {
        code,
        signal,
        ts: this.closedAt,
      });
      this._emit("status", this.snapshot());
      // Child has actually exited — now safe to remove from session map
      this.onReap?.(this.id);
    });
  }

  _remember(payload) {
    this.backlog.push(payload);
    // Prune by count
    while (this.backlog.length > MAX_BACKLOG) {
      this.backlog.shift();
    }
    // Prune by byte size (prevents memory bloat from large payloads)
    let totalSize = 0;
    for (let i = this.backlog.length - 1; i >= 0; i--) {
      totalSize += JSON.stringify(this.backlog[i]).length;
      if (totalSize > MAX_BACKLOG_BYTES) {
        this.backlog.splice(0, i + 1);
        break;
      }
    }
  }

  _emit(type, payload) {
    this.lastActivityAt = Date.now();
    const packetPayload = {
      type,
      sessionId: this.id,
      ...payload,
    };
    this._remember(packetPayload);
    const packet = createSseEvent(packetPayload);
    for (const client of [...this.clients]) {
      if (!this._writeClientPacket(client, packet)) this._detachClient(client);
    }
  }

  attach(res) {
    this._cancelOrphanKill();
    _setSecurityHeaders(res, false);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (!this._writeClientPacket(res, ": connected\n\n")) {
      this._detachClient(res);
      return;
    }
    if (!this._writeClientPacket(res, createSseEvent({
      type: "status",
      ...this.snapshot(),
    }))) {
      this._detachClient(res);
      return;
    }

    // Replay backlog asynchronously in chunks to avoid freezing the event loop
    this._replayBacklog(res).then(() => {
      this.clients.add(res);
      res._heartbeat = setInterval(() => {
        if (!this._writeClientPacket(res, ": heartbeat\n\n")) {
          this._detachClient(res);
        }
      }, HEARTBEAT_MS);
      res._heartbeat.unref?.();

      const cleanup = () => this._detachClient(res);
      res.on("close", cleanup);
      res.on("error", cleanup);
      res.on("finish", cleanup);
    });
  }

  async _replayBacklog(res) {
    const CHUNK_SIZE = 20;
    for (let i = 0; i < this.backlog.length; i += CHUNK_SIZE) {
      const chunk = this.backlog.slice(i, i + CHUNK_SIZE);
      for (const payload of chunk) {
        if (!this._writeClientPacket(res, createSseEvent(payload))) {
          this._detachClient(res);
          return;
        }
      }
      // Yield to event loop between chunks to prevent freeze
      if (i + CHUNK_SIZE < this.backlog.length) {
        await new Promise(r => setImmediate(r));
      }
    }
  }

  sendInput(text, mode = "line") {
    if (!this.child || this.child.killed || this.closedAt || !this.child.connected) {
      throw new Error("Session is not accepting input");
    }

    const normalized = String(text ?? "").replace(/\r\n/g, "\n");
    this.child.send({
      type: "input",
      text: normalized,
      mode: mode === "multiline" || normalized.includes("\n") ? "multiline" : mode,
    });

    this._emit("input", {
      seq: ++this._seq,
      mode,
      text: normalized,
      ts: Date.now(),
    });
  }

  interrupt() {
    if (!this.child || this.child.killed || this.closedAt) return false;
    try {
      return this.child.kill("SIGINT");
    } catch {
      try {
        this.child.stdin.write("\u0003");
        return true;
      } catch {
        return false;
      }
    }
  }

  close(reason = "Session closed from web UI") {
    if (this._closing || this._childExited) return;
    if (!this.child || this.child.killed) {
      // Child already dead but exit event may not have fired yet.
      // If it already has (_childExited), we returned above.
      // Otherwise let the exit handler handle cleanup.
      return;
    }
    this._closing = true;
    if (this._reapTimer) {
      clearTimeout(this._reapTimer);
      this._reapTimer = null;
    }
    this._cancelOrphanKill();
    this._emit("notice", {
      seq: ++this._seq,
      label: "Session",
      message: reason,
      ts: Date.now(),
    });
    try {
      this.child.disconnect();
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (this.child && !this.child.killed) {
        this.child.kill("SIGTERM");
      }
    }, 250).unref?.();
    setTimeout(() => {
      if (this.child && !this.child.killed) {
        this.child.kill("SIGKILL");
      }
    }, 5000).unref?.();
    for (const client of [...this.clients]) {
      this._detachClient(client, "event: close\ndata: " + JSON.stringify({ reason }) + "\n\n");
    }
  }

  _writeClientPacket(res, packet) {
    if (!res || res.destroyed || res.writableEnded) return false;
    try {
      res.write(packet);
      return true;
    } catch {
      return false;
    }
  }

  _detachClient(res, finalPacket = "") {
    if (!res) return;
    if (res._heartbeat) {
      clearInterval(res._heartbeat);
      res._heartbeat = null;
    }
    this.clients.delete(res);
    if (!res.destroyed && !res.writableEnded) {
      try {
        if (finalPacket) res.write(finalPacket);
        res.end();
      } catch {
        try { res.destroy(); } catch { /* non-critical */ }
      }
    }
    if (this.clients.size === 0) {
      this._scheduleOrphanKill();
    }
  }

  snapshot() {
    return {
      sessionId: this.id,
      id: this.id,
      mode: "web",
      workspace: this.workspace,
      trustMode: this.trustMode,
      sandbox: this.sandboxMode,
      provider: this.provider,
      model: this.model || "mercury-2",
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      closedAt: this.closedAt,
      status: this.status,
      connected: !this.closedAt && !this.child.killed,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      pid: this.pid,
      backlogSize: this.backlog.length,
    };
  }
}

export class MercuryWebServer {
  constructor(options = {}) {
    // Security: reject 0.0.0.0 binding — force loopback only to prevent LAN exposure
    const requestedHost = options.host ?? "127.0.0.1";
    if (requestedHost === "0.0.0.0" || requestedHost === "::") {
      console.warn("[Mercury Web] Warning: binding to 0.0.0.0 is blocked for security. Using 127.0.0.1 instead.");
    }
    this.host = (requestedHost === "0.0.0.0" || requestedHost === "::") ? "127.0.0.1" : requestedHost;
    this.port = Number(options.port ?? 0);
    this.workspace = options.workspace || process.cwd();
    this.trustMode = options.trustMode || "approval";
    this.sandboxMode = options.sandboxMode || "on";
    this.verbose = options.verbose === true;
    this.autoOpen = options.autoOpen !== false;
    this.childEnv = options.childEnv || {};
    this.provider = options.provider || "mercury";
    this.model = options.model || null;
    this.maxSessions = options.maxSessions || MAX_SESSIONS;
    this.authToken = randomUUID();
    this.sessions = new Map();
    this.server = http.createServer(this._handleRequest.bind(this));

    this._idleReapInterval = setInterval(() => {
      const now = Date.now();
      for (const [, session] of this.sessions) {
        if (session.clients.size === 0 && (now - session.lastActivityAt) >= SESSION_TTL_MS) {
          session.close("Idle session reaped");
        }
      }
    }, IDLE_REAP_INTERVAL_MS);
    this._idleReapInterval.unref?.();
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  get launchUrl() {
    // SECURITY NOTE: The auth token is passed via URL fragment (#token=...) so it
    // is not sent to the server in HTTP requests. However, it persists in browser
    // history and the address bar. The web UI frontend MUST clear location.hash
    // immediately after reading the token (e.g. history.replaceState) to minimise
    // exposure via shoulder-surfing or history inspection.
    return `${this.url}/#token=${encodeURIComponent(this.authToken)}`;
  }

  _allowedOriginHosts() {
    const hosts = new Set([this.host]);
    if (this.host === "127.0.0.1" || this.host === "0.0.0.0") {
      hosts.add("localhost");
      hosts.add("127.0.0.1");
    }
    if (this.host === "::1" || this.host === "[::1]") {
      hosts.add("localhost");
      hosts.add("::1");
      hosts.add("[::1]");
    }
    return hosts;
  }

  _hasValidToken(req) {
    const headerToken = req.headers[AUTH_HEADER];
    return headerToken === this.authToken;
  }

  _isTrustedOrigin(req) {
    const originHeader = req.headers.origin || req.headers.referer;
    // If no Origin/Referer, only trust if the Host header passed validation
    // (which it always has at this point since _handleRequest checks it first).
    // For non-GET requests, require an explicit Origin to prevent CSRF via
    // no-referrer policies or cross-origin form submissions.
    if (!originHeader) {
      // GET requests (SSE, status checks) are safe since they don't mutate state
      // beyond what the token already authorizes. POST/DELETE require Origin.
      return req.method === "GET";
    }
    try {
      const parsed = new URL(originHeader);
      const allowedHosts = this._allowedOriginHosts();
      const expectedPort = String(this.port);
      return allowedHosts.has(parsed.hostname) && parsed.port === expectedPort;
    } catch {
      return false;
    }
  }

  _isAuthorized(req, url) {
    return this._hasValidToken(req) && this._isTrustedOrigin(req);
  }

  _isAuthorizedBeaconClose(req, body = {}) {
    if (body?.token !== this.authToken) return false;
    const originHeader = req.headers.origin || req.headers.referer;
    if (!originHeader) {
      // Keep sendBeacon compatibility when browsers omit Origin/Referer.
      return true;
    }
    return this._isTrustedOrigin(req);
  }

  async openBrowser() {
    const candidates = getOpenCommand(this.launchUrl);

    for (const candidate of candidates) {
      const opened = await new Promise((resolve) => {
        let settled = false;
        try {
          const child = spawn(candidate.cmd, candidate.args, {
            detached: true,
            stdio: "ignore",
          });

          child.once("spawn", () => {
            if (settled) return;
            settled = true;
            child.unref();
            resolve(true);
          });
          child.once("error", () => {
            if (settled) return;
            settled = true;
            resolve(false);
          });
        } catch {
          resolve(false);
        }
      });

      if (opened) {
        return true;
      }
    }

    return false;
  }

  async close() {
    if (this._idleReapInterval) {
      clearInterval(this._idleReapInterval);
      this._idleReapInterval = null;
    }
    const exits = [...this.sessions.values()].map(s =>
      new Promise(r => {
        s.child?.once("exit", r);
        setTimeout(r, 6000);
        s.close("Server shutting down");
      })
    );
    await Promise.allSettled(exits);
    await new Promise((resolve) => this.server.close(resolve));
    this.sessions.clear();
  }

  _createSession(body = {}) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum ${this.maxSessions} web sessions reached`);
    }

    const sessionId = randomUUID();
    const session = new WebCliSession({
      id: sessionId,
      workspace: clampWorkspace(this.workspace, body.workspace),
      trustMode: this.trustMode,
      sandboxMode: this.sandboxMode,
      verbose: this.verbose,
      provider: this.provider,
      model: this.model,
      childEnv: { ...this.childEnv },
      sessionHistoryDir: path.join(this.workspace, ".mercury", "web-sessions", sessionId, "history"),
      onReap: (sessionId) => {
        this.sessions.delete(sessionId);
      },
    });
    this.sessions.set(session.id, session);
    return session;
  }

  _getSession(id) {
    return this.sessions.get(id) || null;
  }

  async _serveStatic(urlPath, res) {
    const filePath = resolveUiPath(urlPath);
    if (!filePath) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    try {
      const payload = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      _setSecurityHeaders(res, ext === ".html");
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60",
      });
      res.end(payload);
    } catch {
      sendJson(res, 404, { error: "Static asset not found" });
    }
  }

  async _handleRequest(req, res) {
    // ── DNS Rebinding defense: validate Host header ───────────────────────
    // An attacker can rebind their domain to 127.0.0.1, but the Host header
    // will still carry the attacker's domain. Block any request whose Host
    // is not in the allowed set (localhost / 127.0.0.1 / [::1]).
    const hostHeader = (req.headers.host || "").replace(/:\d+$/, "");
    if (!this._allowedOriginHosts().has(hostHeader)) {
      sendJson(res, 403, { error: "Forbidden: invalid Host header" });
      return;
    }

    const url = new URL(req.url, this.url);
    const pathname = url.pathname;

    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      await this._serveStatic(pathname, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      if (!this._isAuthorized(req, url)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        url: this.url,
        sessions: this.sessions.size,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/meta") {
      if (!this._isAuthorized(req, url)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, {
        mode: "web",
        workspace: this.workspace,
        trustMode: this.trustMode,
        sandbox: this.sandboxMode,
        provider: this.provider,
        model: this.model || "mercury-2",
        url: this.url,
        sessions: [...this.sessions.values()].map((session) => session.snapshot()),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      if (!this._isAuthorized(req, url)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, {
        sessions: [...this.sessions.values()].map((session) => session.snapshot()),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions") {
      if (!this._isAuthorized(req, url)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const session = this._createSession(body);
        sendJson(res, 201, {
          ...session.snapshot(),
          eventsUrl: `/api/sessions/${session.id}/events`,
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) {
      sendJson(res, 404, { error: "Unknown route" });
      return;
    }

    const [, sessionId, action] = match;

    // beacon-close uses token in the POST body (navigator.sendBeacon cannot set headers)
    if (req.method === "POST" && action === "beacon-close") {
      try {
        const body = await readJsonBody(req);
        if (!this._isAuthorizedBeaconClose(req, body)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        const beaconSession = this._getSession(sessionId);
        if (beaconSession) {
          beaconSession.close("Browser tab closed (beacon)");
        }
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { error: "Bad request" });
      }
      return;
    }

    if (!this._isAuthorized(req, url)) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    // GET /api/sessions/:id/status - used by client to check if session is alive
    if (req.method === "GET" && action === "status") {
      const statusSession = this._getSession(sessionId);
      if (!statusSession) {
        sendJson(res, 200, { alive: false });
      } else {
        sendJson(res, 200, { alive: true, ...statusSession.snapshot() });
      }
      return;
    }

    const session = this._getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    if (req.method === "GET" && !action) {
      sendJson(res, 200, session.snapshot());
      return;
    }

    if (req.method === "GET" && (action === "events" || action === "stream")) {
      session.attach(res);
      return;
    }

    if (req.method === "POST" && action === "input") {
      try {
        const body = await readJsonBody(req);
        session.sendInput(body.text || body.chars || "", body.mode || "line");
        sendJson(res, 202, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === "POST" && action === "interrupt") {
      sendJson(res, 200, { ok: session.interrupt() });
      return;
    }

    if (req.method === "DELETE" && !action) {
      session.close();
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  }
}

export async function startWebServer(options = {}) {
  const server = new MercuryWebServer(options);
  await server.listen();
  return server;
}
