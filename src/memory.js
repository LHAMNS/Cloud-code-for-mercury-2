// Mercury Code - Persistent Memory Manager
// Manages .mercury/memory.md for long-term knowledge retention across compressions

import { readFile, writeFile, appendFile, mkdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { debugLog } from "./utils/debug-log.js";

const MEMORY_DIR = ".mercury";
const MEMORY_FILE = "memory.md";
const MAX_MEMORY_SIZE = 80000; // ~22K tokens max for memory file

export class MemoryManager {
  /**
   * @param {string} cwd - Working directory
   * @param {object} [opts]
   * @param {string} [opts.dir] - Direct directory path (skips appending .mercury)
   */
  constructor(cwd, opts = {}) {
    this.dir = opts.dir || path.join(cwd, MEMORY_DIR);
    this.filePath = path.join(this.dir, MEMORY_FILE);
    this._writeQueue = Promise.resolve();
  }

  /**
   * Read the current memory file content. Returns empty string if not exists.
   */
  async read() {
    try {
      return await readFile(this.filePath, "utf-8");
    } catch (err) {
      debugLog("MemoryManager.read", err);
      return "";
    }
  }

  /**
   * Append new facts to the memory file.
   * Deduplicates by avoiding adding text that's already present.
   */
  async append(newContent) {
    if (!newContent || !newContent.trim()) return;

    return this._enqueueWrite(async () => {
      await mkdir(this.dir, { recursive: true });

      let existing = await this.read();
      const normalizedNewContent = newContent.trim();

      if (existing.includes(normalizedNewContent)) {
        return;
      }

      // If memory is getting too large, trim the oldest section
      if (existing.length + normalizedNewContent.length > MAX_MEMORY_SIZE) {
        existing = this._trimOldest(existing, normalizedNewContent.length);
      }

      const separator = existing ? "\n\n---\n\n" : "";
      const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      const block = `<!-- ${timestamp} -->\n${normalizedNewContent}`;

      await this._atomicWrite(this.filePath, existing + separator + block);
    });
  }

  /**
   * Replace the entire memory file with new content.
   */
  async write(content) {
    return this._enqueueWrite(async () => {
      await mkdir(this.dir, { recursive: true });
      await this._atomicWrite(this.filePath, content);
    });
  }

  /**
   * Write to a temp file then atomically rename — prevents corruption on crash/disk-full.
   */
  async _atomicWrite(filePath, content) {
    const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
    try {
      await writeFile(tmpPath, content, "utf-8");
      await rename(tmpPath, filePath);
    } catch (err) {
      try { await unlink(tmpPath); } catch (err2) { debugLog("MemoryManager._atomicWrite.cleanup", err2); }
      throw err;
    }
  }

  /**
   * Trim the oldest entries to make room for new content.
   */
  _trimOldest(existing, needSpace) {
    const sections = existing.split("\n\n---\n\n");
    while (
      sections.length > 1 &&
      sections.join("\n\n---\n\n").length + needSpace > MAX_MEMORY_SIZE
    ) {
      sections.shift();
    }
    return sections.join("\n\n---\n\n");
  }

  _enqueueWrite(task) {
    const run = this._writeQueue.then(task, task);
    this._writeQueue = run.catch(() => {});
    return run;
  }
}

/**
 * Conversation log - saves full raw conversation to .mercury/conversation.jsonl
 * The model can Read this file to recover exact details from earlier turns.
 */
export class ConversationLog {
  /**
   * @param {string} cwd - Working directory
   * @param {object} [opts]
   * @param {string} [opts.dir] - Direct directory path (skips appending .mercury)
   * @param {string} [opts.trustMode] - Trust mode; when 'readonly' or 'plan', logging is disabled
   */
  constructor(cwd, opts = {}) {
    this.dir = opts.dir || path.join(cwd, MEMORY_DIR);
    this.filePath = path.join(this.dir, "conversation.jsonl");
    this._writeQueue = Promise.resolve();
    this._logEnabled = opts.trustMode !== 'readonly' && opts.trustMode !== 'plan';
  }

  /**
   * Append a message to the log file. Each line is a JSON object.
   * In readonly/plan mode, logging is silently skipped to avoid dirtying the repo.
   */
  async append(message) {
    if (!this._logEnabled) return;
    return this._enqueueWrite(async () => {
      await mkdir(this.dir, { recursive: true });
      const line = JSON.stringify({ ts: Date.now(), ...message }) + "\n";
      try {
        await appendFile(this.filePath, line, "utf-8");
      } catch (err) {
        debugLog("ConversationLog.append", err);
      }
    });
  }

  /**
   * Clear the log (e.g. on /clear).
   */
  async clear() {
    return this._enqueueWrite(async () => {
      try {
        const tmpPath = this.filePath + '.tmp.' + randomBytes(4).toString('hex');
        await writeFile(tmpPath, "", "utf-8");
        await rename(tmpPath, this.filePath);
      } catch (err) {
        debugLog("ConversationLog.clear", err);
      }
    });
  }

  _enqueueWrite(task) {
    const run = this._writeQueue.then(task, task);
    this._writeQueue = run.catch(() => {});
    return run;
  }
}
