import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

process.env.INCEPTION_API_KEY = process.env.INCEPTION_API_KEY || "test-key-for-unit-tests";

import { MercuryWebServer } from "../src/web-server.js";

function waitFor(predicate, timeoutMs = 10000, intervalMs = 50) {
  const timeoutAt = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }

      if (Date.now() >= timeoutAt) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("Mercury web server", () => {
  let tempRoot;
  let webServer;
  let sessions;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "mercury-web-server-"));
    await mkdir(tempRoot, { recursive: true });
    sessions = [];
  });

  afterEach(async () => {
    for (const session of sessions) {
      try { session.close("test teardown"); } catch { /* ignore */ }
    }
    if (webServer) {
      await webServer.close().catch(() => {});
      webServer = null;
    }
    // On Windows, spawned child processes may hold file handles briefly
    // after being killed. Wait and retry to avoid EBUSY during cleanup.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code === "EBUSY" && attempt < 2) {
          await new Promise((r) => setTimeout(r, 500));
        }
        // Ignore cleanup errors on last attempt — non-critical
      }
    }
  });

  it("ships the browser UI assets", async () => {
    const uiRoot = path.join(process.cwd(), "src", "web-ui");
    await access(path.join(uiRoot, "index.html"), fsConstants.R_OK);
    await access(path.join(uiRoot, "app.js"), fsConstants.R_OK);
    await access(path.join(uiRoot, "styles.css"), fsConstants.R_OK);
  });

  it("creates managed CLI child sessions with initial status backlog", async () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });

    const session = webServer._createSession();
    sessions.push(session);

    const statusEvent = await waitFor(() => session.backlog.find((entry) => entry.type === "status"));
    assert.equal(statusEvent.sessionId, session.id);
    assert.equal(statusEvent.workspace, tempRoot);
    assert.equal(statusEvent.sandbox, "on");
  });

  it("locks session trust and sandbox settings to server-side values", async () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "strict",
    });

    const session = webServer._createSession({
      trustMode: "open",
      sandboxMode: "off",
      childEnv: { MALICIOUS_OVERRIDE: "1" },
    });
    sessions.push(session);

    assert.equal(session.trustMode, "approval");
    assert.equal(session.sandboxMode, "strict");
  });

  it("allocates an isolated history directory per web session", async () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });

    const session = webServer._createSession();
    sessions.push(session);

    assert.match(session.sessionHistoryDir, new RegExp(`${session.id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
    assert.match(session.sessionHistoryDir, /\.mercury[\\/]web-sessions/);
  });

  it("preserves provider and model metadata for web sessions", async () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
      provider: "openai",
      model: "gpt-4o-mini",
    });

    const session = webServer._createSession();
    sessions.push(session);

    const statusEvent = await waitFor(() => session.backlog.find((entry) => entry.type === "status"));
    assert.equal(statusEvent.provider, "openai");
    assert.equal(statusEvent.model, "gpt-4o-mini");
  });

  it("requires both token and trusted origin for API authorization", () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });
    webServer.port = 43123;

    const authorizedReq = {
      headers: {
        "x-mercury-web-token": webServer.authToken,
        origin: "http://127.0.0.1:43123",
      },
    };
    const foreignOriginReq = {
      headers: {
        "x-mercury-web-token": webServer.authToken,
        origin: "http://evil.example:43123",
      },
    };
    const missingTokenReq = {
      headers: {
        origin: "http://127.0.0.1:43123",
      },
    };

    assert.equal(webServer._isAuthorized(authorizedReq, new URL("http://127.0.0.1:43123/api/sessions")), true);
    assert.equal(webServer._isAuthorized(foreignOriginReq, new URL("http://127.0.0.1:43123/api/sessions")), false);
    assert.equal(webServer._isAuthorized(missingTokenReq, new URL("http://127.0.0.1:43123/api/sessions")), false);
  });

  it("beacon-close rejects foreign origins but allows missing-origin sendBeacon requests", () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });
    webServer.port = 43123;

    const trustedBeaconReq = {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:43123",
      },
    };
    const foreignBeaconReq = {
      method: "POST",
      headers: {
        origin: "http://evil.example:43123",
      },
    };
    const originlessBeaconReq = {
      method: "POST",
      headers: {},
    };

    assert.equal(webServer._isAuthorizedBeaconClose(trustedBeaconReq, { token: webServer.authToken }), true);
    assert.equal(webServer._isAuthorizedBeaconClose(foreignBeaconReq, { token: webServer.authToken }), false);
    assert.equal(webServer._isAuthorizedBeaconClose(originlessBeaconReq, { token: webServer.authToken }), true);
  });

  it("streams real CLI output for slash commands", async () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });

    const session = webServer._createSession();
    sessions.push(session);

    session.sendInput("/status", "line");

    const outputEvent = await waitFor(() =>
      session.backlog.find((entry) => entry.type === "stdout" && /Status/.test(entry.text))
    );

    assert.match(outputEvent.text, /Status/);
  });

  it("runs child sessions in web bridge mode for multiline/editor guidance", async () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });

    const session = webServer._createSession();
    sessions.push(session);

    session.sendInput("/edit", "line");

    const bridgeEvent = await waitFor(() =>
      session.backlog.find((entry) => entry.type === "stdout" && /browser composer/i.test(entry.text))
    );

    assert.match(bridgeEvent.text, /browser composer/i);
  });

  it("uses fragment tokens for launch URLs instead of query parameters", () => {
    webServer = new MercuryWebServer({
      workspace: tempRoot,
      trustMode: "approval",
      sandboxMode: "on",
    });
    webServer.port = 43123;

    assert.match(webServer.launchUrl, /#token=/);
    assert.doesNotMatch(webServer.launchUrl, /\?token=/);
  });
});
