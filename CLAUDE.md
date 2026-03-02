# CLAUDE.md — Mercury Code

This file provides context for AI assistants working on the Mercury Code codebase.

## Project Overview

Mercury Code is an interactive AI coding assistant CLI powered by the **Mercury-2 diffusion model** from Inception Labs. It provides a terminal REPL with tool-calling capabilities (file operations, shell execution, code search), context compression, sub-agent orchestration, and sandbox isolation — all with **zero npm dependencies**.

- **Package name**: `mercury-code`
- **Binary names**: `mercury-code`, `mercury`
- **License**: MIT
- **Node.js requirement**: >= 18.17.0
- **API**: OpenAI-compatible endpoint at `https://api.inceptionlabs.ai/v1`
- **Auth**: `INCEPTION_API_KEY` environment variable
- **Model limits**: 128K context window, 50K max output tokens

## Repository Structure

```
.
├── cli.js                  # Entry point — arg parsing, launches REPL or single-shot mode
├── install.sh              # One-step global installer (Chinese-localized)
├── package.json            # Zero dependencies, ESM ("type": "module")
├── src/
│   ├── index.js            # Public API re-exports
│   ├── config.js            # API base URL, model name, defaults, MODEL_LIMITS
│   ├── client.js            # MercuryClient — streaming + non-streaming API calls
│   ├── repl.js              # MercuryRepl — main REPL loop, commands, permission system (~67KB, largest file)
│   ├── conversation.js      # Conversation — message history, token estimation, compression trigger
│   ├── context.js           # Context compression — Codex-style bytes/4 estimation, handoff summaries
│   ├── system-prompt.js     # System prompt builder — tools, trust modes, sandbox, project config
│   ├── memory.js            # MemoryManager + ConversationLog — .mercury/memory.md & conversation.jsonl
│   ├── history.js           # SessionHistory — save/restore sessions in ~/.mercury/sessions/
│   ├── rollback.js          # RollbackManager — checkpoint/undo system with git integration
│   ├── sandbox.js           # Sandbox — bubblewrap/firejail/ulimit isolation for Bash commands
│   ├── subagent.js          # SubAgent — isolated sub-agents with own context + tools
│   ├── agent-definitions.js # Built-in (explore, plan, general-purpose) + custom agent loading
│   ├── agent-teams.js       # AgentTeam — multi-agent collaboration with tasks, mailbox, dependencies
│   ├── labs.js              # Labs — experimental feature flags (master switch + per-feature toggles)
│   ├── lsp.js               # LspClient — Language Server Protocol integration (TS, Python, Go, Rust, C++)
│   ├── ast-search.js        # AST symbol search via regex patterns (zero-dep ctags-like approach)
│   ├── project-config.js    # .mercury.md / MERCURY.md project config loading
│   ├── i18n.js              # Internationalization — English/Chinese string tables, locale detection
│   ├── tools/
│   │   ├── definitions.js   # OpenAI function-calling tool schemas (16 tools)
│   │   └── executor.js      # ToolExecutor — tool dispatch, security enforcement, SSRF protection
│   └── ui/
│       ├── display.js       # Terminal display — ASCII logo, Codex-style framing, spinner, agent panels
│       └── agent-tabs.js    # Interactive agent tab bar with keyboard navigation
├── test/                    # Node.js built-in test runner (node --test)
│   ├── config.test.js
│   ├── context.test.js
│   ├── labs.test.js
│   ├── security.test.js     # Comprehensive security tests (SSRF, path traversal, injection)
│   ├── system-prompt.test.js
│   ├── tool-definitions.test.js
│   ├── agent-definitions.test.js
│   └── agent-teams.test.js
└── test-output/             # Sample output files from test runs
```

## Development Commands

```bash
# Run the CLI
node cli.js                    # Interactive REPL
node cli.js -p "prompt"        # Single-shot mode
node cli.js --verbose          # Debug logging

# Run tests (130 tests, all should pass)
node --test test/*.test.js

# Dev mode (verbose)
npm run dev
```

## Architecture & Key Design Decisions

### Zero Dependencies
The entire project uses **zero npm packages** — only Node.js built-in modules (`fs`, `path`, `http`, `https`, `readline`, `child_process`, `os`, `dns`, `net`). This is a deliberate design choice. Do not add npm dependencies.

### ESM Modules
The project uses ES modules (`"type": "module"` in package.json). All imports use `.js` extensions. Use `import`/`export`, not `require()`.

### API Communication (`src/client.js`)
- `MercuryClient` uses raw `node:http`/`node:https` requests (no fetch, no axios)
- Streaming uses SSE (Server-Sent Events) with an async generator pattern
- Queue + Promise-based async iterator for real-time chunk yielding
- Connection timeout: 120s

### Context Compression (`src/context.js`)
- Token estimation: `Math.ceil(byteLength / 4)` — Codex CLI approach, no tokenizer dependency
- Auto-compacts at 90% of effective context (configurable via `MERCURY_AUTOCOMPACT_PCT`)
- Super compress mode: 50% threshold, keeps only 2 recent turns
- Three outputs: handoff summary, memory facts, compaction boundary markers
- Full uncompressed log always available at `.mercury/conversation.jsonl`
- Progressive degradation warnings after 5+ compactions

### Tool System
**16 tools** defined in OpenAI function-calling format:
- **Core (always available)**: Read, Write, Edit, Patch, Bash, Glob, Grep, ListDir, Diff, Fetch, Lsp, AstSearch
- **Labs-gated**: SubAgent, SubAgentTeam, AgentTeams, ContextSearch

Tool execution flow: `repl.js` → `ToolExecutor.execute()` (in `tools/executor.js`) → individual handlers.

The executor enforces:
- Workspace boundary checks (path resolution, symlink escape detection, null byte rejection)
- Trust mode permissions (readonly / approval / open)
- Sandbox path and URL policies
- Content fencing (`[TOOL_OUTPUT_BEGIN]`/`[TOOL_OUTPUT_END]` markers) for prompt injection defense
- Sensitive env var stripping for Bash subprocesses
- SSRF protection (private IP blocking, DNS rebinding defense, credential-in-URL detection)

### Permission System (Trust Modes)
- **readonly**: Only read/search tools allowed
- **approval**: Writes and Bash require explicit user approval (default)
- **open**: All operations within workspace allowed automatically
- Toggle with `/trust <mode>` command

### Sandbox System (`src/sandbox.js`)
Three modes: `off`, `on` (default), `strict`
- Detection priority: bubblewrap (bwrap) > firejail > ulimit fallback
- Resource limits: 2GB memory, 100MB file size, 256 processes, 1024 open files
- Sensitive path deny-list (SSH keys, cloud credentials, shell history, etc.)
- System directory write protection (/etc, /usr, /bin, etc.)
- Strict mode: read-only root FS, optional network blocking, domain allowlist for Fetch

### Agent System
- **SubAgent** (`src/subagent.js`): Isolated agents with own conversation, tools, memory, and rollback. Max 30 turns, max 5 concurrent.
- **Agent Definitions** (`src/agent-definitions.js`): Three built-in types (explore, plan, general-purpose) + custom agents from `.mercury/agents/*.md` with YAML frontmatter.
- **Agent Teams** (`src/agent-teams.js`): Multi-agent collaboration with shared task lists, dependency resolution, and mailbox messaging.
- Sub-agents cannot spawn further sub-agents (prevents infinite recursion).
- In approval mode, Bash and Fetch POST are blocked for sub-agents (no user to approve).

### Labs System (`src/labs.js`)
Experimental features behind a master switch + per-feature toggles:
- **Agents**: subagent, subagent-team, agent-resume, agent-background, agent-worktree, agent-teams
- **Context & Memory**: context-search, project-config
- **Security**: sandbox
- State persisted to `~/.mercury/labs.json`
- Features can declare dependencies on other features

### LSP Integration (`src/lsp.js`)
- Auto-detects project language via marker files (tsconfig.json, go.mod, Cargo.toml, etc.)
- Spawns appropriate language server as a child process
- Supports: definition, references, hover, symbols, workspace_symbols, diagnostics
- Languages: TypeScript/JavaScript, Python, Go, Rust, C/C++
- Core tool — always available, not labs-gated

### Internationalization (`src/i18n.js`)
- Zero-dependency i18n system with ~200 translation keys
- Supported locales: English (`en`) and Chinese (`zh`)
- Locale detection chain: persisted config (`~/.mercury/locale.json`) → `MERCURY_LANG` env → `LANG`/`LC_ALL` env → default `en`
- Core API: `t(key)` for string lookup, `setLocale(locale)`, `getLocale()`, `getSupportedLocales()`, `detectLocale()`
- Fallback: current locale → English → raw key
- All user-facing strings in `display.js`, `agent-tabs.js`, and `repl.js` use `t()` calls
- `/lang [en|zh]` command to switch language at runtime; also accessible via `/settings language <locale>`
- Locale persistence: saves to `~/.mercury/locale.json` so preference survives between sessions

### AST Search (`src/ast-search.js`)
- Regex-based structural code search (ctags-like approach, zero external deps)
- Extracts: functions, classes, methods, interfaces, types, enums, imports, exports, variables, decorators, structs, traits, macros
- Languages: JavaScript, TypeScript, Python, Go, Rust
- Core tool — always available, not labs-gated

### REPL (`src/repl.js`)
The main 67KB file containing the interactive loop. Key features:
- Streaming responses with Codex-style framing
- Slash commands: /help, /clear, /trust, /reasoning, /labs, /sandbox, /agents, /history, /context, /compact, /diff, /copy, /init, /new, /edit, /settings, /supercompress, /contextsearch, /workspace, /lang
- Multiline input (Ctrl+J or `\` to open $EDITOR)
- `@file` mentions to include file contents in prompts
- `!cmd` for inline shell command execution
- Triple-ESC rollback mode with arrow key navigation
- Tab auto-completion for slash commands
- Long paste collapse (Codex-style) for large clipboard input
- Session auto-save on exit

### UI System (`src/ui/`)
- `display.js`: ANSI-colored terminal output, ASCII art logo with gradient animation, Codex-style response framing, context gauge (circular progress indicator), spinner with elapsed time, agent panel manager
- `agent-tabs.js`: Interactive navigable tab bar for sub-agents (↓ focus, ←/→ switch, Enter expand/collapse)

## Data Storage

| Location | Purpose |
|---|---|
| `.mercury/` | Project-level data (gitignored) |
| `.mercury/memory.md` | Persistent memory across compressions |
| `.mercury/conversation.jsonl` | Full uncompressed conversation log |
| `.mercury/agents/<id>/` | Per-agent transcripts and memory |
| `.mercury/teams/<name>/` | Team state persistence |
| `.mercury/agents/*.md` | Custom agent definitions (project-scoped) |
| `~/.mercury/` | Global user config |
| `~/.mercury/config.json` | Default model settings |
| `~/.mercury/labs.json` | Labs feature state |
| `~/.mercury/locale.json` | Persisted language preference |
| `~/.mercury/sessions/` | Saved session history (max 50) |
| `~/.mercury/mercury.md` | Global custom instructions |
| `~/.mercury/agents/*.md` | Custom agent definitions (global) |
| `.mercury.md` or `MERCURY.md` | Project-specific instructions (injected into system prompt) |

## Testing

Tests use **Node.js built-in test runner** (`node:test` module). No test framework dependency.

```bash
node --test test/*.test.js
```

**130 tests across 8 files:**
- `config.test.js` — Config defaults, API key validation, model limits
- `context.test.js` — Token estimation, compression thresholds, compaction state
- `labs.test.js` — Feature flags, dependencies, tool gating, persistence
- `security.test.js` — SSRF protection, path traversal, command injection, symlink escapes, sensitive paths, credential detection, DNS rebinding
- `system-prompt.test.js` — Prompt construction, trust modes, sandbox sections
- `tool-definitions.test.js` — Schema validation, required params, naming consistency
- `agent-definitions.test.js` — Built-in agents, YAML frontmatter parsing, tool resolution
- `agent-teams.test.js` — Task lifecycle, dependencies, mailbox, action validation

When adding features, add corresponding tests. Security-sensitive changes must include security tests.

## Coding Conventions

- **No npm dependencies** — use only Node.js built-ins
- **ESM modules** with `.js` extensions on all imports
- **No TypeScript** — plain JavaScript with JSDoc comments for type hints
- **Private methods**: prefixed with `_` (e.g., `_buildRecap`, `_detectGit`)
- **Constants**: UPPER_SNAKE_CASE at module level
- **Error handling**: `try/catch` with `/* non-critical */` comments for non-critical failures
- **File naming**: kebab-case (e.g., `agent-teams.js`, `ast-search.js`)
- **Export style**: named exports (no default exports)
- **Comment headers**: Each file starts with `// Mercury Code - <Module Name>` comment block
- **Security-first**: All file operations validate paths against workspace boundary, tool results are content-fenced

## Security Considerations

When modifying the codebase, be aware of these security patterns:

1. **Workspace boundary enforcement**: All file writes/edits must resolve inside the workspace. Check `_isInsideWorkspace()` and `_resolveAndValidatePath()` in `tools/executor.js`.
2. **SSRF protection**: The Fetch tool validates URLs against private IP ranges, blocks DNS rebinding, rejects credentials in URLs. See `_isPrivateIp()`, `_ssrfSafeDnsLookup()` in `tools/executor.js`.
3. **Command injection prevention**: Use `execFileSync` over `execSync` for parameterized commands. Git refs are validated before use.
4. **Content fencing**: All tool results are wrapped in `[TOOL_OUTPUT_BEGIN]`/`[TOOL_OUTPUT_END]` markers to defend against prompt injection from file contents or command output.
5. **Sensitive env stripping**: Bash subprocesses receive a sanitized environment with secret-pattern-matching keys removed.
6. **Symlink escape detection**: File paths are resolved via `realpath` and checked against workspace ancestors.
7. **Null byte rejection**: Paths containing null bytes (`\0`) are rejected.

## Common Modification Patterns

### Adding a new tool
1. Define the tool schema in `src/tools/definitions.js` (OpenAI function format)
2. Add the handler in `src/tools/executor.js` (`execute()` method switch cases)
3. If labs-gated, add a feature entry in `src/labs.js` with the tool name in `tools` array
4. Update `src/system-prompt.js` to include the tool description (core tools in main section, labs tools in `_labsToolsSection()`)
5. Add tests in `test/tool-definitions.test.js` (schema validation) and `test/security.test.js` if security-relevant

### Adding a new slash command
1. Add command handling in `src/repl.js` inside the `_handleCommand()` method
2. Add to the help table in `src/ui/display.js` `printHelp()` function
3. Add tab-completion entry in the `COMMANDS` array in `src/repl.js`
4. Add translation keys for all user-facing strings in `src/i18n.js` (both `en` and `zh`)

### Adding new translatable strings
1. Add the key to both `en` and `zh` string tables in `src/i18n.js`
2. Use `t("your.key")` in the source file instead of hardcoded strings
3. Keys are organized by category (e.g., `welcome.*`, `help.*`, `status.*`, `repl.*`, `lang.*`)

### Adding a new labs feature
1. Add feature definition to the `FEATURES` array in `src/labs.js`
2. Set `default`, `tools` array (if it gates a tool), and `requires` (dependencies)
3. Check activation with `labs.isActive("feature-id")` or `labs.isToolAllowed("ToolName")`

### Adding a new built-in agent type
1. Add to `BUILTIN_AGENTS` in `src/agent-definitions.js`
2. Define: name, description, systemPrompt, tools (allowlist), maxTurns
3. Add test in `test/agent-definitions.test.js`
