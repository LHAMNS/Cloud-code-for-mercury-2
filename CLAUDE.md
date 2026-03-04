# CLAUDE.md — Mercury Code

This file provides context for AI assistants working on the Mercury Code codebase.

## Project Overview

Mercury Code is an interactive AI coding assistant CLI powered by the **Mercury-2 diffusion model** from Inception Labs. It mirrors Claude Code's architecture while using a different LLM backend. The project is a **zero-dependency** Node.js application (ES Modules) that provides a full-featured REPL with tools, sub-agents, permissions, sandboxing, and MCP integration.

- **Version:** 1.4.0
- **License:** MIT
- **Node.js:** >=18.17.0
- **Module system:** ESM (`"type": "module"` in package.json)
- **External dependencies:** None — only Node.js built-in modules are used

## Quick Reference Commands

```bash
# Development
make install          # npm install + npm link (global install)
make dev              # Run with --verbose flag
make run              # Run interactive REPL
make test             # Run full test suite (464 tests)
make lint             # Syntax check all .js files

# Testing (directly)
node --test test/*.test.js

# Building
make build            # Build standalone binaries (all platforms)
make build-linux      # Linux x64 + ARM64 only
make build-mac        # macOS Intel + Apple Silicon only
make build-win        # Windows x64 + ARM64 only

# Release
make release          # test + build
make publish          # npm publish --access public
make clean            # rm -rf node_modules dist _pkg_entry.cjs
```

## Repository Structure

```
├── cli.js                    # CLI entry point — argument parsing, REPL bootstrap
├── package.json              # Zero dependencies, ESM, bin: mercury / mercury-code
├── Makefile                  # Dev, test, build, and release targets
├── install.sh                # Bash installer (Linux/macOS)
├── install.ps1               # PowerShell installer (Windows)
├── src/
│   ├── index.js              # Public API re-exports
│   ├── repl.js               # Main REPL loop (~2.8K lines) — orchestrates everything
│   ├── client.js             # Mercury-2 API client (OpenAI-compatible, streaming)
│   ├── config.js             # API base URL, model config, token limits
│   ├── system-prompt.js      # Dynamic system prompt builder
│   ├── conversation.js       # Conversation message management
│   ├── memory.js             # Persistent memory (.mercury/memory.md) & conversation log
│   ├── history.js            # Session history tracking
│   ├── context.js            # Token estimation & context compaction
│   ├── rollback.js           # ESC triple-press undo/rollback system
│   ├── sandbox.js            # Security sandbox (file/network/process isolation)
│   ├── permissions.js         # 5-mode permission system with rules engine
│   ├── hooks.js              # Pre/post-tool lifecycle hooks
│   ├── agent-definitions.js  # Custom agent discovery & parsing
│   ├── subagent.js           # Sub-agent spawning & execution
│   ├── agent-teams.js        # Multi-agent team coordination
│   ├── mcp.js                # MCP (Model Context Protocol) server management
│   ├── skills.js             # Skills engine for prompt-based extensions
│   ├── lsp.js                # Language Server Protocol client
│   ├── ast-search.js         # Tree-sitter AST symbol search
│   ├── ai-safety-decide.js   # AI-powered permission evaluation
│   ├── labs.js               # Experimental feature flags
│   ├── project-config.js     # Project-level config loading
│   ├── tools/
│   │   ├── definitions.js    # OpenAI function-calling tool schemas
│   │   └── executor.js       # Tool execution with permission/sandbox checks
│   └── ui/
│       ├── display.js        # Terminal UI (colors, spinners, welcome screen)
│       └── agent-tabs.js     # Tab bar UI for concurrent sub-agents
├── test/                     # 464 tests across 14 files using node:test
│   ├── security.test.js      # Security boundary tests
│   ├── permissions-enhanced.test.js  # Permission modes & rules
│   ├── deep-agent-security.test.js   # Sub-agent security
│   ├── e2e-agents.test.js    # End-to-end agent workflows
│   └── ...                   # Config, context, hooks, labs, MCP, etc.
├── scripts/
│   ├── build-binaries.js     # Cross-platform binary builder (@yao-pkg/pkg)
│   ├── postinstall.js        # Post-install setup (chmod, config dir)
│   └── windows-installer.iss # Inno Setup script for Windows EXE
└── .github/workflows/
    ├── ci.yml                # Tests on push (Node 18/20/22, Ubuntu/macOS/Windows)
    └── release.yml           # Automated release (npm + 6 platform binaries)
```

## Architecture

### Entry Points

- **CLI:** `cli.js` parses args and creates a `MercuryRepl` instance
- **Programmatic:** `src/index.js` re-exports all public classes and functions

### Core Loop (repl.js)

The REPL sends user input to Mercury-2, receives responses with tool calls, executes tools through the permission/sandbox pipeline, and loops until the model stops calling tools or reaches `MAX_TOOL_TURNS` (100).

### Tool Execution Pipeline

```
User Input → REPL → Mercury-2 API → Tool Calls
  → Hooks (pre) → Permission Check → Sandbox Validation → Tool Executor → Hooks (post)
  → Results back to Mercury-2 → Response or more tool calls
```

### Permission Modes

Six trust modes, from most restrictive to least:
1. `readonly` — no writes, no bash, view-only
2. `approval` — user approves every tool call (default)
3. `acceptEdits` — auto-approve file edits, prompt for bash
4. `open` — auto-approve most operations
5. `dontAsk` — auto-approve everything
6. `aiSafetyDecide` — AI evaluates safety (ALLOW / DENY / ESCALATE)

### Sandbox Modes

Three levels: `off`, `on` (default), `strict`. Controls file access boundaries, network restrictions (SSRF protection, private IP blocking), process isolation, rate limiting, and content scanning.

### Configuration Hierarchy

Managed (enterprise) → CLI flags → Local project → Shared project → User global

Project config files: `.mercury.md`, `MERCURY.md`, `.mercury/settings.json`

## Code Conventions

### Style

- **ES Modules** throughout (`import`/`export`, no CommonJS)
- **Class-based** architecture — each subsystem is a class (e.g., `MercuryRepl`, `Sandbox`, `PermissionManager`)
- **Zero external dependencies** — only `node:*` built-in modules
- **Section dividers** in comments: `// ── Section Name ──────────────...`
- **JSDoc** comments on public methods

### Naming

- **Classes:** PascalCase (`MercuryRepl`, `ToolExecutor`, `AgentTeam`)
- **Functions/methods:** camelCase (`buildSystemPrompt()`, `checkPath()`)
- **Constants:** UPPER_SNAKE_CASE (`SANDBOX_MODE`, `MAX_TOOL_TURNS`, `MODEL_LIMITS`)
- **Private members:** `_prefixed` (`_onData()`, `_cachedProjectConfig`)
- **Tool names:** PascalCase (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`)

### Error Handling

- Try/catch with graceful degradation
- Deny-by-default for security-sensitive operations
- Comprehensive input validation at system boundaries

### Concurrent Execution

- Read-only tools (`Read`, `Glob`, `Grep`, `ListDir`, `Diff`, `Lsp`, `AstSearch`) execute in parallel via `Promise.allSettled()`
- Write tools (`Write`, `Edit`, `Bash`, `Fetch`, `SubAgent`) execute sequentially

## Testing

- **Framework:** Node.js built-in `node:test` — no test framework dependency
- **Assertions:** `assert.ok()`, `assert.equal()`, `assert.strictEqual()`, `assert.throws()`
- **Pattern:** `describe()` / `it()` / `beforeEach()` blocks
- **Run tests:** `make test` or `node --test test/*.test.js`
- **CI environment variable:** Tests expect `INCEPTION_API_KEY` to be set (use any value for CI, e.g., `test-key-for-ci`)

Tests cover security boundaries, permission modes, sub-agent isolation, tool definitions, configuration, context management, hooks, MCP/skills integration, and end-to-end agent workflows.

## CI/CD

- **ci.yml:** Runs on every push/PR. Tests across Node 18/20/22 on Ubuntu, macOS, and Windows. Includes syntax linting.
- **release.yml:** Triggers on `v*` tags. Runs tests, publishes to npm, builds 6 platform binaries (Linux/macOS/Windows x64+ARM64), creates GitHub Release with checksums.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `INCEPTION_API_KEY` | **Required.** Mercury-2 API key from Inception Labs |
| `MERCURY_API_BASE` | Override API endpoint (default: `https://api.inceptionlabs.ai/v1`) |

## Key Architectural Decisions

1. **Zero dependencies** — Everything is built on Node.js built-ins for security and portability
2. **Security-first** — Multiple validation layers (hooks → permissions → sandbox → executor)
3. **OpenAI-compatible API** — Tool definitions use OpenAI function-calling format
4. **Content fencing** — Untrusted input is wrapped in fence markers to prevent prompt injection
5. **Token estimation** — Uses bytes/4 heuristic for fast token counting without a tokenizer

## Common Tasks for Contributors

### Adding a new tool
1. Define the schema in `src/tools/definitions.js` (OpenAI function-calling format)
2. Implement execution logic in `src/tools/executor.js`
3. Add permission classification (read-only tools can run in parallel)
4. Add tests in `test/tool-definitions.test.js`

### Adding a test
- Create or extend a file in `test/` using `node:test` (`describe`, `it`, `assert`)
- Run with `node --test test/your-file.test.js` or `make test` for all

### Modifying permissions or sandbox
- Permission logic lives in `src/permissions.js`
- Sandbox enforcement is in `src/sandbox.js`
- Both have dedicated test suites — update tests when changing behavior
