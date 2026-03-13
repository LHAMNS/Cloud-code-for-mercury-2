// Mercury Code - Skills System
// Skills are prompt-based extensions defined in SKILL.md files with YAML frontmatter.
// Similar to Claude Code's skill system.
//
// Skill discovery locations:
//   1. .mercury/skills/*.md (project-level)
//   2. ~/.mercury/skills/*.md (user-level)
//
// SKILL.md frontmatter format:
//   ---
//   name: commit
//   description: Create a git commit with a good message
//   argument-hint: optional commit message
//   user-invocable: true
//   allowed-tools: Bash, Read, Grep
//   model: mercury-coder-small
//   ---
//   <prompt body in markdown>

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { debugLog } from "./utils/debug-log.js";
import {
  ESC, RESET, BOLD, DIM, CYAN, GRAY, GREEN,
} from "./utils/colors.js";

// ── Skill class ────────────────────────────────────────────────────────────

export class Skill {
  /**
   * @param {object} options
   * @param {string} options.name - Skill name (used as /command)
   * @param {string} options.description - Short description
   * @param {string} options.prompt - Full prompt body (markdown)
   * @param {string} [options.argumentHint] - Hint for argument
   * @param {boolean} [options.userInvocable] - Can be triggered by user with /name
   * @param {string[]} [options.allowedTools] - Restrict tools available to the skill
   * @param {string[]} [options.disallowedTools] - Tools to deny
   * @param {string} [options.model] - Override model for this skill
   * @param {string} [options.context] - 'fork' to run in forked context
   * @param {string} [options.agent] - Agent type to use for execution
   * @param {boolean} [options.disableModelInvocation] - Prevent model from invoking this skill
   * @param {string} options.source - File path where skill was defined
   * @param {boolean} [options.isProjectLevel] - Whether skill comes from project .mercury/skills/
   */
  constructor(options) {
    this.name = options.name;
    this.description = options.description || "";
    this.prompt = options.prompt || "";
    this.argumentHint = options.argumentHint || "";
    this.userInvocable = options.userInvocable !== false;
    this.allowedTools = options.allowedTools || null;
    this.disallowedTools = options.disallowedTools || null;
    this.model = options.model || null;
    this.context = options.context || null;
    this.agent = options.agent || null;
    this.disableModelInvocation = options.disableModelInvocation || false;
    this.source = options.source || "";
    this.isProjectLevel = options.isProjectLevel || false;
  }

  /**
   * Render the skill prompt with argument substitution.
   * Replaces {{argument}} or $ARGUMENTS with the provided argument string.
   * @param {string} [argument] - User-provided argument
   * @returns {string} Rendered prompt
   */
  render(argument = "") {
    let rendered = this.prompt;
    rendered = rendered.replace(/\{\{argument\}\}/gi, argument);
    rendered = rendered.replace(/\$ARGUMENTS/g, argument);
    return rendered;
  }
}

// ── YAML Frontmatter Parser ────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown string.
 * Simple parser for the subset of YAML used in skill files.
 * @param {string} content - Full file content
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of yamlStr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Parse booleans
    if (value === "true") value = true;
    else if (value === "false") value = false;

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Parse a comma-separated tool list string into an array.
 * @param {string|string[]} tools
 * @returns {string[]|null}
 */
function parseToolList(tools) {
  if (!tools) return null;
  if (Array.isArray(tools)) return tools;
  return tools.split(",").map((t) => t.trim()).filter(Boolean);
}

// ── SkillManager ───────────────────────────────────────────────────────────

/**
 * Discovers, loads, and manages skills.
 */
export class SkillManager {
  constructor() {
    /** @type {Map<string, Skill>} */
    this._skills = new Map();
    this._loaded = false;
  }

  /**
   * Discover and load all skills from project and user directories.
   * @param {string} workspace - Project workspace root
   */
  async discover(workspace) {
    this._skills.clear();

    // 1. User-level skills: ~/.mercury/skills/*.md
    const userDir = path.join(os.homedir(), ".mercury", "skills");
    await this._loadFromDirectory(userDir, { isProjectLevel: false });

    // 2. Project-level skills: .mercury/skills/*.md (override user-level)
    //    SECURITY: project-level skills are untrusted (anyone can commit a SKILL.md).
    //    We strip security-sensitive frontmatter fields that are parsed but never
    //    enforced (allowed-tools, disallowed-tools, model, agent). These fields are
    //    reserved for future use; displaying them without enforcement gives a false
    //    sense of security.
    const projectDir = path.join(workspace, ".mercury", "skills");
    await this._loadFromDirectory(projectDir, { isProjectLevel: true });

    this._loaded = true;
  }

  /**
   * Load all SKILL.md files from a directory.
   * @param {string} dirPath
   * @param {object} [options]
   * @param {boolean} [options.isProjectLevel] - If true, strip unenforced security fields
   */
  async _loadFromDirectory(dirPath, options = {}) {
    try {
      const entries = await readdir(dirPath);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(dirPath, entry);
        try {
          const content = await readFile(filePath, "utf-8");
          const skill = this._parseSkillFile(content, filePath);
          if (skill) {
            // SECURITY: For project-level skills, strip frontmatter fields that are
            // parsed but never enforced. These give a false sense of security because
            // they appear to restrict the skill but are actually ignored at runtime.
            // Reserved for future use when proper enforcement is implemented.
            if (options.isProjectLevel) {
              skill.isProjectLevel = true;
              if (skill.allowedTools || skill.disallowedTools || skill.model || skill.agent) {
                debugLog(
                  "SkillManager._loadFromDirectory",
                  `Stripping unenforced fields (allowed-tools, disallowed-tools, model, agent) from project-level skill "${skill.name}" at ${filePath}`
                );
              }
              skill.allowedTools = null;
              skill.disallowedTools = null;
              skill.model = null;
              skill.agent = null;
            }
            this._skills.set(skill.name, skill);
          }
        } catch (err) {
          debugLog("SkillManager._loadFromDirectory.readFile", err);
        }
      }
    } catch (err) {
      debugLog("SkillManager._loadFromDirectory", err);
    }
  }

  /**
   * Parse a SKILL.md file into a Skill object.
   */
  _parseSkillFile(content, filePath) {
    const { frontmatter, body } = parseFrontmatter(content);

    // Name is required
    const name = frontmatter.name || path.basename(filePath, ".md");
    if (!name) return null;

    return new Skill({
      name,
      description: frontmatter.description || "",
      prompt: body.trim(),
      argumentHint: frontmatter["argument-hint"] || "",
      userInvocable: frontmatter["user-invocable"] !== false,
      allowedTools: parseToolList(frontmatter["allowed-tools"]),
      disallowedTools: parseToolList(frontmatter["disallowed-tools"]),
      model: frontmatter.model || null,
      context: frontmatter.context || null,
      agent: frontmatter.agent || null,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      source: filePath,
    });
  }

  /**
   * Get a skill by name.
   * @param {string} name
   * @returns {Skill|null}
   */
  get(name) {
    return this._skills.get(name) || null;
  }

  /**
   * Check if a skill exists.
   */
  has(name) {
    return this._skills.has(name);
  }

  /**
   * Get all user-invocable skills.
   * @returns {Skill[]}
   */
  getUserInvocable() {
    return [...this._skills.values()].filter((s) => s.userInvocable);
  }

  /**
   * Get all skills.
   * @returns {Skill[]}
   */
  getAll() {
    return [...this._skills.values()];
  }

  /**
   * Get skill names for tab completion.
   * @returns {string[]}
   */
  getCompletions() {
    return this.getUserInvocable().map((s) => `/${s.name}`);
  }

  /**
   * Generate a tool definition for invoking skills (if any are model-invocable).
   * @param {object} [options]
   * @param {boolean} [options.excludeProjectSkills] - If true, exclude project-level skills
   * @returns {object|null} Tool definition or null if no model-invocable skills
   */
  getToolDefinition(options = {}) {
    let invocable = [...this._skills.values()].filter((s) => !s.disableModelInvocation);
    if (options.excludeProjectSkills) {
      invocable = invocable.filter((s) => !s.isProjectLevel);
    }
    if (invocable.length === 0) return null;

    const skillNames = invocable.map((s) => s.name).join(", ");
    return {
      type: "function",
      function: {
        name: "Skill",
        description:
          `Invoke a skill (prompt-based extension). Available skills: ${skillNames}. ` +
          "Skills provide specialized capabilities and domain knowledge.",
        parameters: {
          type: "object",
          properties: {
            skill: {
              type: "string",
              description: `The skill name to invoke. Available: ${skillNames}`,
            },
            args: {
              type: "string",
              description: "Optional arguments for the skill.",
            },
          },
          required: ["skill"],
        },
      },
    };
  }

  /**
   * Format skill list for display.
   * @returns {string}
   */
  formatList() {
    const skills = this.getAll();
    if (skills.length === 0) return "  No skills found.";

    const R = RESET, B = BOLD, D = DIM;
    const C = CYAN, G = GRAY, GR = GREEN;

    const lines = [];
    lines.push(`${B}${C}  Skills (${skills.length})${R}`);
    for (const skill of skills) {
      const invocable = skill.userInvocable ? `${GR}/${skill.name}${R}` : `${G}${skill.name}${R}`;
      const tools = skill.allowedTools ? ` ${D}[${skill.allowedTools.join(", ")}]${R}` : "";
      lines.push(`  ${invocable}  ${D}${skill.description}${R}${tools}`);
      lines.push(`    ${G}${skill.source}${R}`);
    }
    return lines.join("\n");
  }

  get isLoaded() {
    return this._loaded;
  }

  get count() {
    return this._skills.size;
  }
}
