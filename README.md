# Mercury Code

Interactive AI coding assistant powered by the **Mercury-2** diffusion model from [Inception Labs](https://inceptionlabs.ai).

## Setup

```bash
# Requires Node.js >= 18
export INCEPTION_API_KEY=your_key_here

# Run directly
node cli.js

# Or install globally
npm link
mercury-code
```

## Usage

```bash
# Interactive REPL
mercury-code

# Single-shot mode
mercury-code -p "Explain this codebase"

# Verbose logging
mercury-code --verbose
```

### Commands

| Command   | Description            |
|-----------|------------------------|
| `/help`   | Show available commands |
| `/clear`  | Clear conversation      |
| `/config` | Show current config     |
| `/exit`   | Exit                    |

## Configuration

| Parameter          | Default    | Description                          |
|--------------------|------------|--------------------------------------|
| `model`            | mercury-2  | Model name                           |
| `max_tokens`       | 100000     | Max output tokens                    |
| `temperature`      | 0.75       | Randomness (0.5-1.0)                |
| `reasoning_effort` | medium     | Reasoning depth (instant/low/medium/high) |
| `stream`           | true       | Stream responses                     |

## Built-in Tools

The assistant can use these tools to interact with your filesystem:

- **Read** - Read files
- **Write** - Create/overwrite files
- **Edit** - Make precise text replacements
- **Bash** - Execute shell commands
- **Glob** - Find files by pattern
- **Grep** - Search file contents with regex

## API

Mercury-2 uses an OpenAI-compatible endpoint at `https://api.inceptionlabs.ai/v1/chat/completions`.

Set `INCEPTION_API_KEY` in your environment. Context window: 128K tokens. Max output: 100K tokens.
