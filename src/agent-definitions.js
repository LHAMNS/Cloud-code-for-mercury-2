// Mercury Code - Agent Definitions
// Supports user-defined agents via markdown files with YAML frontmatter
// in .mercury/agents/ (project) or ~/.mercury/agents/ (global).
// Also provides built-in agent types mirroring Claude Code's architecture.

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

// ── Built-in agent types ─────────────────────────────────────────────────────

const BUILTIN_AGENTS = {
  explore: {
    name: "explore",
    description:
      "Fast agent for exploring codebases. Use for finding files, searching code, " +
      "or answering questions about the codebase. Specify thoroughness: quick, medium, very thorough.",
    systemPrompt:
      "You are an Explore agent — a fast, read-only codebase explorer.\n\n" +
      "Your job is to quickly find files, search for code patterns, and understand project structure.\n" +
      "You have READ-ONLY access: Read, Glob, Grep, ListDir, Diff, AstSearch, Lsp.\n\n" +
      "Be thorough in your search but concise in your response. Return what was found, " +
      "not lengthy explanations. Include file paths and line numbers.\n",
    tools: ["Read", "Glob", "Grep", "ListDir", "Diff", "Fetch", "AstSearch", "Lsp"],
    disallowedTools: [],
    model: null, // inherits from main
    maxTurns: 20,
    builtin: true,
  },

  plan: {
    name: "plan",
    description:
      "Software architect agent for designing implementation plans. " +
      "Researches the codebase, identifies critical files, and returns step-by-step plans.",
    systemPrompt:
      "You are a Plan agent — a software architect that researches and designs implementation plans.\n\n" +
      "Your job is to:\n" +
      "1. Research the codebase to understand existing architecture\n" +
      "2. Identify critical files and dependencies\n" +
      "3. Design a step-by-step implementation plan\n" +
      "4. Consider edge cases and trade-offs\n\n" +
      "You have READ-ONLY access. Return a clear, actionable plan — not code.\n",
    tools: ["Read", "Glob", "Grep", "ListDir", "Diff", "AstSearch", "Lsp"],
    disallowedTools: [],
    model: null,
    maxTurns: 25,
    builtin: true,
  },

  "general-purpose": {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, " +
      "and executing multi-step tasks. Has full tool access.",
    systemPrompt:
      "You are a general-purpose sub-agent. Complete the assigned task autonomously.\n" +
      "You have access to all tools including Read, Write, Edit, Bash, Glob, Grep.\n" +
      "Be thorough and return exactly what was requested.\n",
    tools: null, // all tools (minus SubAgent/SubAgentTeam/ContextSearch)
    disallowedTools: [],
    model: null,
    maxTurns: 30,
    builtin: true,
  },
};

// Tools that sub-agents are never allowed to use (prevent recursion & resource exhaustion)
const ALWAYS_BLOCKED_TOOLS = new Set(["SubAgent", "SubAgentTeam", "ContextSearch", "AgentTeams"]);

// ── YAML frontmatter parser (lightweight, zero-dep) ──────────────────────────

/**
 * Parse simple YAML frontmatter from a markdown string.
 * Supports: strings, numbers, booleans, arrays (single-line [...] or multi-line - items).
 * Returns { frontmatter: {}, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];
  const fm = {};

  const lines = yamlStr.split("\n");
  let currentKey = null;
  let currentArray = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Array item (- value)
    if (trimmed.startsWith("- ") && currentKey && currentArray) {
      currentArray.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let val = kvMatch[2].trim();

      // Inline array: [a, b, c]
      if (val.startsWith("[") && val.endsWith("]")) {
        fm[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
        currentKey = null;
        currentArray = null;
        continue;
      }

      // Empty value (might be start of multi-line array)
      if (!val) {
        currentKey = key;
        currentArray = [];
        fm[key] = currentArray;
        continue;
      }

      // Boolean
      if (val === "true") val = true;
      else if (val === "false") val = false;
      // Number
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
      // Strip quotes
      else val = val.replace(/^['"]|['"]$/g, "");

      fm[key] = val;
      currentKey = null;
      currentArray = null;
    }
  }

  return { frontmatter: fm, body };
}

// ── Agent definition loading ─────────────────────────────────────────────────

/**
 * Load a single agent definition from a markdown file.
 * Expected format:
 *   ---
 *   name: my-agent
 *   description: When to use this agent
 *   tools: [Read, Glob, Grep]
 *   disallowedTools: [Write, Bash]
 *   model: sonnet
 *   maxTurns: 20
 *   ---
 *   System prompt in markdown goes here...
 */
function loadAgentFromMarkdown(content, filePath) {
  const { frontmatter: fm, body } = parseFrontmatter(content);

  if (!fm.name) {
    fm.name = path.basename(filePath, path.extname(filePath));
  }
  // Sanitize agent name to prevent path traversal or injection
  fm.name = fm.name.replace(/[^a-zA-Z0-9_-]/g, '_');

  const VALID_PERMISSION_MODES = ['open', 'aiSafetyDecide', 'acceptEdits', 'approval', 'dontAsk', 'readonly'];
  if (fm.permissionMode && !VALID_PERMISSION_MODES.includes(fm.permissionMode)) {
    fm.permissionMode = null; // Invalid mode, use default
  }

  return {
    name: fm.name,
    description: fm.description || `Custom agent: ${fm.name}`,
    systemPrompt: body.trim() || null,
    tools: fm.tools || null,
    disallowedTools: fm.disallowedTools || [],
    model: fm.model || null,
    maxTurns: fm.maxTurns || 30,
    permissionMode: fm.permissionMode || null, // default, open, readonly
    background: fm.background === true,
    isolation: fm.isolation || null, // 'worktree' or null
    builtin: false,
    source: filePath,
  };
}

/**
 * Discover all user-defined agent definitions from project and global dirs.
 * Project agents override global agents with the same name.
 * @param {string} workspace - Project root directory
 * @returns {Promise<Map<string, object>>}
 */
export async function discoverAgents(workspace) {
  const agents = new Map();

  // 1. Load builtins
  for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
    agents.set(name, { ...def });
  }

  // 2. Load global agents from ~/.mercury/agents/
  const globalDir = path.join(os.homedir(), ".mercury", "agents");
  await _loadAgentsFromDir(globalDir, agents);

  // 3. Load project agents from .mercury/agents/ (overrides global)
  const projectDir = path.join(workspace, ".mercury", "agents");
  await _loadAgentsFromDir(projectDir, agents);

  // Protect built-in agent names from being overridden by project definitions
  for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
    agents.set(name, { ...def }); // Re-set builtins to prevent project override
  }

  return agents;
}

/**
 * Load agent .md files from a directory into the agents map.
 */
async function _loadAgentsFromDir(dirPath, agents) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist, OK
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(dirPath, entry.name);
    try {
      const content = await readFile(filePath, "utf-8");
      const def = loadAgentFromMarkdown(content, filePath);
      agents.set(def.name, def);
    } catch {
      // Skip broken files
    }
  }
}

/**
 * Resolve which tools an agent is allowed to use.
 * Returns the filtered TOOL_DEFINITIONS array.
 * @param {object} agentDef - Agent definition
 * @param {string} trustMode - Current trust mode
 * @returns {Array} Filtered tool definitions
 */
export function resolveAgentTools(agentDef, trustMode) {
  // Start with all tools minus recursion-blockers
  let tools = TOOL_DEFINITIONS.filter((t) => !ALWAYS_BLOCKED_TOOLS.has(t.function.name));

  // Apply allowlist if specified
  if (agentDef.tools && Array.isArray(agentDef.tools)) {
    const allowSet = new Set(agentDef.tools);
    tools = tools.filter((t) => allowSet.has(t.function.name));
  }

  // Apply denylist
  if (agentDef.disallowedTools && agentDef.disallowedTools.length > 0) {
    const denySet = new Set(agentDef.disallowedTools);
    tools = tools.filter((t) => !denySet.has(t.function.name));
  }

  // Enforce readonly mode
  const READ_TOOLS = new Set(["Read", "Glob", "Grep", "ListDir", "Diff", "Fetch", "AstSearch", "Lsp"]);
  if (trustMode === "readonly") {
    tools = tools.filter((t) => READ_TOOLS.has(t.function.name));
  }

  return tools;
}

/**
 * Find the best matching agent for a task description.
 * Uses keyword matching against agent descriptions.
 * @param {Map<string, object>} agents - Available agents
 * @param {string} task - Task description
 * @returns {object|null} Best matching agent definition, or null
 */
export function matchAgentForTask(agents, task) {
  const lower = task.toLowerCase();

  // Heuristic keyword matching
  if (/\b(explore|search|find|locate|look\s+for|grep|glob)\b/.test(lower)) {
    const explore = agents.get("explore");
    if (explore) return explore;
  }

  if (/\b(plan|design|architect|strategy|approach)\b/.test(lower)) {
    const plan = agents.get("plan");
    if (plan) return plan;
  }

  // Check custom agents by description keywords
  const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'it', 'this', 'that', 'with']);
  for (const [, def] of agents) {
    if (def.builtin) continue;
    if (def.description) {
      const descWords = def.description.toLowerCase().split(/\s+/);
      const taskWords = lower.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
      const overlap = taskWords.filter((w) => descWords.includes(w)).length;
      if (overlap >= 4) return def;
    }
  }

  // Default to general-purpose
  return agents.get("general-purpose") || null;
}

/**
 * Format agent definitions for display.
 * @param {Map<string, object>} agents
 * @returns {string}
 */
export function formatAgentList(agents) {
  const lines = [`Available agents (${agents.size}):\n`];

  // Builtins first
  const builtins = [];
  const custom = [];
  for (const [, def] of agents) {
    if (def.builtin) builtins.push(def);
    else custom.push(def);
  }

  if (builtins.length > 0) {
    lines.push("  Built-in:");
    for (const def of builtins) {
      const tools = def.tools ? def.tools.join(", ") : "all";
      const model = def.model || "inherit";
      lines.push(`    ${def.name.padEnd(20)} model: ${model.padEnd(10)} tools: ${tools}`);
      lines.push(`    ${"".padEnd(20)} ${def.description}`);
    }
  }

  if (custom.length > 0) {
    lines.push("\n  Custom:");
    for (const def of custom) {
      const tools = def.tools ? def.tools.join(", ") : "all";
      const model = def.model || "inherit";
      lines.push(`    ${def.name.padEnd(20)} model: ${model.padEnd(10)} tools: ${tools}`);
      lines.push(`    ${"".padEnd(20)} ${def.description}`);
      if (def.source) lines.push(`    ${"".padEnd(20)} source: ${def.source}`);
    }
  }

  return lines.join("\n");
}

/**
 * Scaffold a new agent markdown file.
 * @param {string} workspace
 * @param {string} name
 * @param {object} [options]
 * @returns {Promise<string>} Path to the created file
 */
export async function scaffoldAgent(workspace, name, options = {}) {
  const agentDir = path.join(workspace, ".mercury", "agents");
  await mkdir(agentDir, { recursive: true });

  const filePath = path.join(agentDir, `${name}.md`);

  const content = `---
name: ${name}
description: ${options.description || "Describe when to use this agent"}
tools: [Read, Write, Edit, Bash, Glob, Grep, ListDir, Diff]
maxTurns: 30
---

You are a custom sub-agent named "${name}".

Your job is to complete the assigned task autonomously.
Be thorough but concise. Return relevant findings or results.
`;

  await writeFile(filePath, content, "utf-8");
  return filePath;
}
