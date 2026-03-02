// Mercury Code - Rollback / Undo System
// Tracks checkpoints at each user message and enables time-travel rollback.
// Supports two modes:
//   1. Full rollback: restore files AND conversation context
//   2. Context-only: restore conversation context only (keep file changes)

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { execSync, execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Validate a git ref to prevent command injection.
 * Only allows hex hashes, branch-like names, and common refs.
 */
function isValidGitRef(ref) {
  if (!ref || typeof ref !== "string") return false;
  return /^[a-fA-F0-9]+$/.test(ref) && ref.length >= 7 && ref.length <= 40;
}

/**
 * Checkpoint represents a snapshot at a specific point in the conversation.
 */
class Checkpoint {
  constructor({ index, timestamp, userMessage, messages, gitHash }) {
    this.index = index;        // sequential checkpoint index
    this.timestamp = timestamp; // Date.now()
    this.userMessage = userMessage; // the user's message text (for display)
    this.messages = messages;   // deep copy of conversation messages at this point
    this.gitHash = gitHash;     // git commit/stash hash for file state (if available)
  }
}

/**
 * RollbackManager tracks conversation checkpoints and enables undo.
 */
export class RollbackManager {
  constructor(cwd) {
    this.cwd = cwd;
    this.checkpoints = [];
    this._useGit = this._detectGit();
  }

  /**
   * Check if we're in a git repo.
   */
  _detectGit() {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.cwd,
        stdio: "pipe",
        encoding: "utf-8",
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current git HEAD hash (if in a git repo).
   */
  _getGitHash() {
    if (!this._useGit) return null;
    try {
      return execSync("git rev-parse HEAD", {
        cwd: this.cwd,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Create a checkpoint at the current state (called before each user message is processed).
   * @param {string} userMessage - The user's message text
   * @param {Array} messages - Current conversation messages (will be deep-cloned)
   */
  createCheckpoint(userMessage, messages) {
    const cp = new Checkpoint({
      index: this.checkpoints.length,
      timestamp: Date.now(),
      userMessage: userMessage.slice(0, 120),
      messages: JSON.parse(JSON.stringify(messages)),
      gitHash: this._getGitHash(),
    });
    this.checkpoints.push(cp);
    return cp;
  }

  /**
   * Get list of all checkpoints for display.
   * @returns {Array<{index, timestamp, userMessage, date}>}
   */
  getCheckpoints() {
    return this.checkpoints.map((cp) => ({
      index: cp.index,
      timestamp: cp.timestamp,
      date: new Date(cp.timestamp).toLocaleTimeString(),
      userMessage: cp.userMessage,
    }));
  }

  /**
   * Perform a full rollback: restore both files AND conversation.
   * @param {number} checkpointIndex - Index of the checkpoint to restore to
   * @returns {{ messages: Array, restored: boolean, fileRestored: boolean }}
   */
  fullRollback(checkpointIndex) {
    const cp = this.checkpoints[checkpointIndex];
    if (!cp) return { messages: null, restored: false, fileRestored: false };

    let fileRestored = false;

    // Attempt to restore git state
    if (this._useGit && cp.gitHash) {
      try {
        // Stash current changes first (safety net)
        try {
          execSync("git stash push -m 'mercury-rollback-backup' --include-untracked", {
            cwd: this.cwd,
            stdio: "pipe",
          });
        } catch {
          // Stash may fail if there are no changes; continue anyway
        }
        // Restore files to the checkpoint's commit state (use execFileSync to prevent injection)
        if (!isValidGitRef(cp.gitHash)) {
          throw new Error(`Invalid git hash: ${cp.gitHash}`);
        }
        execFileSync("git", ["checkout", cp.gitHash, "--", "."], {
          cwd: this.cwd,
          stdio: "pipe",
        });
        fileRestored = true;
      } catch {
        // File restore failed, but context restore can still proceed
      }
    }

    // Remove checkpoints after this one
    this.checkpoints = this.checkpoints.slice(0, checkpointIndex + 1);

    return {
      messages: JSON.parse(JSON.stringify(cp.messages)),
      restored: true,
      fileRestored,
    };
  }

  /**
   * Context-only rollback: restore conversation but keep files as-is.
   * @param {number} checkpointIndex - Index of the checkpoint to restore to
   * @returns {{ messages: Array, restored: boolean }}
   */
  contextRollback(checkpointIndex) {
    const cp = this.checkpoints[checkpointIndex];
    if (!cp) return { messages: null, restored: false };

    // Remove checkpoints after this one
    this.checkpoints = this.checkpoints.slice(0, checkpointIndex + 1);

    return {
      messages: JSON.parse(JSON.stringify(cp.messages)),
      restored: true,
    };
  }

  /**
   * Total number of checkpoints.
   */
  get count() {
    return this.checkpoints.length;
  }
}
