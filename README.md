# Mercury Code

Interactive AI coding assistant powered by the **Mercury-2** diffusion model from [Inception Labs](https://inceptionlabs.ai). Like Claude Code, but for Mercury-2.

## Installation

### npm (recommended, all platforms)

```bash
npm install -g mercury-code
```

After installation, the `mercury` and `mercury-code` commands are available globally.

### Windows Installer (EXE)

Download the latest `mercury-code-vX.X.X-windows-setup.exe` from [Releases](https://github.com/LHAMNS/Cloud-code-for-mercury-2/releases). The installer:

- Installs to Program Files
- Adds `mercury` and `mercury-code` to your PATH
- Creates Start Menu shortcuts
- Includes an uninstaller

### Standalone Binaries (no Node.js required)

Download the appropriate binary from [Releases](https://github.com/LHAMNS/Cloud-code-for-mercury-2/releases):

| Platform | Architecture | File |
|----------|-------------|------|
| Windows | x64 | `mercury-code-vX.X.X-win-x64.zip` |
| Windows | ARM64 | `mercury-code-vX.X.X-win-arm64.zip` |
| macOS | Intel | `mercury-code-vX.X.X-macos-x64.tar.gz` |
| macOS | Apple Silicon | `mercury-code-vX.X.X-macos-arm64.tar.gz` |
| Linux | x64 | `mercury-code-vX.X.X-linux-x64.tar.gz` |
| Linux | ARM64 | `mercury-code-vX.X.X-linux-arm64.tar.gz` |

Extract and move to your PATH:

```bash
# Linux / macOS
tar xzf mercury-code-v*.tar.gz
chmod +x mercury-code-*
sudo mv mercury-code-* /usr/local/bin/mercury-code
```

### Install from Source

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
npm link
# or: ./install.sh (Linux/macOS)
# or: powershell -ExecutionPolicy Bypass -File install.ps1 (Windows)
```

## Quick Start

```bash
# 1. Set your API key (from https://api.inceptionlabs.ai)
export INCEPTION_API_KEY=your_key_here

# 2. Start interactive session
mercury

# Or use single-shot mode
mercury -p "Explain this codebase"
```

## Usage

```bash
mercury                              # Interactive REPL
mercury -p "your question"           # Single-shot mode
mercury --plan                       # Plan mode (read-only analysis)
mercury --verbose                    # Verbose logging
mercury --trust-mode aiSafetyDecide  # AI evaluates safety of each operation
mercury --help                       # Full options
```

## Trust Modes

| Mode | Level | Description |
|------|-------|-------------|
| `open` | 0 | Auto-allow everything in workspace |
| `aiSafetyDecide` | 0.5 | AI judges each operation's safety |
| `acceptEdits` | 1 | Auto-approve file edits, ask for bash |
| `approval` | 2 | Ask before writes and commands (default) |
| `dontAsk` | 3 | Allow reads, deny everything else |
| `readonly` | 4 | Read-only, no writes/bash/agents |

## Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/clear` | Clear conversation history |
| `/reasoning <level>` | Set reasoning effort (instant/low/medium/high) |
| `/trust <mode>` | Switch trust mode |
| `/context` | View context usage |
| `/export <format>` | Export conversation (md/json/txt/html) |
| `/agents` | List available agent types |
| `/settings` | View/modify settings |
| `/exit` | Exit Mercury Code |

## Built-in Tools

| Tool | Description |
|------|-------------|
| Read | Read files |
| Write | Create/overwrite files |
| Edit | Precise text replacements |
| Bash | Execute shell commands (sandboxed) |
| Glob | Find files by pattern |
| Grep | Search file contents with regex |
| Fetch | HTTP requests |
| Diff | Compare files |
| ListDir | List directory contents |
| SubAgent | Spawn sub-agents for parallel work |
| SubAgentTeam | Run multiple agents concurrently |
| AgentTeams | Collaborative agent teams |

## Security

- **Sandbox isolation**: Workspace boundary enforcement, path traversal protection
- **Content scanning**: Detects secrets (API keys, private keys, tokens) in file writes
- **SSRF protection**: Blocks private IPs, DNS fail-closed, credential detection
- **Rate limiting**: Per-minute limits for bash and fetch operations
- **AI Safety Judge**: Optional trust mode where AI evaluates each operation

## Configuration

Global config: `~/.mercury/config.json`

```json
{
  "model": "mercury-2",
  "max_tokens": 50000,
  "temperature": 0.75,
  "reasoning_effort": "medium",
  "stream": true
}
```

## API

Mercury-2 uses an OpenAI-compatible endpoint at `https://api.inceptionlabs.ai/v1/chat/completions`.

Set `INCEPTION_API_KEY` in your environment. Context window: 128K tokens. Max output: 50K tokens.

## Building from Source

```bash
# Run tests
make test

# Build standalone binaries for all platforms
make build

# Build for specific platform
make build-win    # Windows x64 + ARM64
make build-mac    # macOS Intel + Apple Silicon
make build-linux  # Linux x64 + ARM64

# Full release (test + build)
make release
```

## License

MIT
