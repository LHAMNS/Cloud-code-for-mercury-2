// Mercury Code - Rollback / Undo System
// Tracks checkpoints at each user message and enables time-travel rollback.
// Supports two modes:
//   1. Full rollback: restore files AND conversation context
//   2. Context-only: restore conversation context only (keep file changes)

import { execSync, execFileSync } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { isValidGitHash } from "./utils/path-safety.js";
import { debugLog } from "./utils/debug-log.js";

const MAX_CHECKPOINTS = 10;

/**
 * Checkpoint represents a snapshot at a specific point in the conversation.
 * Stores only the message count (index into the live array) instead of
 * deep-cloning the entire conversation, drastically reducing memory usage.
 */
class Checkpoint {
  constructor({ id, index, timestamp, userMessage, messageCount, gitHash, messageFingerprint }) {
    this.id = id || crypto.randomUUID();
    this.index = index;             // sequential checkpoint index
    this.timestamp = timestamp;     // Date.now()
    this.userMessage = userMessage; // the user's message text (for display)
    this.messageCount = messageCount; // number of messages at this point (slice boundary)
    this.gitHash = gitHash;         // git commit/stash hash for file state (if available)
    this.messageFingerprint = messageFingerprint || null; // hash of last message for integrity verification
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
    } catch (err) {
      debugLog("RollbackManager._detectGit", err);
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
    } catch (err) {
      debugLog("RollbackManager._getGitHash", err);
      return null;
    }
  }

  /**
   * Create a checkpoint at the current state (called before each user message is processed).
   * Limits total checkpoints to MAX_CHECKPOINTS to control memory usage.
   * Stores only the message count as an incremental index rather than deep-cloning
   * the entire conversation array (the full clone is kept only for rollback operations).
   * @param {string} userMessage - The user's message text
   * @param {Array} messages - Current conversation messages (will be deep-cloned)
   */
  createCheckpoint(userMessage, messages) {
    // Enforce maximum checkpoint count — evict the oldest
    if (this.checkpoints.length >= MAX_CHECKPOINTS) {
      this.checkpoints.shift();
      // Re-index remaining checkpoints to fix index mismatch after eviction
      this.checkpoints.forEach((cp, i) => { cp.index = i; });
    }

    const cp = new Checkpoint({
      id: crypto.randomUUID(),
      index: this.checkpoints.length,
      timestamp: Date.now(),
      userMessage: userMessage.slice(0, 120),
      messageCount: messages.length,  // store count only — no deep clone
      gitHash: this._getGitHash(),
      messageFingerprint: this._fingerprint(messages.length > 0 ? messages[messages.length - 1] : null),
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
   * Uses the checkpoint's messageCount to slice the live messages array
   * instead of restoring a deep-cloned copy (saves significant memory).
   * @param {number} checkpointIndex - Index of the checkpoint to restore to
   * @param {Array} liveMessages - The current live messages array
   * @returns {{ messages: Array, restored: boolean, fileRestored: boolean }}
   */
  fullRollback(checkpointIndex, liveMessages) {
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
        } catch (err) {
          debugLog("RollbackManager.fullRollback.stash", err);
        }
        // Restore files to the checkpoint's commit state (use execFileSync to prevent injection)
        if (!isValidGitHash(cp.gitHash)) {
          throw new Error(`Invalid git hash: ${cp.gitHash}`);
        }
        execFileSync("git", ["checkout", cp.gitHash, "--", "."], {
          cwd: this.cwd,
          stdio: "pipe",
        });
        fileRestored = true;
      } catch (err) {
        debugLog("RollbackManager.fullRollback.checkout", err);
      }
    }

    // Remove checkpoints after this one
    this.checkpoints = this.checkpoints.slice(0, checkpointIndex + 1);

    // Find the correct rollback position using fingerprint verification.
    // If messages were inserted/deleted, messageCount alone may be wrong.
    const rollbackPos = this._findRollbackPosition(cp, liveMessages);
    const restored = liveMessages.slice(0, rollbackPos);

    return {
      messages: restored,
      restored: true,
      fileRestored,
    };
  }

  /**
   * Context-only rollback: restore conversation but keep files as-is.
   * Slices the live messages array to the checkpoint boundary.
   * @param {number} checkpointIndex - Index of the checkpoint to restore to
   * @param {Array} liveMessages - The current live messages array
   * @returns {{ messages: Array, restored: boolean }}
   */
  contextRollback(checkpointIndex, liveMessages) {
    const cp = this.checkpoints[checkpointIndex];
    if (!cp) return { messages: null, restored: false };

    // Remove checkpoints after this one
    this.checkpoints = this.checkpoints.slice(0, checkpointIndex + 1);

    // Find the correct rollback position using fingerprint verification.
    const rollbackPos = this._findRollbackPosition(cp, liveMessages);
    const restored = liveMessages.slice(0, rollbackPos);

    return {
      messages: restored,
      restored: true,
    };
  }

  /**
   * Compute a fingerprint of a message for integrity verification.
   * @param {object|null} message
   * @returns {string|null}
   */
  _fingerprint(message) {
    if (!message) return null;
    try {
      const data = JSON.stringify({
        role: message.role,
        content: typeof message.content === "string" ? message.content.slice(0, 200) : "",
      });
      return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
    } catch (err) {
      debugLog("RollbackManager._fingerprint", err);
      return null;
    }
  }

  /**
   * Find the correct rollback position in liveMessages for a checkpoint.
   * First verifies the message at the stored messageCount position matches
   * the stored fingerprint. If not (due to insert/delete), scans nearby
   * positions to find the matching message.
   * @param {Checkpoint} cp
   * @param {Array} liveMessages
   * @returns {number} The correct slice boundary
   */
  _findRollbackPosition(cp, liveMessages) {
    const count = cp.messageCount;
    const fp = cp.messageFingerprint;

    // If no fingerprint was stored, fall back to messageCount
    if (!fp) return Math.min(count, liveMessages.length);

    // Verify the message at position messageCount - 1 matches the fingerprint
    if (count > 0 && count <= liveMessages.length) {
      const candidateFp = this._fingerprint(liveMessages[count - 1]);
      if (candidateFp === fp) {
        return count; // Position matches, use stored count
      }
    }

    // Fingerprint mismatch — scan nearby positions to find the correct one.
    // Search outward from the stored position in both directions.
    const maxScan = Math.min(20, liveMessages.length);
    for (let offset = 1; offset <= maxScan; offset++) {
      // Check position before
      const before = count - 1 - offset;
      if (before >= 0 && before < liveMessages.length) {
        if (this._fingerprint(liveMessages[before]) === fp) {
          debugLog("RollbackManager._findRollbackPosition", `Fingerprint found at offset -${offset}`);
          return before + 1;
        }
      }
      // Check position after
      const after = count - 1 + offset;
      if (after >= 0 && after < liveMessages.length) {
        if (this._fingerprint(liveMessages[after]) === fp) {
          debugLog("RollbackManager._findRollbackPosition", `Fingerprint found at offset +${offset}`);
          return after + 1;
        }
      }
    }

    // Could not find matching fingerprint — fall back to messageCount
    // (clamped to current array length for safety)
    debugLog("RollbackManager._findRollbackPosition", "Fingerprint not found, falling back to messageCount");
    return Math.min(count, liveMessages.length);
  }

  /**
   * Total number of checkpoints.
   */
  get count() {
    return this.checkpoints.length;
  }
}
