// Mercury Code - AST (Abstract Syntax Tree) Search
// Provides structural code search using tree-sitter-like regex patterns
// and language-aware symbol extraction without external dependencies.
//
// Since we have zero npm dependencies, this module implements lightweight
// AST-like search using regex patterns that understand common language constructs:
//   - Function/method definitions
//   - Class definitions
//   - Import/export statements
//   - Variable declarations
//   - Type definitions
//   - Decorators/annotations
//
// This is NOT a full AST parser — it uses battle-tested regex patterns
// to extract structure from source code, similar to ctags/universal-ctags.

import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// ── Language patterns ─────────────────────────────────────────────────────────

const LANGUAGE_PATTERNS = {
  javascript: {
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    patterns: {
      function: [
        // function name(...)
        /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm,
        // const name = (async)? (...) =>
        /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/gm,
        // const name = function(...)
        /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/gm,
      ],
      class: [
        /^[ \t]*(?:export\s+)?class\s+(\w+)/gm,
      ],
      method: [
        // methodName(...) { inside class
        /^[ \t]+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
      ],
      import: [
        /^[ \t]*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/gm,
        /^[ \t]*(?:const|let|var)\s+\{?[^}]*\}?\s*=\s*require\(['"]([^'"]+)['"]\)/gm,
      ],
      export: [
        /^[ \t]*export\s+(?:default\s+)?(?:class|function|const|let|var|async)\s+(\w+)/gm,
        /^[ \t]*export\s+\{([^}]+)\}/gm,
      ],
      variable: [
        /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=/gm,
      ],
    },
  },

  typescript: {
    extensions: [".ts", ".tsx"],
    patterns: {
      function: [
        /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/gm,
        /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/gm,
      ],
      class: [
        /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
      ],
      interface: [
        /^[ \t]*(?:export\s+)?interface\s+(\w+)/gm,
      ],
      type: [
        /^[ \t]*(?:export\s+)?type\s+(\w+)\s*[<=]/gm,
      ],
      enum: [
        /^[ \t]*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/gm,
      ],
      method: [
        /^[ \t]+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*[<(]/gm,
      ],
      import: [
        /^[ \t]*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/gm,
      ],
      export: [
        /^[ \t]*export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum|async|abstract)\s+(\w+)/gm,
      ],
      variable: [
        /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/gm,
      ],
      decorator: [
        /^[ \t]*@(\w+)/gm,
      ],
    },
  },

  python: {
    extensions: [".py"],
    patterns: {
      function: [
        /^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm,
      ],
      class: [
        /^[ \t]*class\s+(\w+)/gm,
      ],
      method: [
        /^[ \t]+(?:async\s+)?def\s+(\w+)\s*\(self/gm,
      ],
      import: [
        /^[ \t]*(?:from\s+(\S+)\s+)?import\s+(.+)/gm,
      ],
      variable: [
        /^(\w+)\s*(?::\s*\w+)?\s*=/gm,
      ],
      decorator: [
        /^[ \t]*@(\w+)/gm,
      ],
    },
  },

  go: {
    extensions: [".go"],
    patterns: {
      function: [
        /^func\s+(\w+)\s*\(/gm,
      ],
      method: [
        /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)\s*\(/gm,
      ],
      type: [
        /^type\s+(\w+)\s+(?:struct|interface|func)/gm,
      ],
      import: [
        /^\s+"([^"]+)"/gm,
      ],
      variable: [
        /^(?:var|const)\s+(\w+)/gm,
      ],
    },
  },

  rust: {
    extensions: [".rs"],
    patterns: {
      function: [
        /^[ \t]*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm,
      ],
      struct: [
        /^[ \t]*(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)/gm,
      ],
      enum: [
        /^[ \t]*(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)/gm,
      ],
      trait: [
        /^[ \t]*(?:pub(?:\([\w:]+\))?\s+)?trait\s+(\w+)/gm,
      ],
      impl: [
        /^[ \t]*impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)/gm,
      ],
      import: [
        /^[ \t]*use\s+(.+);/gm,
      ],
      variable: [
        /^[ \t]*(?:pub\s+)?(?:static|const)\s+(\w+)/gm,
      ],
      macro: [
        /^[ \t]*(?:pub\s+)?macro_rules!\s+(\w+)/gm,
      ],
    },
  },
};

// Skip these directories during search
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__",
  "dist", ".next", "coverage", ".cache", "target",
  "build", "vendor", ".tox", "venv", ".venv",
]);

// ── AST Search Functions ──────────────────────────────────────────────────────

/**
 * Detect the language of a file based on its extension.
 */
function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  for (const [lang, config] of Object.entries(LANGUAGE_PATTERNS)) {
    if (config.extensions.includes(ext)) return lang;
  }
  return null;
}

/**
 * Extract all symbols from a file's content.
 * Returns an array of { kind, name, line, file } objects.
 */
export function extractSymbols(content, filePath) {
  const lang = detectLanguage(filePath);
  if (!lang) return [];

  const patterns = LANGUAGE_PATTERNS[lang].patterns;
  const symbols = [];

  for (const [kind, regexes] of Object.entries(patterns)) {
    for (const regex of regexes) {
      // Create a fresh RegExp instance per call to avoid race conditions
      // with the shared global `g` flag regex (lastIndex is per-instance)
      const freshRegex = new RegExp(regex.source, regex.flags);
      let match;
      while ((match = freshRegex.exec(content)) !== null) {
        // Find line number
        const before = content.slice(0, match.index);
        const line = before.split("\n").length;

        // Get the captured name (first non-undefined capture group)
        const name = match.slice(1).find((g) => g !== undefined) || "";

        symbols.push({
          kind,
          name: name.trim(),
          line,
          file: filePath,
          match: match[0].trim().slice(0, 100), // Context (truncated)
        });
      }
    }
  }

  // Sort by line number
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

/**
 * Search for symbols matching a query across the workspace.
 * @param {string} workspace - Workspace root directory
 * @param {string} query - Symbol name or regex pattern to search for
 * @param {object} [options]
 * @param {string} [options.kind] - Filter by kind: function, class, method, etc.
 * @param {string} [options.language] - Filter by language: typescript, python, etc.
 * @param {number} [options.maxResults=200] - Maximum results to return
 * @returns {Promise<Array<{kind, name, line, file, match}>>}
 */
export async function searchSymbols(workspace, query, options = {}) {
  const { kind, language, maxResults = 200 } = options;

  let queryRegex;
  try {
    queryRegex = new RegExp(query, "i");
  } catch {
    queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const results = [];
  /** @type {Set<string>} Track visited real paths to prevent symlink loops */
  const visited = new Set();

  async function walkDir(dirPath) {
    if (results.length >= maxResults) return;

    // Resolve real path and check for symlink loops
    let realDirPath;
    try {
      realDirPath = await realpath(dirPath);
    } catch {
      return;
    }
    if (visited.has(realDirPath)) return;
    visited.add(realDirPath);

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walkDir(path.join(dirPath, entry.name));
        }
      } else if (entry.isFile()) {
        const filePath = path.join(dirPath, entry.name);
        const lang = detectLanguage(filePath);
        if (!lang) continue;
        if (language && lang !== language) continue;

        let content;
        try {
          content = await readFile(filePath, "utf-8");
        } catch {
          continue;
        }

        // Skip binary / very large files
        if (content.includes("\0") || content.length > 500000) continue;

        const symbols = extractSymbols(content, filePath);
        for (const sym of symbols) {
          if (results.length >= maxResults) break;
          if (kind && sym.kind !== kind) continue;
          if (queryRegex.test(sym.name)) {
            results.push(sym);
          }
        }
      }
    }
  }

  await walkDir(workspace);
  return results;
}

/**
 * Get the structural outline of a single file.
 * Returns all symbols organized by kind.
 */
export async function fileOutline(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }

  const symbols = extractSymbols(content, filePath);
  if (symbols.length === 0) {
    const lang = detectLanguage(filePath);
    return lang ? "No symbols extracted (file may be too small or use unusual syntax)." : "Unsupported file type for AST analysis.";
  }

  // Group by kind
  const grouped = {};
  for (const sym of symbols) {
    if (!grouped[sym.kind]) grouped[sym.kind] = [];
    grouped[sym.kind].push(sym);
  }

  const lines = [`Outline of ${path.basename(filePath)} (${symbols.length} symbols):`];
  for (const [kind, syms] of Object.entries(grouped)) {
    lines.push(`\n  ${kind.toUpperCase()} (${syms.length}):`);
    for (const sym of syms) {
      lines.push(`    ${sym.name} (line ${sym.line})`);
    }
  }

  return lines.join("\n");
}

/**
 * Format search results for display.
 */
export function formatSearchResults(results) {
  if (!results || results.length === 0) return "No matching symbols found.";

  const lines = [`Found ${results.length} symbol(s):\n`];
  for (const r of results) {
    const relFile = r.file;
    lines.push(`  ${r.kind.padEnd(12)} ${r.name.padEnd(30)} ${relFile}:${r.line}`);
  }
  return lines.join("\n");
}
