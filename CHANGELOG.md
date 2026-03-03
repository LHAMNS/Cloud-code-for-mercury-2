# Changelog

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
