// Mercury Code - Session History Manager
// Saves and restores complete conversation sessions for backup and time-travel

import { readFile, writeFile, readdir, mkdir, rm, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { debugLog } from "./utils/debug-log.js";

const SESSIONS_DIR = path.join(homedir(), ".mercury", "sessions");
const MAX_SESSIONS = 50; // keep at most 50 sessions

/**
 * Redact common secret patterns from session summary text.
 * Prevents API keys, tokens, passwords, and other credentials from
 * being exposed in the /history list.
 * @param {string} text - Raw summary text
 * @returns {string} Sanitized text with secrets redacted
 */
function sanitizeSummary(text) {
  return text
    .replace(/(?:sk|pk|api|key|token|secret|password|bearer)[-_]?[a-zA-Z0-9]{16,}/gi, '[REDACTED]')
    .replace(/(?:eyJ)[A-Za-z0-9+/=]{20,}/g, '[JWT-REDACTED]')
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g, '[GITHUB-TOKEN-REDACTED]')
    .replace(/(?:xox[bpsa])-[A-Za-z0-9-]{10,}/g, '[SLACK-TOKEN-REDACTED]');
}

/**
 * SessionHistory manages saved conversation sessions.
 * Each session is stored as a JSON file in ~/.mercury/sessions/
 */
export class SessionHistory {
  constructor(options = {}) {
    this.dir = options.dir || SESSIONS_DIR;
  }

  /**
   * Ensure the sessions directory exists.
   */
  async _ensureDir() {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Save the current session to a file.
   * @param {object} session
   * @param {string} session.id - Unique session ID
   * @param {string} session.cwd - Working directory
   * @param {Array} session.messages - Conversation messages
   * @param {object} session.config - Model config snapshot
   * @param {string} [session.summary] - Optional session summary
   * @returns {string} Path to saved session file
   */
  async save(session) {
    await this._ensureDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${ts}_${session.id}.json`;
    const filepath = path.join(this.dir, filename);

    const data = {
      id: session.id,
      cwd: session.cwd,
      timestamp: Date.now(),
      date: new Date().toISOString(),
      messageCount: session.messages.length,
      summary: session.summary || this._autoSummary(session.messages),
      messages: session.messages,
      config: session.config || {},
      trustMode: session.trustMode || null,
      planMode: session.planMode || false,
      sandbox: session.sandbox || null,
    };

    const tmpPath = filepath + '.tmp-' + Date.now();
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await rename(tmpPath, filepath);
    } catch (err) {
      try { await unlink(tmpPath); } catch {}
      throw err;
    }
    await this._pruneOld();
    return filepath;
  }

  /**
   * Auto-generate a short summary from the first user message.
   */
  _autoSummary(messages) {
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser || !firstUser.content) return "(empty session)";
    const text = firstUser.content.slice(0, 80);
    const raw = text.length < firstUser.content.length ? text + "..." : text;
    return sanitizeSummary(raw);
  }

  /**
   * List all saved sessions, sorted by most recent first.
   * @returns {Array<{id, date, messageCount, summary, filename}>}
   */
  async list() {
    await this._ensureDir();
    let files;
    try {
      files = await readdir(this.dir);
    } catch (err) {
      debugLog("SessionHistory.list.readdir", err);
      return [];
    }

    const sessions = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.dir, f), "utf-8");
        const data = JSON.parse(raw);
        sessions.push({
          id: data.id,
          date: data.date,
          timestamp: data.timestamp,
          messageCount: data.messageCount,
          summary: data.summary,
          cwd: data.cwd,
          filename: f,
        });
      } catch (err) {
        debugLog("SessionHistory.list.parseSession", err);
      }
    }

    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  /**
   * Load a session by index (from the list) or by filename.
   * @param {string} identifier - Session index (1-based) or filename
   * @returns {object|null} Full session data
   */
  async load(identifier) {
    const sessions = await this.list();

    let session;
    const idx = parseInt(identifier, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      session = sessions[idx - 1];
    } else {
      session = sessions.find(
        (s) => s.filename === identifier || s.id === identifier
      );
    }

    if (!session) return null;

    let raw;
    try {
      raw = await readFile(
        path.join(this.dir, session.filename),
        "utf-8"
      );
      return JSON.parse(raw);
    } catch (err) {
      debugLog("SessionHistory.load", err);
      return null;
    }
  }

  /**
   * Delete old sessions beyond MAX_SESSIONS.
   */
  async _pruneOld() {
    const sessions = await this.list();
    if (sessions.length <= MAX_SESSIONS) return;

    const toDelete = sessions.slice(MAX_SESSIONS);
    for (const s of toDelete) {
      try {
        await rm(path.join(this.dir, s.filename));
      } catch (err) {
        debugLog("SessionHistory._pruneOld", err);
      }
    }
  }
}
