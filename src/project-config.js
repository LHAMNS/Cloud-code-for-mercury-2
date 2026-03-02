// Mercury Code - Project Configuration
// Loads project-level instructions from .mercury.md (like CLAUDE.md or AGENTS.md)
// Discovery chain: Global (~/.mercury/mercury.md) → project root (.mercury.md)
// Content is injected into the system prompt to customize behavior per-project.

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Load project configuration instructions.
 * Searches for .mercury.md in the workspace root and global config.
 * Returns combined content or empty string.
 *
 * @param {string} workspace - Project root directory
 * @returns {Promise<string>} Combined instructions
 */
export async function loadProjectConfig(workspace) {
  const sections = [];

  // 1. Global instructions: ~/.mercury/mercury.md
  const globalPath = path.join(os.homedir(), ".mercury", "mercury.md");
  const globalContent = await _safeRead(globalPath);
  if (globalContent) {
    sections.push(`## Global Instructions\n${globalContent}`);
  }

  // 2. Project instructions: <workspace>/.mercury.md
  const projectPath = path.join(workspace, ".mercury.md");
  const projectContent = await _safeRead(projectPath);
  if (projectContent) {
    sections.push(`## Project Instructions\n${projectContent}`);
  }

  // 3. Also check MERCURY.md (alternative name)
  if (!projectContent) {
    const altPath = path.join(workspace, "MERCURY.md");
    const altContent = await _safeRead(altPath);
    if (altContent) {
      sections.push(`## Project Instructions\n${altContent}`);
    }
  }

  if (sections.length === 0) return "";

  return "\n\n# Custom Instructions\n\n" + sections.join("\n\n") + "\n";
}

/**
 * Check if a project config file exists.
 * @param {string} workspace
 * @returns {Promise<string|null>} Path to the config file, or null
 */
export async function findProjectConfig(workspace) {
  for (const name of [".mercury.md", "MERCURY.md"]) {
    const filePath = path.join(workspace, name);
    const content = await _safeRead(filePath);
    if (content) return filePath;
  }
  return null;
}

/**
 * Scaffold a new .mercury.md file.
 * @param {string} workspace
 * @returns {Promise<string>} Path to the created file
 */
export async function scaffoldProjectConfig(workspace) {
  const filePath = path.join(workspace, ".mercury.md");
  const content = `# Mercury Code Project Instructions

<!-- This file is automatically loaded by Mercury Code when working in this project. -->
<!-- Add project-specific instructions, conventions, and context here. -->

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

async function _safeRead(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}
