# Mercury Code

> **🇨🇳 中文文档 / Chinese Documentation:** 如果你需要查看完整的中文版本文档，请点击 [**README.zh-CN.md**](./README.zh-CN.md)。

Interactive AI coding assistant powered by the **Mercury-2** diffusion model from [Inception Labs](https://inceptionlabs.ai).

Mercury Code is a terminal-based AI agent that reads, writes, and edits code on your behalf — similar in spirit to [Claude Code](https://github.com/anthropics/claude-code), but running on the Mercury-2 model via an OpenAI-compatible API. It features a full REPL interface, built-in file and shell tools, sub-agent orchestration, sandbox isolation, a permission system, and much more.

---

## Table of Contents

- [Requirements](#requirements)
- [Getting an API Key](#getting-an-api-key)
- [Installation](#installation)
  - [Method 1: One-Line Install Script (Recommended)](#method-1-one-line-install-script-recommended)
  - [Method 2: Clone and Install Globally via npm](#method-2-clone-and-install-globally-via-npm)
  - [Method 3: Clone and Install Globally via Make](#method-3-clone-and-install-globally-via-make)
  - [Method 4: Run Directly Without Installing](#method-4-run-directly-without-installing)
- [Verifying the Installation](#verifying-the-installation)
- [Setting the API Key](#setting-the-api-key)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Usage](#usage)
  - [Interactive REPL Mode](#interactive-repl-mode)
  - [Single-Shot Mode](#single-shot-mode)
  - [CLI Options](#cli-options)
  - [REPL Slash Commands](#repl-slash-commands)
- [Configuration](#configuration)
  - [Model Parameters](#model-parameters)
  - [Global Config File](#global-config-file)
  - [Project Config (MERCURY.md)](#project-config-mercurymd)
  - [Configuration Hierarchy](#configuration-hierarchy)
  - [Environment Variables](#environment-variables)
- [Built-in Tools](#built-in-tools)
- [Permission System](#permission-system)
  - [Permission Modes](#permission-modes)
  - [Permission Rules](#permission-rules)
- [Sandbox Isolation](#sandbox-isolation)
- [Labs (Experimental Features)](#labs-experimental-features)
  - [Sub-Agent System](#sub-agent-system)
  - [Agent Teams](#agent-teams)
- [Hooks System](#hooks-system)
- [Project Structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
  - [Installation Issues](#installation-issues)
  - [Runtime Errors](#runtime-errors)
  - [API and Network Errors](#api-and-network-errors)
  - [Permission and Sandbox Errors](#permission-and-sandbox-errors)
  - [Platform-Specific Issues](#platform-specific-issues)
- [License](#license)

---

## Requirements

| Requirement | Details |
|---|---|
| **Operating System** | Linux (x64, arm64) or macOS (x64, arm64). Windows is **not** supported. |
| **Node.js** | **>= 18.17.0** (LTS 20.x or 22.x recommended). |
| **npm** | Ships with Node.js. Any version bundled with Node 18+ works. |
| **Git** | Required for cloning the repository and for git-related agent features (worktree isolation, Diff tool, etc.). |
| **Internet access** | Required to reach the Mercury-2 API at `https://api.inceptionlabs.ai`. |
| **API key** | An `INCEPTION_API_KEY` from Inception Labs (see below). |

### Checking Your Node.js Version

```bash
node --version
# Should print v18.17.0 or higher, e.g. v20.11.0
```

If Node.js is not installed or the version is too old, install or upgrade it using one of these methods:

| Method | Command |
|---|---|
| **nvm** (recommended) | `nvm install 20 && nvm use 20` |
| **fnm** | `fnm install 20 && fnm use 20` |
| **Official installer** | Download from [https://nodejs.org](https://nodejs.org) |
| **Homebrew (macOS)** | `brew install node@20` |
| **apt (Ubuntu/Debian)** | See [NodeSource distributions](https://github.com/nodesource/distributions) |

---

## Getting an API Key

1. Go to **[https://api.inceptionlabs.ai](https://api.inceptionlabs.ai)**.
2. Sign up or log in.
3. Navigate to the API Keys section and create a new key.
4. Copy the key — you will need it in the next step.

> **Important:** Keep your API key secret. Do not commit it to version control. Do not share it publicly.

---

## Installation

### Method 1: One-Line Install Script (Recommended)

The repository includes an automated install script that checks prerequisites, installs Mercury Code globally, and creates the default config directory.

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
bash install.sh
```

The script will:
1. Detect your operating system (Linux or macOS).
2. Verify Node.js >= 18.17.0 is installed.
3. Verify npm is available.
4. Check for package name conflicts with existing installations.
5. Run `npm install -g .` to install Mercury Code globally.
6. Create the config directory at `~/.mercury/` with a default `config.json`.
7. Verify that `mercury-code`, `mercury`, `Mercury`, and `MERCURY` commands are available.

If the global install fails due to permissions, the script will automatically retry with `sudo`.

### Method 2: Clone and Install Globally via npm

```bash
# 1. Clone the repository
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2

# 2. Install globally using npm link
npm install
npm link

# 3. Verify the commands are available
mercury-code --version
```

`npm link` creates symlinks in your global npm `bin` directory, making the following commands available system-wide:

| Command | Case |
|---|---|
| `mercury` | lowercase |
| `Mercury` | capitalized |
| `MERCURY` | uppercase |
| `mercury-code` | full name |
| `Mercury-Code` | full name capitalized |

### Method 3: Clone and Install Globally via Make

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
make install
```

The `make install` target checks Node.js version, makes `cli.js` executable, runs `npm install`, and runs `npm link`.

### Method 4: Run Directly Without Installing

If you do not want to install globally, you can run Mercury Code directly from the cloned directory:

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
node cli.js
```

Or use the npm start script:

```bash
npm start
```

> **Note:** When running directly, you will not have the `mercury` / `mercury-code` commands available system-wide. You will need to run `node cli.js` from the project directory each time.

---

## Verifying the Installation

After installation, run any of these commands to confirm Mercury Code is working:

```bash
# Check version
mercury-code --version
# Expected output: mercury-code v1.2.0

# Show help
mercury-code --help

# Quick connectivity test (requires API key set — see next section)
mercury-code -p "Hello, Mercury!"
```

If `mercury-code` is not found, see [Troubleshooting: command not found](#mercury-code-command-not-found-after-installation).

---

## Setting the API Key

Mercury Code requires the `INCEPTION_API_KEY` environment variable to communicate with the Mercury-2 API.

### Temporary (current shell session only)

```bash
export INCEPTION_API_KEY=your_key_here
mercury-code
```

### Permanent (recommended)

Add the export to your shell profile so it persists across sessions:

**Bash** (`~/.bashrc` or `~/.bash_profile`):
```bash
echo 'export INCEPTION_API_KEY=your_key_here' >> ~/.bashrc
source ~/.bashrc
```

**Zsh** (`~/.zshrc`):
```bash
echo 'export INCEPTION_API_KEY=your_key_here' >> ~/.zshrc
source ~/.zshrc
```

**Fish** (`~/.config/fish/config.fish`):
```fish
set -Ux INCEPTION_API_KEY your_key_here
```

> **Security tip:** Do not put your API key in files tracked by git. The `.gitignore` already excludes `.env` files. If you prefer a `.env` approach, create a `.env` file in the project directory and source it manually — Mercury Code does not auto-load `.env` files.

---

## Updating

To update to the latest version:

```bash
cd Cloud-code-for-mercury-2
git pull origin master
npm install
npm link
```

Or with Make:

```bash
cd Cloud-code-for-mercury-2
git pull origin master
make install
```

---

## Uninstalling

### Remove global commands

```bash
npm unlink -g mercury-code
```

Or with Make:

```bash
cd Cloud-code-for-mercury-2
make uninstall
```

### Remove the cloned repository

```bash
rm -rf Cloud-code-for-mercury-2
```

### Remove configuration data

```bash
rm -rf ~/.mercury
```

### Remove per-project data

In any project where Mercury Code was used, you can remove the local data directory:

```bash
rm -rf .mercury/
```

---

## Usage

### Interactive REPL Mode

Start the interactive Read-Eval-Print Loop:

```bash
mercury-code
```

You will see a welcome banner with your current configuration. Type natural language requests and Mercury Code will use its built-in tools to read files, execute commands, write code, and more.

Press `Ctrl+C` to cancel the current response. Press `Ctrl+D` or type `/exit` to quit.

### Single-Shot Mode

Send a single prompt, get the response, and exit:

```bash
mercury-code -p "Explain what this codebase does"
mercury-code -p "Find all TODO comments in src/"
mercury-code -p "Write a unit test for src/config.js"
```

### CLI Options

| Option | Description |
|---|---|
| `-h`, `--help` | Show help message and exit. |
| `-v`, `--version` | Print version number and exit. |
| `--verbose` | Enable verbose/debug output. Shows raw API requests, token counts, and timing. |
| `-p`, `--prompt <text>` | Run in single-shot mode with the given prompt. |
| `--sandbox <mode>` | Set sandbox mode: `on` (default), `strict`, or `off`. |
| `--no-sandbox` | Shorthand for `--sandbox off`. |

### REPL Slash Commands

Inside the interactive REPL, the following commands are available:

| Command | Description |
|---|---|
| `/help` | Show all available commands. |
| `/clear` | Clear the conversation history and start fresh. |
| `/reasoning <level>` | Set reasoning effort: `instant`, `low`, `medium`, or `high`. |
| `/model` | Show or change the current model. |
| `/config` | Display the current configuration. |
| `/context` | Show context window usage (tokens used / total). |
| `/compact` | Manually trigger context compression. |
| `/supercompress` | Toggle aggressive context compression mode. |
| `/memory` | Show or edit the project memory file (`.mercury/memory.md`). |
| `/init` | Scaffold a new `MERCURY.md` project config file. |
| `/cost` | Show estimated API cost for the current session. |
| `/doctor` | Run diagnostics (check Node version, API key, connectivity, etc.). |
| `/login` | Set or update the API key interactively. |
| `/logout` | Remove the stored API key. |
| `/labs` | Show, enable, or disable experimental features. |
| `/undo` or `Escape` | Undo the last AI action (file changes, etc.) via rollback. |
| `/history` | Show session history. |
| `/sessions` | List past conversation sessions. |
| `/trust` | Toggle workspace trust settings. |
| `/exit` | Exit Mercury Code. |

---

## Configuration

### Model Parameters

| Parameter | Default | Range / Values | Description |
|---|---|---|---|
| `model` | `mercury-2` | — | The model to use. |
| `max_tokens` | `50000` | 1 – 50000 | Maximum output tokens per response. |
| `temperature` | `0.75` | 0.5 – 1.0 | Sampling randomness. Lower = more deterministic. |
| `reasoning_effort` | `medium` | `instant`, `low`, `medium`, `high` | Controls how much internal reasoning the model performs. |
| `reasoning_summary` | `true` | `true` / `false` | Include reasoning summary in output. |
| `stream` | `true` | `true` / `false` | Stream responses token-by-token (recommended). |
| `diffusing` | `false` | `true` / `false` | Enable the diffusion generation mode. |

### Global Config File

The install script creates a default config file at:

```
~/.mercury/config.json
```

Example contents:

```json
{
  "model": "mercury-2",
  "max_tokens": 50000,
  "temperature": 0.75,
  "reasoning_effort": "medium",
  "stream": true
}
```

### Project Config (MERCURY.md)

Mercury Code supports project-specific instructions via a `MERCURY.md` file (analogous to `CLAUDE.md` in Claude Code). When Mercury Code starts in a directory, it looks for this file and injects its contents into the system prompt.

Supported file locations (checked in order):
1. `<project>/MERCURY.md`
2. `<project>/.mercury.md`
3. `<project>/.mercury/MERCURY.md`

Create one with the `/init` command inside the REPL, or manually:

```markdown
# Mercury Code Project Instructions

## Project Overview
This is a Node.js REST API using Express and PostgreSQL.

## Code Conventions
- Use ES modules (import/export)
- Follow Standard.js style
- Write tests in test/ using node:test

## Testing
Run tests: npm test
```

### Configuration Hierarchy

Configuration is loaded in priority order (lower levels override higher):

| Priority | Location | Scope | Description |
|---|---|---|---|
| 1 (lowest) | `MERCURY_MANAGED_CONFIG` env var | Organization | Managed by enterprise admins. Read-only. |
| 2 | `~/.mercury/MERCURY.md` | User | Personal preferences, applied to all projects. |
| 3 | `<project>/MERCURY.md` | Project | Project-specific instructions, shared via git. |
| 4 (highest) | `<project>/.mercury/local/MERCURY.md` | Local developer | Personal overrides, gitignored. |

Additional configuration sources:

| Location | Description |
|---|---|
| `<project>/.mercury/rules/*.md` | Path-scoped rules (like `.claude/rules/`). Each `.md` file is loaded. |
| `<project>/.mercury/memory.md` | Auto-saved memory. First 200 lines loaded into context. |
| `<project>/.mercury/conversation.jsonl` | Full conversation log (every message, tool call, result). |

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `INCEPTION_API_KEY` | **Yes** | — | Your API key from Inception Labs. |
| `MERCURY_API_BASE` | No | `https://api.inceptionlabs.ai/v1` | Override the API base URL (for proxies or local servers). |
| `MERCURY_MANAGED_CONFIG` | No | — | Path to organization-managed config file. |
| `MERCURY_AUTOCOMPACT_PCT` | No | `90` | Context usage percentage (1-100) at which auto-compaction triggers. |

---

## Built-in Tools

Mercury Code has 16 built-in tools that it uses autonomously to complete your requests:

### Core Tools (Always Available)

| Tool | Description |
|---|---|
| **Read** | Read file contents with line numbers. Supports offset/limit for large files. |
| **Write** | Create or overwrite files. Auto-creates parent directories. |
| **Edit** | Replace an exact string match in a file. Preferred for small modifications. |
| **Patch** | Apply multiple edits to a file in a single operation. |
| **Bash** | Execute shell commands. 2-minute default timeout. Working directory persists. |
| **Glob** | Find files matching a glob pattern (e.g., `**/*.ts`). |
| **Grep** | Search file contents using regular expressions. |
| **ListDir** | Tree-view directory listing with depth control. |
| **Diff** | Show diffs between files or git changes. |
| **Fetch** | Make HTTP requests (GET, POST, PUT, DELETE). 30-second timeout. |
| **Lsp** | Language Server Protocol operations: go-to-definition, find references, hover, symbols, diagnostics. |
| **AstSearch** | Structural code search: find functions, classes, methods by name across the codebase. |

### Labs Tools (Require `/labs on`)

| Tool | Labs Feature | Description |
|---|---|---|
| **SubAgent** | `subagent` | Spawn autonomous sub-agents (explore, plan, general-purpose). |
| **SubAgentTeam** | `subagent-team` | Run up to 5 sub-agents in parallel. |
| **AgentTeams** | `agent-teams` | Collaborative multi-agent teams with task lists and messaging. |
| **ContextSearch** | `context-search` | Search compressed conversation history for lost context. |

---

## Permission System

### Permission Modes

Mercury Code supports 5 permission modes that control how much autonomy the AI agent has:

| Mode | Behavior |
|---|---|
| `open` | All tools auto-allowed within the workspace. No prompts. |
| `acceptEdits` | File reads and edits auto-allowed. Bash and Fetch require approval. |
| `approval` **(default)** | Read/search auto-allowed. All write operations require user approval. |
| `dontAsk` | Auto-denies everything not explicitly allowed via permission rules. |
| `readonly` | Read-only mode. No file writes, no Bash, no sub-agents. |

### Permission Rules

Fine-grained rules can be defined in `.mercury/permissions.json` or `~/.mercury/permissions.json`:

```json
{
  "allow": ["Read", "Glob", "Grep", "Bash(git *)"],
  "ask":   ["Write", "Edit", "Bash"],
  "deny":  ["Bash(rm -rf *)", "Bash(curl *)"]
}
```

**Rule format:** `ToolName` or `ToolName(specifier)` with glob-pattern matching.

**Evaluation order:**
1. **Deny rules** — highest priority, always block.
2. **Allow rules** — auto-approve if matched.
3. **Ask rules** — prompt the user.
4. **Permission mode default** — fallback behavior.

**Settings precedence** (highest to lowest):
1. Managed settings (`.mercury/managed-settings.json`) — enterprise, cannot be overridden.
2. CLI arguments — temporary, single session.
3. Local project settings (`.mercury/settings.local.json`) — personal, gitignored.
4. Shared project settings (`.mercury/settings.json`) — team-wide, version controlled.
5. User settings (`~/.mercury/permissions.json`) — personal defaults.

---

## Sandbox Isolation

Mercury Code includes a configurable sandbox system for isolating tool execution:

| Mode | Description |
|---|---|
| `off` | No sandboxing. Standard workspace boundary enforcement still applies. |
| `on` **(default)** | Resource limits (memory, file size, processes). Sensitive credential paths blocked. System directories blocked for writes. |
| `strict` | Maximum isolation: namespace-isolated Bash (via bubblewrap/firejail), read-only root filesystem, optional network blocking, domain allowlist for Fetch. |

Enable via CLI:

```bash
mercury-code --sandbox strict
mercury-code --sandbox off
mercury-code --no-sandbox
```

**Sandbox backends** (detected automatically on Linux):
1. **bubblewrap (bwrap)** — best isolation, Linux namespace sandbox.
2. **firejail** — seccomp-based sandboxing.
3. **ulimit fallback** — resource limits only (always available).

On macOS, only the ulimit fallback is available.

**Blocked sensitive paths** (both read and write): `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube/config`, `.env` files, shell history files, and more.

---

## Labs (Experimental Features)

Advanced features are gated behind a labs system. Enable labs mode first, then toggle individual features:

```bash
# Inside the REPL:
/labs             # Show all features and their status
/labs on          # Enable labs master switch
/labs off         # Disable all labs features
/labs subagent    # Toggle a specific feature
```

| Feature | Category | Default | Description |
|---|---|---|---|
| `subagent` | Agents | ON | Spawn autonomous sub-agents with isolated context. |
| `subagent-team` | Agents | ON | Run up to 5 sub-agents in parallel. |
| `agent-resume` | Agents | OFF | Resume previous sub-agents by ID. |
| `agent-background` | Agents | OFF | Run sub-agents asynchronously in the background. |
| `agent-worktree` | Agents | OFF | Isolate sub-agents in git worktrees. |
| `agent-teams` | Agents | OFF | Collaborative multi-agent teams with messaging. |
| `context-search` | Context | OFF | Search compressed conversation history. |
| `project-config` | Context | ON | Load project instructions from MERCURY.md. |
| `sandbox` | Security | OFF | Sandbox isolation for tool execution. |

Labs state is persisted in `~/.mercury/labs.json`.

### Sub-Agent System

When labs sub-agents are enabled, Mercury Code can spawn isolated sub-agents for parallel task execution:

- **explore** — Fast, read-only agent for codebase search and analysis.
- **plan** — Architecture and design research agent.
- **general-purpose** — Full-capability agent with read/write tools.
- **custom** — Define your own agents in `.mercury/agents/*.md` using markdown frontmatter.

### Agent Teams

The Agent Teams feature enables collaborative multi-agent workflows:

- Create teams with a lead agent (you) and multiple teammates (sub-agents).
- Define tasks with dependencies — tasks run in dependency order.
- Inter-agent communication via mailbox messaging and broadcasts.
- Shared task tracking and status monitoring.

---

## Hooks System

User-configurable hooks run at key lifecycle points. Configure in `.mercury/hooks.json` or `~/.mercury/hooks.json`.

**Available events:**

| Event | When |
|---|---|
| `PreToolUse` | Before a tool executes. Can modify input, allow, or deny. |
| `PostToolUse` | After a tool executes. |
| `SubagentStart` | When a sub-agent is spawned. |
| `SubagentStop` | When a sub-agent finishes. |
| `TeammateIdle` | When an agent team teammate has no work. |
| `TaskCompleted` | When an agent team task completes. |
| `WorktreeCreate` | When a git worktree is created for a sub-agent. |
| `WorktreeRemove` | When a git worktree is cleaned up. |
| `PreCompact` | Before context compaction. |
| `SessionStart` | When a session begins. |
| `SessionEnd` | When a session ends. |

**Handler types:** `command` (shell script), `prompt` (inject text), `function` (internal).

---

## Project Structure

```
Cloud-code-for-mercury-2/
├── cli.js                 # CLI entry point (argument parsing, process setup)
├── install.sh             # Automated install script (Linux/macOS)
├── Makefile               # Development commands (install, test, lint, clean)
├── package.json           # npm package definition
├── src/
│   ├── index.js           # Main export
│   ├── repl.js            # Interactive REPL (input, tool loop, display)
│   ├── client.js          # Mercury-2 API client (streaming & non-streaming)
│   ├── config.js          # Default configuration and API key management
│   ├── project-config.js  # MERCURY.md hierarchy loader
│   ├── system-prompt.js   # System prompt builder
│   ├── conversation.js    # Conversation message management
│   ├── memory.js          # Memory manager and conversation logger
│   ├── history.js         # Session history persistence
│   ├── context.js         # Context window management and compression
│   ├── rollback.js        # File change undo/rollback system
│   ├── permissions.js     # Permission rules engine (5 modes)
│   ├── sandbox.js         # Sandbox isolation (bwrap/firejail/ulimit)
│   ├── hooks.js           # Lifecycle hooks system
│   ├── labs.js            # Experimental feature flags
│   ├── subagent.js        # Sub-agent spawning and management
│   ├── agent-definitions.js  # Agent type definitions and discovery
│   ├── agent-teams.js     # Multi-agent team collaboration
│   ├── lsp.js             # Language Server Protocol integration
│   ├── ast-search.js      # AST-based structural code search
│   ├── tools/
│   │   ├── definitions.js # Tool schemas (OpenAI function calling format)
│   │   └── executor.js    # Tool execution engine
│   └── ui/
│       ├── display.js     # Terminal UI (colors, spinners, formatting)
│       └── agent-tabs.js  # Agent progress display
├── test/                  # Test suite (375 tests, 98 suites)
│   ├── *.test.js          # Test files using node:test
│   └── ...
├── test-output/           # Generated test artifacts
├── CHANGELOG.md           # Version history
├── LICENSE.md             # MIT License
└── README.md              # This file
```

---

## Development

```bash
# Run in development mode (verbose logging)
make dev
# or
npm run dev
# or
node cli.js --verbose

# Run the test suite (375 tests)
make test
# or
npm test

# Check for syntax errors
make lint

# Clean generated files
make clean
```

### Running Tests

The test suite uses Node.js built-in test runner (`node:test`):

```bash
node --test test/*.test.js
```

Tests cover: permissions (all 5 modes), sandbox path/URL checking, security (path traversal, SSRF, command injection, credential blocking), agent definitions, agent teams, tool definitions, hooks, labs features, and end-to-end agent flows.

---

## Troubleshooting

### Installation Issues

#### `mercury-code`: command not found after installation

**Cause:** The npm global `bin` directory is not in your `PATH`.

**Fix:**

```bash
# Find where npm installs global binaries
npm bin -g

# Add that directory to your PATH (example for bash)
echo 'export PATH="$(npm bin -g):$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Alternatively, if you use **nvm**, ensure the correct Node version is active:

```bash
nvm use 20
```

If you installed with **sudo**, the binary may be in `/usr/local/bin` (check with `which mercury-code`).

#### `npm link` fails with EACCES / permission denied

**Cause:** Your npm global directory requires root permissions.

**Fix (Option A — recommended):** Use nvm, which installs Node.js in your home directory and never requires sudo:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
npm link   # No sudo needed
```

**Fix (Option B):** Change npm's default global directory:

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm link
```

**Fix (Option C):** Use sudo (not recommended for daily use):

```bash
sudo npm link
```

#### Node.js version too old (< 18.17.0)

**Cause:** Mercury Code requires Node.js >= 18.17.0 for ES module support and modern APIs.

**Fix:**

```bash
# Check your current version
node --version

# Upgrade via nvm
nvm install 20
nvm alias default 20

# Upgrade via fnm
fnm install 20
fnm default 20

# Or download from https://nodejs.org
```

#### `npm install` fails / no dependencies to install

**Expected behavior:** Mercury Code has **zero npm dependencies** (`"dependencies": {}` in `package.json`). It uses only Node.js built-in modules (`node:fs`, `node:path`, `node:http`, `node:https`, `node:readline`, `node:child_process`, `node:test`, etc.). The `npm install` step should complete instantly with no packages installed. If it fails, the issue is likely with your npm or Node.js installation itself.

#### `bash install.sh` fails with "unsupported OS"

**Cause:** The install script only supports Linux and macOS. If you see this on a supported OS, check if you are running through an incompatible shell.

**Fix:** Ensure you are using bash:

```bash
bash install.sh
# NOT: sh install.sh (sh may be dash on some systems)
```

#### git clone fails

**Fix:** Check your git installation and network:

```bash
git --version
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
```

If you are behind a corporate proxy:

```bash
git config --global http.proxy http://proxy.example.com:8080
git config --global https.proxy http://proxy.example.com:8080
```

---

### Runtime Errors

#### `INCEPTION_API_KEY environment variable is required`

**Cause:** You have not set the API key.

**Fix:**

```bash
export INCEPTION_API_KEY=your_key_here
mercury-code
```

See [Setting the API Key](#setting-the-api-key) for permanent setup.

#### `SyntaxError: Cannot use import statement outside a module`

**Cause:** Node.js is not recognizing the project as an ES module. This usually happens when running with a very old Node.js version or when the `package.json` has been modified.

**Fix:**

1. Verify Node.js >= 18.17.0: `node --version`
2. Verify `"type": "module"` exists in `package.json`.
3. Run from the project directory: `node cli.js` (not from a different directory).

#### `Error: mercury-code is not recognized` (Windows)

**Cause:** Mercury Code does not support Windows. The `package.json` explicitly declares `"os": ["linux", "darwin"]`.

**Workaround:** Use WSL 2 (Windows Subsystem for Linux):

```powershell
# In PowerShell (install WSL if not already installed)
wsl --install

# Inside WSL (Ubuntu)
sudo apt update
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
npm link
export INCEPTION_API_KEY=your_key_here
mercury-code
```

#### `Fatal error: ...` or `Unhandled promise rejection: ...`

**Cause:** An unexpected error in Mercury Code or the API response.

**Fix:** Run with `--verbose` to get the full stack trace:

```bash
mercury-code --verbose
```

Then check the error message and stack trace for clues. Common causes:
- Network connectivity issues (see API errors below).
- Malformed API responses (possibly due to a proxy or firewall intercepting requests).

---

### API and Network Errors

#### `Mercury API error (401): ...`

**Cause:** Invalid or expired API key.

**Fix:**

1. Verify your key is correct: `echo $INCEPTION_API_KEY`
2. Regenerate the key at [https://api.inceptionlabs.ai](https://api.inceptionlabs.ai).
3. Update the environment variable.

#### `Mercury API error (429): ...`

**Cause:** Rate limit exceeded.

**Fix:** Wait a few seconds and try again. If the issue persists, check your API plan limits at [https://api.inceptionlabs.ai](https://api.inceptionlabs.ai).

#### `Mercury API error (500/502/503): ...`

**Cause:** Server-side error at Inception Labs.

**Fix:** Wait a moment and retry. If the issue persists, check [Inception Labs status](https://inceptionlabs.ai) or try again later.

#### `Request timed out (120s)`

**Cause:** The API did not respond within 2 minutes. This can happen with very long prompts or when the server is overloaded.

**Fix:**
- Try a shorter prompt.
- Set `reasoning_effort` to `low` or `instant` for faster responses: `/reasoning low`
- Check your network connection.
- If behind a proxy, ensure it does not have a shorter timeout.

#### `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN`

**Cause:** Cannot reach the API server. Network issue.

**Fix:**

```bash
# Test connectivity
curl -s https://api.inceptionlabs.ai/v1/models -H "Authorization: Bearer $INCEPTION_API_KEY"

# If behind a proxy, set environment variables
export HTTPS_PROXY=http://proxy.example.com:8080
```

#### Using a custom API base URL

If you need to use a proxy, local server, or alternative endpoint:

```bash
export MERCURY_API_BASE=http://localhost:8080/v1
mercury-code
```

---

### Permission and Sandbox Errors

#### `Sandbox: access to ~/.ssh is blocked (sensitive credentials path)`

**Expected behavior:** The sandbox blocks access to sensitive directories to prevent accidental credential exposure. This is a security feature.

**Fix:** If you genuinely need to access these paths (e.g., for git SSH operations), disable the sandbox:

```bash
mercury-code --no-sandbox
```

Or use `--sandbox off`.

#### `Sandbox strict: reads outside workspace are blocked`

**Cause:** In strict sandbox mode, file reads are limited to the workspace directory.

**Fix:** Use `--sandbox on` (default) instead of `--sandbox strict` if you need to read files outside the workspace.

#### Tool denied by permission rules

**Cause:** A deny rule in `.mercury/permissions.json` or `~/.mercury/permissions.json` is blocking the tool.

**Fix:** Check and edit your permission rules:

```bash
cat .mercury/permissions.json
cat ~/.mercury/permissions.json
```

Remove or modify the deny rule that is blocking the desired tool.

#### Permission audit log

Enable audit logging to debug permission decisions:

Configure in `.mercury/settings.json`:

```json
{
  "permissions": {
    "allow": ["Read", "Glob"],
    "deny": ["Bash(rm -rf *)"]
  },
  "auditLog": true
}
```

Permission decisions are logged to `.mercury/audit/permissions.log`.

---

### Platform-Specific Issues

#### macOS: `bwrap` / `firejail` not available

**Expected behavior:** bubblewrap and firejail are Linux-only. On macOS, the sandbox falls back to ulimit-based resource limits. This is normal and the sandbox still provides basic protections.

#### Linux: bubblewrap fails with "Permission denied"

**Cause:** User namespaces may be disabled on your system.

**Fix:**

```bash
# Check if user namespaces are enabled
sysctl kernel.unprivileged_userns_clone
# If 0, enable them:
sudo sysctl -w kernel.unprivileged_userns_clone=1

# Or install bubblewrap from your package manager
sudo apt install bubblewrap        # Debian/Ubuntu
sudo dnf install bubblewrap        # Fedora
sudo pacman -S bubblewrap          # Arch
```

If you cannot enable user namespaces, the sandbox will automatically fall back to firejail or ulimit-based restrictions.

#### Linux ARM64: Node.js installation

On ARM64 Linux (e.g., Raspberry Pi, AWS Graviton):

```bash
# Via nvm (auto-detects architecture)
nvm install 20

# Or download the ARM64 binary from nodejs.org
```

---

## API

Mercury-2 uses an OpenAI-compatible endpoint:

| Property | Value |
|---|---|
| **Base URL** | `https://api.inceptionlabs.ai/v1` |
| **Endpoint** | `/chat/completions` |
| **Auth** | `Authorization: Bearer <INCEPTION_API_KEY>` |
| **Context window** | 128K tokens |
| **Max output** | 50K tokens |
| **Temperature range** | 0.5 – 1.0 |
| **Streaming** | SSE (`stream: true`) |

---

## License

[MIT](LICENSE.md)
