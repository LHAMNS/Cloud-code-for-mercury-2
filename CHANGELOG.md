# Changelog

## v1.4.0 (2026-03-04)

### Enhanced Sandbox Security
- **Rate limiting**: Per-minute rate buckets for Bash and Fetch commands with configurable limits per sandbox mode (strict: 30/20 per min, standard: 60/40 per min). `checkRateLimit()` returns retry-after time when exceeded.
- **Content scanning**: `SECRET_CONTENT_PATTERNS` detects AWS access keys, private keys, JWTs, GitHub tokens, and generic API key patterns in file writes. Enabled via `scanContent` option.
- **Symlink policy enforcement**: Three policies — `resolve` (default, follows symlinks with ancestor resolution), `block` (rejects all symlinks), `allow` (permits symlinks within workspace). `checkSymlink()` method validates before file operations.
- **Write validation**: `checkWrite()` enforces maximum file size (`maxWriteSize`), blocks dangerous file extensions (`.exe`, `.dll`, `.so`, `.sh`, `.bat`, `.cmd`, `.ps1`, `.msi`, `.app`, `.dmg`, `.deb`, `.rpm`) in strict mode, and runs content scanning for secrets.
- **Security event logging**: In-memory ring buffer (last 200 events) with `_logSecurityEvent()`, `getSecurityEvents()`, `exportSecurityLog()`, and `getSecuritySummary()` for audit trail.
- **Expanded sensitive paths**: Added `.cargo/credentials`, `.gradle/gradle.properties`, `.m2/settings.xml`, `.gem/credentials`, `.op`, `.config/op`, `.config/Bitwarden CLI` to deny list. Added `/var/spool` and `/root` to system write deny list.
- **Config serialization**: `toSubAgentConfig()` preserves all new security options (symlinkPolicy, scanContent, maxWriteSize, rateLimits).

### Hardened Path & URL Checking
- **checkPath hardening**: Operation type validation (must be "read" or "write"), realpath resolution via `fs.realpathSync` with `_resolveViaAncestor()` fallback for non-existent paths, strict mode enforces workspace + `/tmp` boundary for BOTH read AND write operations.
- **checkUrl hardening**: Strict mode with `allowNetwork=false` blocks ALL URLs. Strict mode blocks ALL HTTP including localhost (no exception). Domain allowlist normalization: lowercase + trailing dot stripping to prevent bypass.

### AI Safety Decide Mode
- **New trust mode** (`aiSafetyDecide`): Independent AI safety judge evaluates all tool calls before execution.
- **Safety evaluation criteria**: Workspace boundary, command safety, network safety, data protection, proportionality, prompt injection detection, and agent operations (sub-agents, agent teams).
- **Three-outcome decisions**: ALLOW (auto-execute), DENY (block with suggestions), ESCALATE (prompt user for uncertain cases).
- **Fail-safe design**: Errors default to ESCALATE. Low-confidence ALLOW auto-escalates to user approval.
- **Decision caching**: Identical tool calls reuse prior decisions for performance.
- **Trust level**: 0.5 (between open:0 and acceptEdits:1) — nearly open but with AI-powered safety review.
- **System prompt integration**: `<permissions mode="aiSafetyDecide">` section explains mode behavior to the model.

### Parallel Tool Execution
- **Read-only tool parallelization**: Read, Glob, Grep, ListDir, Diff, Lsp, AstSearch run via `Promise.allSettled()` for concurrent execution.
- **Write tool sequencing**: Write, Edit, Patch, Bash, Fetch, SubAgent, SubAgentTeam, AgentTeams execute sequentially to preserve ordering guarantees.
- **Pre-validation phase**: All tool calls validated (hooks, permissions, fetch blocking) before execution begins.
- **System prompt guidance**: `<parallel-tool-calling>` section instructs the model to maximize parallelism for independent operations.

### Sandbox Integration in Tool Executor
- **File operations**: `checkSymlink()` and `checkWrite()` (size, extension, content scanning) integrated into `_writeFile`.
- **Bash commands**: `checkRateLimit('bash')` enforced before command execution.
- **Fetch requests**: `checkRateLimit('fetch')` enforced for initial requests (not redirect follows).

### XML-Structured System Prompt
- All system prompt sections wrapped in semantic XML tags: `<identity>`, `<tools>`, `<behavior>`, `<rules>`, `<safety>`, `<workspace-boundary>`, `<operational-safety>`, `<prompt-injection-defense>`, `<context-management>`, `<compression>`, `<context-editing>`, `<memory-and-config>`, `<hooks>`, `<permission-rules>`, `<environment>`, `<sandbox>`, `<permissions>`.
- Original content fully preserved — XML tags added for improved model comprehension without content changes.

### Deep Security Audit (56 fixes across 8 files)
- **sandbox.js**: Null-byte/type validation in checkPath, null-byte in _shellEscape, content type validation, property freezing after init, defensive array copies, domain validation, mode validation, checkSymlink fixes, Buffer content scanning, strict mode secret blocking, rate limit opType validation
- **permissions.js**: Command substitution detection, newline segmentation, managed rules serialization, input validation, removeRule fix, disableBypass truthy check
- **executor.js**: IPv6-mapped IP bypass, DNS fail-closed, removed NODE_OPTIONS, workspace boundary for _readFile, symlink check for _readFile, IP octal/hex/decimal blocking, 0.0.0.0/8 range, null bytes in LSP/AstSearch, workspace checks in LSP/AstSearch, URL credential bypass fix
- **subagent.js**: Agent ID sanitization, runningCount race fix, Fetch blocking extended to acceptEdits/aiSafetyDecide, background agent cleanup, universal ask-decision blocking, fence marker sanitization, ContextSearch removed from READ_ONLY_TOOLS
- **hooks.js**: Env var sanitization (strip API keys/secrets), 30s timeout cap, project hook marking, prevent project hooks from "allow" bypass, unknown event warnings
- **agent-teams.js**: Circular dependency detection, task limit (1000), mailbox limit (5000), execution timeout (10 min), state validation on load, content fences for dependency results/messages
- **agent-definitions.js**: Prevent project override of built-in agents, permissionMode validation, name sanitization, matchAgentForTask hardened with stop words and threshold
- **ai-safety-decide.js**: toolName/workspace sanitization, cache TTL (5 min), non-greedy JSON regex, userTask in cache key, Promise.race timeout enforcement, privilege-escalation criterion

### AiSafetyDecider Runtime Integration
- **cli.js**: Added `aiSafetyDecide` to `--trust-mode` valid modes and help text
- **repl.js**: Import, instantiate, and wire AiSafetyDecider into _checkPermission and tool execution loop
- **Decision flow**: Read tools pass through → non-read tools flagged `needsAiSafety` → DENY blocks, ESCALATE asks user, ALLOW proceeds
- **/trust command**: Option 6 (`aisafetydecide`) with lazy instantiation on mode switch
- **Help text**: All 8 trust modes documented in CLI help, /trust usage, and /help output

### Test Suite
- **464 tests** across 122 test suites (+49 new tests), covering:
  - Hardened checkPath: operation validation, strict boundary enforcement, symlink escape detection, new sensitive paths
  - Hardened checkUrl: localhost HTTP blocked in strict, allowNetwork=false, case normalization, trailing dot normalization
  - Sandbox rate limiting: within/exceeding limits, retry-after time, disabled when off
  - Sandbox write validation: size limits, dangerous extensions, content scanning (AWS keys, private keys)
  - Sandbox symlink policy: block/allow/resolve policies
  - Security event logging: event capture, export, summary statistics
  - Config serialization with new security features
  - AI Safety Decide mode: 6-mode permission system, trust level ordering, deny rule respect
  - System prompt: XML-structured trust modes (readonly, approval, open, aiSafetyDecide)
  - URL protocol enforcement (file://, ftp:// blocked)
  - Null byte rejection in ListDir, Glob, Grep
  - Deny rule compound command detection (&&, ;, |)
  - Managed deny rule removal protection

## v1.3.0 (2026-03-03)

### MCP (Model Context Protocol) Support
- **MCP server manager** (`src/mcp.js`): Full MCP client implementation supporting stdio and HTTP transports.
  - JSON-RPC 2.0 protocol with `initialize`, `tools/list`, `tools/call` methods
  - Automatic tool discovery and namespaced tool names (`mcp__<server>__<tool>`)
  - Config loading from `.mercury/mcp.json`, `.mcp.json`, or `~/.mercury/mcp.json`
  - Connection status monitoring and graceful shutdown
  - CLI flag: `--mcp-config <path>` for explicit config file
- **REPL integration**: `/mcp status` and `/mcp reload` commands, MCP status panel on startup

### Skills System
- **Skills engine** (`src/skills.js`): Prompt-based extensions defined in SKILL.md files with YAML frontmatter.
  - Skill discovery from `.mercury/skills/*.md` (project) and `~/.mercury/skills/*.md` (user)
  - Argument substitution via `{{argument}}` and `$ARGUMENTS` placeholders
  - Per-skill model override, allowed/disallowed tools, agent type selection
  - Model-invocable and user-invocable skill types
  - Tab completion for `/skillname` commands
- **REPL integration**: `/skills` command, skill invocation via `/skillname [args]`

### Plan Mode
- **Read-only analysis mode**: `--plan` CLI flag or `/trust plan` command
  - Restricts model to read-only tools (Read, Glob, Grep, ListDir, Diff)
  - Styled plan mode banner with instructions
  - Aliased as `readonly` trust mode with plan file output

### Enhanced Trust Modes (5-mode system)
- **Full Claude Code parity**: `open`, `acceptEdits`, `approval` (default), `dontAsk`, `readonly`
- **acceptEdits mode**: Auto-approves Write/Edit/Patch within workspace, prompts for Bash/Fetch/MCP
- **dontAsk mode**: Denies all tools except read-only set
- **Plan mode alias**: Maps to `readonly` with plan file output enabled
- **CLI flag**: `--trust-mode <mode>` for startup configuration

### Cross-Platform Support
- **Linux**: x64 and ARM64
- **macOS**: Intel (x64) and Apple Silicon (arm64)
- **Windows**: Native support with PowerShell install script (`install.ps1`)
- **Postinstall script** (`scripts/postinstall.js`): Auto-configures permissions and creates `~/.mercury` config directory
- **No os/cpu restrictions** in package.json for universal `npm install -g mercury-code`

### UI Redesign
- **Mercury-themed welcome screen**: True-color (24-bit RGB) Mercury palette with realistic planet surface colors
- **Starfield background**: Animated stars with twinkle effects using Unicode star characters
- **Two display modes** (togglable via `/settings planet_logo on|off`):
  - **Planet mode**: Full Mercury planet ASCII art with MERCURY CODE text overlaid, animated emergence from center
  - **Classic mode** (default): Block-letter MERCURY CODE text on starfield with shooting star animation and gradient text reveal
- **Shooting star animation**: Multi-frame meteor streak across the starfield
- **MCP status panel**: Styled connection status for MCP servers on startup
- **Plan mode banner**: Amber-styled read-only analysis mode indicator
- **Tool icons**: Custom icons for Skill, MCP, AgentTeams, LSP, and AstSearch tools

### Conversation Export
- **`/export [filename]`**: Export full conversation history to a file
  - Supported formats: `.md` (Markdown), `.json` (structured JSON), `.txt` (plain text), `.html` (styled HTML)
  - If no filename provided, interactively prompts the user
  - Markdown export includes system prompt (collapsed), user/assistant messages, and tool calls
  - HTML export features dark-themed GitHub-style styling
  - JSON export includes full metadata (session ID, model, workspace, timestamps)

### Easter Egg
- **Double-tap Enter** on empty prompt to enter logo edit mode
- **Type "cold"** to discover Mercury's secret (谐音梗: code → cold, Mercury's night side is −180°C!)

### Test Suite
- **415 tests** across 109 test suites (+40 new tests), covering:
  - McpManager: creation, config loading, tool identification, error handling, shutdown
  - SkillManager: discovery, completions, tool definitions, empty state handling
  - Skill: creation, argument rendering, defaults, model invocation control
  - Enhanced Trust Modes: 5-mode exports, TRUST_LEVELS ordering
  - Display Module: function exports, MCP status, context gauge
  - Tool Definitions: base tool completeness, function calling format validation
  - CLI flags: plan, trust-mode, mcp-config, sandbox support
  - Package.json: version, binaries, cross-platform, keywords, postinstall
  - Sandbox: cross-platform path handling, mode exports
  - Postinstall and Windows install scripts

## v1.2.0 (2026-03-03)

### Enhanced Permission System (Claude Code Parity)
- **5 permission modes**: `open`, `acceptEdits`, `approval` (default), `dontAsk`, `readonly` — matching Claude Code's full mode spectrum.
  - `acceptEdits`: Auto-approves file edits (Write/Edit/Patch), asks for Bash/Fetch
  - `dontAsk`: Denies everything not explicitly pre-approved via allow rules
- **Shell operator decomposition**: Bash permission rules now decompose commands at `&&`, `||`, `;`, `|` operators and validate each segment independently. Prevents `Bash(git *)` from matching `git status && rm -rf /`.
- **Permission rules inheritance chain**: ToolExecutor → SubAgent → AgentTeam teammates now properly propagate `permissionRules` from parent to child.
- **canUseTool runtime callback**: Optional async callback `(toolName, input, context) → {behavior, updatedInput}` for programmatic, context-sensitive permission decisions.
- **Settings precedence**: 5-level hierarchy (managed → CLI → local project → shared project → user global), with managed deny rules that cannot be overridden.
- **mergeFromParent()**: Additive rule inheritance where parent deny rules are always inherited and child deny rules can override parent allow rules.
- **Dynamic rules**: `addRule()`/`removeRule()` for runtime rule modification.
- **Permission audit logging**: Optional logging of all permission decisions to `.mercury/audit/permissions.log`.
- **Unified TRUST_LEVELS**: Consolidated 5-mode trust level ordering across `permissions.js` and `subagent.js` (open:0 < acceptEdits:1 < approval:2 < dontAsk:3 < readonly:4).

### Test Suite
- **375 tests** across 98 test suites (+57 new tests), covering:
  - All 5 permission modes with correct tool access behavior
  - TRUST_LEVELS ordering and 5-mode trust clamping
  - Shell operator decomposition (&&, ||, ;, | protection)
  - canUseTool callback (deny, allow, error fallback, updatedInput)
  - Permission serialization (toConfig/fromConfig/mergeFromParent)
  - Dynamic rule management (addRule/removeRule deduplication)
  - Full inheritance chain (ToolExecutor → SubAgent → AgentTeam)
  - Audit logging configuration and source tracking

## v1.1.0 (2026-03-03)

### Security Fixes
- **Trust mode escalation prevention**: Agent definitions can no longer override parent trust mode to a more permissive level (e.g. `approval` → `open`). The `_clampTrustMode()` function ensures sub-agents can only restrict, never widen permissions.
- **AgentTeams blocked in sub-agents**: The `AgentTeams` tool is now blocked alongside `SubAgent`, `SubAgentTeam`, and `ContextSearch` to prevent resource exhaustion from recursive team spawning.
- **Fetch completely blocked for sub-agents in approval mode**: Prevents data exfiltration via URL query params or request body.
- **SSRF protection**: DNS resolution checks block requests to private, loopback, and link-local addresses.
- **Suspicious command detection**: Blocks curl/wget exfiltration, reverse shells, `rm -rf /`, and base64 pipe attacks.
- **Content fence markers**: Tool output wrapped in untrusted-content markers to mitigate prompt injection.
- **Environment variable sanitization**: Strips API keys, tokens, credentials from child process environments.
- **Null byte injection prevention**: Blocks null bytes in file paths for all file operations.
- **Path traversal defense**: Uses `realpathSync()` to resolve symlinks and prevent symlink escape attacks.
- **Git ref validation**: Only allows safe characters in git refs to prevent command injection.
- **Query parameter blocking in readonly mode**: Prevents data exfiltration via GET query params.
- **URL credential blocking**: Blocks URLs with embedded `user:password` credentials.

### Features
- **SubAgent system**: Spawn isolated sub-agents for parallel task execution with their own conversation context, memory, and rollback support.
- **AgentTeam system**: Collaborative multi-agent teams with shared task lists, mailbox messaging, and dependency-aware task scheduling.
- **Agent definitions**: Define custom agent types via markdown frontmatter in `.mercury/agents/`. Built-in types: `explore`, `plan`, `general-purpose`.
- **Agent resume**: Resume prior agent conversations by ID (labs feature).
- **Background agents**: Run sub-agents asynchronously with output file monitoring (labs feature).
- **Worktree isolation**: Execute sub-agents in isolated git worktrees (labs feature).
- **Hooks system**: Pre/post tool use hooks, subagent lifecycle hooks, worktree hooks, compaction hooks.
- **Permission rules**: Allow/ask/deny rules with glob-pattern specifiers for fine-grained tool access control.
- **Memory hierarchy**: Per-agent memory with parent→child inheritance.
- **Context compression**: Codex-style stale tool output trimming and context compaction.
- **9 slash commands**: `/init`, `/compact`, `/model`, `/cost`, `/doctor`, `/login`, `/logout`, `/config`, `/memory`.
- **Labs mode**: Experimental features behind toggleable flags (`/labs`).
- **LSP integration**: Language server protocol support for code intelligence.
- **AST search**: Symbol search and file outline via tree-sitter.

### Test Suite
- **318 tests** across 87 test suites, covering:
  - Agent definitions, tool resolution, and task matching
  - AgentTeam task management, messaging, dependencies, and lifecycle
  - Tool definitions completeness and parameter validation
  - Security: workspace boundaries, path traversal, suspicious commands, sandbox path/URL checking, readonly mode, git ref validation, pattern length limits, environment sanitization, credential blocking
  - End-to-end: SubAgent instantiation, model/trust/permission overrides, progress callbacks, concurrent execution, diamond dependency graphs, team persistence
  - Deep security: permission propagation, rule matching edge cases, recursion prevention across all trust modes, trust mode escalation prevention

## v1.0.0

Initial release.
