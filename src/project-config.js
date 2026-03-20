// Mercury Code - Project Configuration (Enhanced MERCURY.md Hierarchy)
// Modeled after Claude Code's CLAUDE.md multi-scope system.
//
// Configuration hierarchy (lower overrides higher):
//   1. Managed   — organization-level, read-only (via MERCURY_MANAGED_CONFIG env)
//   2. User      — ~/.mercury/MERCURY.md (personal preferences)
//   3. Project   — <workspace>/MERCURY.md or .mercury.md (project-specific)
//   4. Local     — <workspace>/.mercury/local/MERCURY.md (gitignored, developer-specific)
//
// Additionally:
//   - <workspace>/.mercury/rules/*.md — path-scoped rules (like .claude/rules/)
//   - MEMORY.md auto-memory (first 200 lines loaded into context)
//
// Trusted content (managed/user) is injected into the system prompt.
// Untrusted content (project/local/rules/memory) is structurally isolated
// and injected as a nonce-fenced user message, NOT inside the system prompt.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { escapeFenceContent } from "./utils/fence.js";

const MAX_CONFIG_SIZE = 32768;  // 32KB max per config file (matches Codex PROJECT_DOC_MAX_BYTES)
const MEMORY_MAX_LINES = 200;   // First 200 lines of MEMORY.md loaded into context
const UNTRUSTED_BEGIN = "[UNTRUSTED_PROJECT_TEXT_BEGIN]";
const UNTRUSTED_END = "[UNTRUSTED_PROJECT_TEXT_END]";
const SUSPICIOUS_PROJECT_TEXT_PATTERNS = [
  /\bignore\s+(?:all|any|the)\s+previous\s+instructions\b/i,
  /\b(?:system|developer|assistant|user)\s*:/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\b/i,
  /\b(?:disregard|override|supersede|forget)\s+(?:all|any|the|your)\s+(?:previous|earlier|prior|above)\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\b/i,
  /\bact\s+as\s+if\b/i,
  /<\|(?:im_start|im_end|endoftext)\|>/i,
  /\[(?:INST|\/INST|SYS|\/SYS)\]/i,
];

function _wrapUntrustedProjectText(content) {
  const text = String(content ?? "").trim();
  if (!text) return null;

  if (SUSPICIOUS_PROJECT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    const encoded = Buffer.from(text, "utf-8").toString("base64");
    return `${UNTRUSTED_BEGIN} encoding=base64\n${encoded}\n${UNTRUSTED_END}`;
  }

  return `${UNTRUSTED_BEGIN} encoding=utf8\n${escapeFenceContent(text)}\n${UNTRUSTED_END}`;
}

/**
 * Load the full configuration hierarchy for a workspace.
 * Returns combined content to inject into the system prompt.
 *
 * @param {string} workspace - Project root directory
 * @returns {Promise<{trusted: string, untrusted: string}>}
 *   trusted  — managed + user config (safe to include in system prompt)
 *   untrusted — project + local + rules + memory (must be structurally isolated)
 */
export async function loadProjectConfig(workspace) {
  const trustedSections = [];
  const untrustedSections = [];

  // ── Trusted: controlled by the user, not present in cloned repos ──

  // 1. Managed config (organization-level, from env var)
  const managedPath = process.env.MERCURY_MANAGED_CONFIG;
  if (managedPath) {
    const managed = await _safeRead(managedPath, MAX_CONFIG_SIZE);
    if (managed) {
      trustedSections.push(`## Managed Instructions (Organization)\n${managed}`);
    }
  }

  // 2. User config: ~/.mercury/MERCURY.md
  const userPath = path.join(os.homedir(), ".mercury", "MERCURY.md");
  const userContent = await _safeRead(userPath, MAX_CONFIG_SIZE);
  if (userContent) {
    trustedSections.push(`## User Instructions\n${userContent}`);
  }
  if (!userContent) {
    const legacyUser = path.join(os.homedir(), ".mercury", "mercury.md");
    const legacyContent = await _safeRead(legacyUser, MAX_CONFIG_SIZE);
    if (legacyContent) {
      trustedSections.push(`## User Instructions\n${legacyContent}`);
    }
  }

  // ── Untrusted: from workspace files, can be attacker-controlled ──

  // 3. Project config: <workspace>/MERCURY.md or .mercury.md
  const projectContent = await _loadProjectMd(workspace);
  if (projectContent) {
    untrustedSections.push(`## Project Instructions\n${_wrapUntrustedProjectText(projectContent)}`);
  }

  // 4. Local config: <workspace>/.mercury/local/MERCURY.md (gitignored)
  const localPath = path.join(workspace, ".mercury", "local", "MERCURY.md");
  const localContent = await _safeRead(localPath, MAX_CONFIG_SIZE);
  if (localContent) {
    untrustedSections.push(`## Local Instructions (Developer)\n${_wrapUntrustedProjectText(localContent)}`);
  }

  // 5. Rules directory: <workspace>/.mercury/rules/*.md
  const rulesContent = await _loadRules(workspace);
  if (rulesContent) {
    untrustedSections.push(rulesContent);
  }

  // 6. Auto-memory: <workspace>/.mercury/memory.md (first 200 lines)
  const memoryContent = await _loadMemoryHead(workspace);
  if (memoryContent) {
    untrustedSections.push(`## Memory (Auto-Saved Context)\n${_wrapUntrustedProjectText(memoryContent)}`);
  }

  const trusted = trustedSections.length > 0
    ? "\n\n# User Instructions\n\n" + trustedSections.join("\n\n") + "\n"
    : "";
  const untrusted = untrustedSections.length > 0
    ? untrustedSections.join("\n\n")
    : "";

  return { trusted, untrusted };
}

/**
 * Load project-level MERCURY.md (supports multiple file name conventions).
 */
async function _loadProjectMd(workspace) {
  // Try in order: MERCURY.md, .mercury.md, .mercury/MERCURY.md
  const candidates = [
    path.join(workspace, "MERCURY.md"),
    path.join(workspace, ".mercury.md"),
    path.join(workspace, ".mercury", "MERCURY.md"),
  ];

  for (const p of candidates) {
    const content = await _safeRead(p, MAX_CONFIG_SIZE);
    if (content) return content;
  }
  return null;
}

/**
 * Load rules from .mercury/rules/*.md directory.
 * Each rule file can include a "path:" frontmatter to scope it.
 */
async function _loadRules(workspace) {
  const rulesDir = path.join(workspace, ".mercury", "rules");
  let entries;
  try {
    entries = await readdir(rulesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const ruleFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (ruleFiles.length === 0) return null;

  const lines = ["## Rules"];
  for (const entry of ruleFiles) {
    const filePath = path.join(rulesDir, entry.name);
    const content = await _safeRead(filePath, MAX_CONFIG_SIZE);
    if (content) {
      const ruleName = entry.name.replace(/\.md$/, "");
      lines.push(`\n### Rule: ${ruleName}`);
      lines.push(_wrapUntrustedProjectText(content));
    }
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Load first N lines of memory.md for context injection.
 */
async function _loadMemoryHead(workspace) {
  const memPath = path.join(workspace, ".mercury", "memory.md");
  try {
    const content = await readFile(memPath, "utf-8");
    if (!content.trim()) return null;

    const lines = content.split("\n");
    if (lines.length <= MEMORY_MAX_LINES) {
      return content.trim();
    }
    return lines.slice(0, MEMORY_MAX_LINES).join("\n") +
      `\n... (${lines.length - MEMORY_MAX_LINES} more lines in .mercury/memory.md)`;
  } catch {
    return null;
  }
}

/**
 * Check if a project config file exists.
 * @param {string} workspace
 * @returns {Promise<string|null>} Path to the config file, or null
 */
export async function findProjectConfig(workspace) {
  const candidates = [
    "MERCURY.md",
    ".mercury.md",
    ".mercury/MERCURY.md",
  ];
  for (const name of candidates) {
    const filePath = path.join(workspace, name);
    const content = await _safeRead(filePath);
    if (content) return filePath;
  }
  return null;
}

/**
 * Scaffold a new MERCURY.md file.
 * @param {string} workspace
 * @returns {Promise<string>} Path to the created file
 */
export async function scaffoldProjectConfig(workspace) {
  const filePath = path.join(workspace, "MERCURY.md");
  const content = `# Mercury Code Project Instructions

<!-- This file is automatically loaded by Mercury Code when working in this project. -->
<!-- Like CLAUDE.md for Claude Code, this provides project-specific context. -->

## Project Overview
<!-- Describe what this project does -->

## Code Conventions
<!-- Describe coding style, patterns, and conventions -->

## Important Files
<!-- List key files and their purposes -->

## Testing
<!-- Describe how to run tests and what testing framework is used -->

## Deployment
<!-- Describe deployment process if applicable -->
`;
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(filePath, content, "utf-8");
  return filePath;
}

/**
 * Safely read a file, returning null on any error.
 * Optionally truncates at maxBytes.
 */
async function _safeRead(filePath, maxBytes) {
  try {
    const content = await readFile(filePath, "utf-8");
    let trimmed = content.trim();
    if (!trimmed) return null;
    if (maxBytes && Buffer.byteLength(trimmed, 'utf-8') > maxBytes) {
      // Truncate at byte boundary, not character boundary, for accurate size limits
      trimmed = Buffer.from(trimmed, 'utf-8').subarray(0, maxBytes).toString('utf-8');
      // Remove possibly truncated multi-byte character at the end
      trimmed = trimmed.replace(/[\uFFFD]$/, '');
      return trimmed + "\n... (truncated)";
    }
    return trimmed;
  } catch {
    return null;
  }
}
