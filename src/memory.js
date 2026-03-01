// Mercury Code - Persistent Memory Manager
// Manages .mercury/memory.md for long-term knowledge retention across compressions

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const MEMORY_DIR = ".mercury";
const MEMORY_FILE = "memory.md";
const MAX_MEMORY_SIZE = 80000; // ~22K tokens max for memory file

export class MemoryManager {
  constructor(cwd) {
    this.dir = path.join(cwd, MEMORY_DIR);
    this.filePath = path.join(this.dir, MEMORY_FILE);
  }

  /**
   * Read the current memory file content. Returns empty string if not exists.
   */
  async read() {
    try {
      return await readFile(this.filePath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Append new facts to the memory file.
   * Deduplicates by avoiding adding text that's already present.
   */
  async append(newContent) {
    if (!newContent || !newContent.trim()) return;

    await mkdir(this.dir, { recursive: true });

    let existing = await this.read();

    // If memory is getting too large, trim the oldest section
    if (existing.length + newContent.length > MAX_MEMORY_SIZE) {
      existing = this._trimOldest(existing, newContent.length);
    }

    const separator = existing ? "\n\n---\n\n" : "";
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const block = `<!-- ${timestamp} -->\n${newContent.trim()}`;

    await writeFile(this.filePath, existing + separator + block, "utf-8");
  }

  /**
   * Replace the entire memory file with new content.
   */
  async write(content) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath, content, "utf-8");
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
}

/**
 * Conversation log - saves full raw conversation to .mercury/conversation.jsonl
 * The model can Read this file to recover exact details from earlier turns.
 */
export class ConversationLog {
  constructor(cwd) {
    this.dir = path.join(cwd, MEMORY_DIR);
    this.filePath = path.join(this.dir, "conversation.jsonl");
  }

  /**
   * Append a message to the log file. Each line is a JSON object.
   */
  async append(message) {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...message }) + "\n";
    try {
      const existing = await readFile(this.filePath, "utf-8").catch(() => "");
      await writeFile(this.filePath, existing + line, "utf-8");
    } catch {
      // non-critical
    }
  }

  /**
   * Clear the log (e.g. on /clear).
   */
  async clear() {
    try {
      await writeFile(this.filePath, "", "utf-8");
    } catch {
      // non-critical
    }
  }
}
