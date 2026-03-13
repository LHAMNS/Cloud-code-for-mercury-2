// Mercury Code - Shared Path Safety Utilities
// Unified workspace boundary checks, symlink-safe resolution, and git ref validation.
// Used by: tools/executor.js, sandbox.js, repl.js, rollback.js
//
// All functions handle Windows path normalization (forward/back slashes, case-insensitive).

import path from "node:path";
import fs from "node:fs";

/**
 * Normalize a path for comparison: resolve to absolute, normalize separators,
 * and on Windows lowercase the entire path for case-insensitive comparison.
 * @param {string} p
 * @returns {string}
 */
function _normForCompare(p) {
  let resolved = path.resolve(p);
  // Normalize separators (Windows backslashes -> forward slashes -> native)
  resolved = path.normalize(resolved);
  // Case-insensitive on Windows
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/**
 * Unified workspace boundary check (symlink-safe).
 * Uses fs.realpathSync to resolve symlinks before comparison.
 * Falls back to path.resolve if realpath fails (e.g. workspace doesn't exist).
 * Supports Windows case-insensitive comparison and both slash types.
 *
 * @param {string} filePath  - Path to check
 * @param {string} workspace - Workspace root directory
 * @returns {boolean}
 */
export function isInWorkspace(filePath, workspace) {
  try {
    const resolvedWorkspace = _normForCompare(fs.realpathSync(workspace));
    let resolvedPath;
    try {
      resolvedPath = _normForCompare(fs.realpathSync(filePath));
    } catch {
      // File doesn't exist yet — walk up to nearest existing ancestor
      resolvedPath = _normForCompare(resolveViaAncestor(filePath));
    }
    return resolvedPath === resolvedWorkspace ||
      resolvedPath.startsWith(resolvedWorkspace + path.sep);
  } catch {
    // Workspace itself doesn't exist — fall back to strict path.resolve
    const resolvedPath = _normForCompare(filePath);
    const resolvedWorkspace = _normForCompare(workspace);
    return resolvedPath === resolvedWorkspace ||
      resolvedPath.startsWith(resolvedWorkspace + path.sep);
  }
}

/**
 * Resolve a non-existent path by finding the nearest existing ancestor,
 * resolving it through fs.realpathSync (following symlinks), then appending
 * the remaining path segments. This prevents symlink escape attacks where
 * a symlink inside the workspace points outside it.
 *
 * Example: /workspace/evil-link/file.txt where evil-link -> /etc
 *   -> ancestor = /workspace/evil-link, realpath = /etc
 *   -> result = /etc/file.txt  (correctly detected as outside workspace)
 *
 * Includes circular-symlink detection and MAX_DEPTH guard.
 *
 * @param {string} targetPath - Path to resolve
 * @returns {string} Resolved path
 */
export function resolveViaAncestor(targetPath) {
  const absolute = path.resolve(targetPath);
  let current = absolute;
  const trailing = [];
  const visited = new Set();
  const MAX_DEPTH = 40;

  while (current !== path.dirname(current) && trailing.length < MAX_DEPTH) {
    // Circular symlink detection
    if (visited.has(current)) {
      return absolute;
    }
    visited.add(current);
    try {
      const real = fs.realpathSync(current);
      const resolved = trailing.length > 0
        ? path.join(real, ...trailing.reverse())
        : real;
      return resolved;
    } catch {
      trailing.push(path.basename(current));
      current = path.dirname(current);
    }
  }

  // No ancestor could be resolved — return absolute
  return absolute;
}

/**
 * Validate a git ref (loose version for branch names and common refs).
 * Allows hex hashes (7-40 chars), branch-like names (with / and -),
 * and common refs like HEAD, refs/heads/main, etc.
 *
 * @param {string} ref
 * @returns {boolean}
 */
export function isValidGitRef(ref) {
  if (!ref || typeof ref !== "string") return false;
  // Pure hex hash (7-40 chars)
  if (/^[a-fA-F0-9]{7,40}$/.test(ref)) return true;
  // Branch-like names: alphanumeric, hyphens, slashes, dots, underscores
  // Must not start/end with . or contain .. or end with .lock
  if (/^[a-zA-Z0-9][a-zA-Z0-9._\/-]*[a-zA-Z0-9]$/.test(ref) &&
      !ref.includes("..") &&
      !ref.endsWith(".lock")) {
    return true;
  }
  // Special refs
  if (/^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD)$/.test(ref)) return true;
  return false;
}

/**
 * Validate a git hash (strict version - only pure SHA hex).
 * Only allows hexadecimal strings of 7-40 characters.
 *
 * @param {string} ref
 * @returns {boolean}
 */
export function isValidGitHash(ref) {
  if (!ref || typeof ref !== "string") return false;
  return /^[a-fA-F0-9]+$/.test(ref) && ref.length >= 7 && ref.length <= 40;
}
