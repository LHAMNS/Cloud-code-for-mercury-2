# Mercury Code — Test Coverage Analysis

## Executive Summary

The Mercury Code codebase currently has **zero test coverage**. There are no test files, no test
framework configured, and no test scripts in `package.json`. The project consists of 21 JavaScript
modules (~4,000+ lines of production code) with no automated testing of any kind.

This document identifies the highest-impact areas where tests should be added, ordered by priority.

---

## Current State

| Metric | Value |
|--------|-------|
| Source files | 21 (`.js`) |
| Test files | **0** |
| Test framework | **None configured** |
| Coverage tool | **None configured** |
| CI/CD test step | **None** |
| `npm test` script | **Missing** |

### Source File Inventory

| File | Lines (approx) | Complexity | Test Priority |
|------|----------------|------------|---------------|
| `src/tools/executor.js` | ~1,200 | Very High | **Critical** |
| `src/repl.js` | ~1,000+ | Very High | Medium |
| `src/sandbox.js` | ~490 | High | **Critical** |
| `src/context.js` | ~377 | High | **High** |
| `src/agent-definitions.js` | ~368 | Medium | High |
| `src/subagent.js` | ~500+ | High | Medium |
| `src/client.js` | ~255 | Medium | **High** |
| `src/rollback.js` | ~177 | Medium | High |
| `src/conversation.js` | ~120 | Medium | High |
| `src/memory.js` | ~117 | Low-Medium | Medium |
| `src/history.js` | ~150 | Low-Medium | Low |
| `src/ast-search.js` | ~300+ | Medium | Medium |
| `src/lsp.js` | ~400+ | Medium | Low |
| `src/config.js` | ~30 | Low | Low |
| `src/project-config.js` | ~80 | Low | Low |
| `src/system-prompt.js` | ~200 | Low | Low |
| `src/tools/definitions.js` | ~300 | Low | Low |
| `src/ui/display.js` | ~500+ | Low | Low |
| `src/ui/agent-tabs.js` | ~200 | Low | Low |
| `src/index.js` | ~30 | Low | Low |
| `cli.js` | ~80 | Low | Low |

---

## Priority 1 — Critical (Security & Correctness)

### 1. `src/sandbox.js` — Process Isolation & Path Policy

**Why this is critical:** The sandbox is the primary security boundary. Bugs here could allow
an AI-driven tool executor to read SSH keys, cloud credentials, or write to system paths.

**What to test:**

- **`checkPath()` — sensitive path blocking:**
  - Verify all entries in `SENSITIVE_PATHS` are blocked for both read and write (`.ssh`, `.gnupg`,
    `.aws/credentials`, `.env`, `.docker/config.json`, etc.)
  - Verify paths *inside* sensitive directories are also blocked (e.g., `~/.ssh/id_rsa`)
  - Verify paths outside sensitive dirs are allowed
  - Verify `additionalDenyPaths` works correctly

- **`checkPath()` — system path blocking for writes:**
  - Verify writes to `/etc`, `/usr`, `/bin`, `/lib`, `/proc`, `/sys`, `/dev` are blocked
  - Verify reads from system paths are *allowed* in `on` mode but *blocked* in `strict` mode

- **`checkPath()` — strict mode workspace enforcement:**
  - Reads outside workspace are blocked (except `/tmp`)
  - Reads inside workspace are allowed
  - `/tmp` reads are allowed as an exception

- **`checkUrl()` — URL policy:**
  - Plain HTTP blocked in strict mode (except localhost/127.0.0.1)
  - Domain allowlist enforcement in strict mode
  - Subdomain matching (e.g., `api.github.com` matches `github.com`)
  - Invalid URLs are rejected

- **`wrapCommand()` — sandbox backend selection:**
  - bwrap is preferred when available
  - firejail is used as fallback
  - ulimit is the last resort
  - Correct flags are generated for each backend
  - `--unshare-net` is applied in strict mode

- **`_shellEscape()` — shell injection prevention:**
  - Single quotes in input are properly escaped
  - Special characters don't break out of quoting

- **`toSubAgentConfig()` — config propagation:**
  - When `sandboxSubAgents` is true, full config is propagated
  - When `sandboxSubAgents` is false, mode is set to `off`

- **Edge cases:**
  - Sandbox mode `off` allows everything
  - Symlink traversal (does `path.resolve()` follow symlinks out of workspace?)
  - Relative paths like `../../.ssh/id_rsa` are resolved correctly

**Estimated test count:** ~30-40 unit tests

---

### 2. `src/tools/executor.js` — Tool Execution Engine

**Why this is critical:** This is the code that actually reads/writes files, runs bash commands,
and makes HTTP requests on behalf of the AI. Incorrect behavior could destroy files, leak data, or
execute arbitrary commands unsafely.

**What to test:**

- **`glob()` / `globToRegex()` helper functions:**
  - Standard patterns: `*.js`, `**/*.ts`, `src/**/*.test.js`
  - Edge cases: empty pattern, pattern with special regex chars, deeply nested dirs
  - Symlink handling

- **Read tool:**
  - Reads file content correctly
  - Respects `offset` and `limit` parameters
  - Truncates at `READ_MAX_CHARS` (140,000)
  - Returns appropriate error for non-existent files
  - Sandbox path check is enforced (blocked files return error, not throw)

- **Write tool:**
  - Creates new files
  - Overwrites existing files
  - Creates parent directories as needed
  - Sandbox write-path check is enforced

- **Edit tool (exact string replacement):**
  - Replaces first occurrence of `old_string`
  - Fails when `old_string` not found
  - Fails when `old_string` matches multiple locations (ambiguous)
  - Preserves file encoding and line endings

- **Bash tool:**
  - Command execution with timeout
  - Environment sanitization (`_sanitizedEnv()` strips secrets)
  - Sandbox wrapping is applied
  - Output truncation for very large outputs
  - Error handling for non-zero exit codes

- **`_sanitizedEnv()` — environment variable filtering:**
  - Keys matching `/KEY/i`, `/SECRET/i`, `/TOKEN/i`, `/PASSWORD/i`, etc. are removed
  - `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM` are preserved
  - Edge cases: `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`

- **Grep tool:**
  - Pattern matching with regex
  - File type filtering
  - Context lines (`-A`, `-B`, `-C`)
  - Result limiting

- **Fetch tool:**
  - HTTP/HTTPS requests
  - Sandbox URL check is enforced
  - Response truncation
  - Timeout handling
  - Error responses

- **Diff tool:**
  - File-to-file comparison
  - Git ref comparison via `isValidGitRef()` validation

- **`isValidGitRef()` — injection prevention:**
  - Valid hex hashes (7-40 chars) are accepted
  - Non-hex strings are rejected
  - Empty/null/undefined inputs are rejected
  - Strings with shell metacharacters are rejected

**Estimated test count:** ~50-70 unit tests

---

## Priority 2 — High (Core Logic)

### 3. `src/context.js` — Context Compression

**Why this matters:** Context compression is responsible for summarizing and truncating the
conversation when it gets too long. Bugs here could cause data loss (dropped messages),
infinite loops, or broken conversation state.

**What to test:**

- **`estimateTokens()`:**
  - ASCII text: `"hello"` → `ceil(5/4)` = 2
  - Empty string → 0
  - Null/undefined → 0
  - Multi-byte UTF-8 (CJK characters): byte count is larger than char count
  - Very long strings (performance)

- **`estimateMessagesTokens()`:**
  - Empty array → 0
  - Messages with `content` only
  - Messages with `tool_calls` (JSON serialized)
  - Messages with `tool_call_id`
  - Per-message overhead of 4 tokens

- **`_findTurnCutoff()`:**
  - Correctly identifies the index of the Nth-from-last user message
  - Returns 0 when fewer than `keepTurns` user messages exist
  - Handles consecutive user messages correctly

- **`_parseSections()`:**
  - Parses `## SUMMARY` + `## MEMORY` correctly
  - Handles SUMMARY before MEMORY
  - Handles MEMORY before SUMMARY
  - Handles missing MEMORY section
  - Handles missing SUMMARY section
  - Handles `#`, `##`, `###` heading levels

- **`_buildRecap()`:**
  - User messages are truncated to 400 chars
  - Prior summaries are labeled as `PRIOR SUMMARY`
  - Tool calls are summarized with `_toolArgSummary()`
  - Tool results >300 chars are truncated with error detection
  - Each tool type produces correct summary format

- **`_buildFallbackSummary()`:**
  - Extracts files read, files written, commands, user requests
  - Handles empty conversation

- **`_collectRecentUserMessages()`:**
  - Respects token budget (20K)
  - Returns messages in chronological order
  - Skips prior summary messages
  - Stops when budget exhausted

- **`compressContext()` / `superCompressContext()`:**
  - Returns false when below threshold
  - Mutates the messages array (splice) correctly
  - Retry logic on API failure (2 retries with backoff)
  - Fallback summary used when API fails completely
  - Memory is appended when available

**Estimated test count:** ~35-45 unit tests

---

### 4. `src/client.js` — API Client

**Why this matters:** Incorrect request building or response parsing could cause silent failures,
data corruption, or security issues (API key leakage).

**What to test:**

- **`_buildRequestBody()`:**
  - Default model, max_tokens, temperature, reasoning_effort are set
  - Options override defaults
  - Messages with `null` content (assistant + tool_calls) are preserved
  - Messages with `null`/`undefined` content (other roles) get empty string
  - `tools`, `tool_choice`, `stop` are conditionally included
  - `diffusing` flag sets both `diffusing: true` and `stream: true`

- **`chatCompletion()`:**
  - Sets `stream: false`
  - Returns parsed JSON response
  - Throws on non-200 status
  - Throws on invalid JSON
  - Handles timeout

- **`chatCompletionStream()`:**
  - Yields SSE chunks correctly
  - Handles `data: [DONE]` terminator
  - Handles malformed chunks gracefully (skips them)
  - Handles incomplete lines in buffer (split across TCP packets)
  - Throws on non-200 status
  - Request is destroyed when consumer stops early (finally block)

- **Constructor:**
  - API key from options vs. environment
  - Base URL override

**Estimated test count:** ~20-25 unit tests (mocking HTTP)

---

### 5. `src/rollback.js` — Undo/Time-travel

**Why this matters:** The rollback system manipulates git state and conversation history.
Incorrect rollback could destroy the user's work.

**What to test:**

- **`isValidGitRef()`:**
  - Valid: `"abc1234"`, `"abc1234567890abcdef1234567890abcdef123456"` (7-40 hex)
  - Invalid: `""`, `null`, `undefined`, `"not-hex"`, `"abc123; rm -rf /"`, short (< 7), long (> 40)

- **`createCheckpoint()`:**
  - Deep clones messages (mutation of original doesn't affect checkpoint)
  - Truncates user message to 120 chars
  - Captures git hash when in a git repo
  - Sequential index assignment

- **`fullRollback()`:**
  - Returns cloned messages from the checkpoint
  - Prunes checkpoints after the restored one
  - Stashes current changes before restoring
  - Uses `execFileSync` (not `execSync`) to prevent injection
  - Validates git hash before checkout
  - Returns `fileRestored: false` when git operations fail
  - Returns `restored: false` for invalid checkpoint index

- **`contextRollback()`:**
  - Returns cloned messages without touching git
  - Prunes checkpoints after the restored one

- **Edge cases:**
  - Rollback when not in a git repo (`_useGit = false`)
  - Rollback to the most recent checkpoint
  - Rollback to checkpoint 0

**Estimated test count:** ~20-25 unit tests

---

### 6. `src/conversation.js` — Conversation Manager

**What to test:**

- **Message management:**
  - `addUserMessage()`, `addAssistantMessage()`, `addToolResult()` build correct objects
  - `getMessages()` prepends system prompt
  - Memory content is injected into system prompt
  - `clear()` resets messages but preserves memory

- **Token estimation (`getTokenEstimate()`):**
  - Falls back to heuristic when no API usage available
  - Uses API-reported `total_tokens` as baseline when available
  - Only estimates tokens for messages added *after* last API report
  - `getUsagePercent()` formats correctly

- **`compress()`:**
  - Delegates to `compressContext` or `superCompressContext` based on `superMode`
  - Reloads memory after compression

**Estimated test count:** ~15-20 unit tests

---

### 7. `src/agent-definitions.js` — Agent Discovery & Management

**What to test:**

- **`parseFrontmatter()`:**
  - Key-value pairs: strings, numbers, booleans
  - Inline arrays: `[a, b, c]`
  - Multi-line arrays with `- item` syntax
  - Quoted values (single and double quotes stripped)
  - Comments (lines starting with `#`) are ignored
  - Missing frontmatter returns empty object + full body
  - Malformed frontmatter (no closing `---`)

- **`loadAgentFromMarkdown()`:**
  - Name defaults to filename when not in frontmatter
  - All fields are correctly extracted
  - Missing optional fields get defaults

- **`resolveAgentTools()`:**
  - `ALWAYS_BLOCKED_TOOLS` (`SubAgent`, `SubAgentTeam`, `ContextSearch`) are filtered out
  - Allowlist filtering works
  - Denylist filtering works
  - `readonly` trust mode restricts to read-only tools
  - `null` tools means "all tools"

- **`matchAgentForTask()`:**
  - "explore the codebase" → `explore` agent
  - "plan the architecture" → `plan` agent
  - Unknown task → `general-purpose` agent
  - Custom agent matched by description keyword overlap (≥3 words)

- **`discoverAgents()`:**
  - Built-in agents are always present
  - Project agents override global agents with same name
  - Missing directories don't cause errors

- **`formatAgentList()` / `scaffoldAgent()`:**
  - Output format is correct
  - Scaffold creates valid markdown with frontmatter

**Estimated test count:** ~30-35 unit tests

---

## Priority 3 — Medium

### 8. `src/memory.js` — Persistent Memory

**What to test:**
- `MemoryManager.read()` returns empty string when file doesn't exist
- `MemoryManager.append()` creates directory, deduplicates, adds timestamp
- `MemoryManager._trimOldest()` removes oldest sections when over `MAX_MEMORY_SIZE`
- `ConversationLog.append()` writes JSONL lines
- `ConversationLog.clear()` truncates file

**Estimated test count:** ~10-15 unit tests

### 9. `src/ast-search.js` — Symbol Extraction

**What to test:**
- Regex patterns correctly extract functions, classes, methods from JS/TS/Python/Go/Rust
- `fileOutline()` returns structured symbol list
- `searchSymbols()` searches across workspace files
- `formatSearchResults()` produces readable output

**Estimated test count:** ~15-20 unit tests

### 10. `src/subagent.js` — Sub-agent System

**What to test:**
- Concurrency limits (`MAX_CONCURRENT = 5`)
- Background agent tracking
- `runSubAgentTeam()` parallel execution
- Agent isolation (worktree mode)
- Turn limits (`MAX_SUB_TURNS = 30`)

**Estimated test count:** ~15-20 unit tests (requires mocking)

---

## Priority 4 — Low (UI, Config, Glue)

| Module | What to test | Est. tests |
|--------|-------------|------------|
| `src/history.js` | Session save/load/list/prune, auto-summary | ~8 |
| `src/config.js` | `getApiKey()` from env, default values | ~5 |
| `src/project-config.js` | Config discovery chain, safe read | ~5 |
| `src/system-prompt.js` | Prompt assembly with trust/sandbox sections | ~5 |
| `src/ui/display.js` | Output formatting (snapshot tests) | ~5 |
| `cli.js` | Argument parsing | ~5 |

---

## Recommended Test Infrastructure

### Framework: Node.js Built-in Test Runner

Since Mercury Code has **zero dependencies**, using Node's built-in test runner (`node:test`)
preserves this design choice:

```js
// Example: test/sandbox.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Sandbox, SANDBOX_ON, SANDBOX_STRICT } from "../src/sandbox.js";
```

### Alternative: Vitest

If richer features are needed (watch mode, coverage reporting, mocking), Vitest is lightweight
and works well with ESM:

```json
{
  "devDependencies": {
    "vitest": "^3.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

### Proposed Directory Structure

```
test/
├── sandbox.test.js          # Priority 1
├── executor.test.js         # Priority 1
├── context.test.js          # Priority 2
├── client.test.js           # Priority 2
├── rollback.test.js         # Priority 2
├── conversation.test.js     # Priority 2
├── agent-definitions.test.js # Priority 2
├── memory.test.js           # Priority 3
├── ast-search.test.js       # Priority 3
├── helpers/
│   ├── mock-client.js       # Mock MercuryClient for API tests
│   └── temp-dir.js          # Temporary directory helpers for filesystem tests
└── fixtures/
    ├── sample-agent.md      # Agent definition fixtures
    └── sample-code/         # Source files for ast-search tests
```

---

## Recommended Implementation Order

| Phase | Files | Est. Tests | Rationale |
|-------|-------|-----------|-----------|
| **Phase 1** | `sandbox.test.js`, `executor.test.js` (glob/env helpers) | ~50 | Security-critical path validation and tool safety |
| **Phase 2** | `context.test.js`, `rollback.test.js` | ~55 | Core state management, data integrity |
| **Phase 3** | `client.test.js`, `conversation.test.js` | ~40 | API communication, conversation lifecycle |
| **Phase 4** | `agent-definitions.test.js`, `memory.test.js` | ~45 | Agent system, persistence |
| **Phase 5** | `ast-search.test.js`, remaining modules | ~30 | Feature completeness |

**Total estimated: ~220 unit tests** to achieve solid coverage of the production code.

---

## Key Risks of Zero Test Coverage

1. **Security regressions**: Changes to `sandbox.js` or `executor.js` could silently break
   path blocking, allowing the AI to access credentials or system files.

2. **Context corruption**: Changes to `context.js` compression could drop messages or produce
   malformed conversation arrays, breaking the AI mid-task.

3. **Data loss in rollback**: The rollback system manipulates git state and deep-clones
   conversations. Subtle bugs (shallow copy, invalid ref) could lose user work.

4. **Silent API failures**: The client's SSE parser handles edge cases (split chunks, malformed
   JSON). Without tests, parser regressions could cause mysterious hangs or crashes.

5. **Shell injection**: `isValidGitRef()` and `_shellEscape()` are the last line of defense
   against command injection. These absolutely must have test coverage.
