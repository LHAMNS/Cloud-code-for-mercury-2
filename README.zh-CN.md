# Mercury Code

> **🇬🇧 English Documentation:** If you prefer the English version, please click [**README.md**](./README.md).

基于 [Inception Labs](https://inceptionlabs.ai) 的 **Mercury-2** 扩散模型驱动的交互式 AI 编程助手。

Mercury Code 是一个在终端中运行的 AI 编程代理，它可以代你读取、编写和编辑代码——理念类似于 [Claude Code](https://github.com/anthropics/claude-code)，但底层使用的是 Mercury-2 模型，通过 OpenAI 兼容 API 进行通信。它具备完整的 REPL 交互界面、内置文件和 Shell 工具、子代理编排、沙盒隔离、权限系统等众多功能。

---

## 目录

- [系统要求](#系统要求)
- [获取 API 密钥](#获取-api-密钥)
- [安装](#安装)
  - [方式一：一键安装脚本（推荐）](#方式一一键安装脚本推荐)
  - [方式二：克隆仓库并通过 npm 全局安装](#方式二克隆仓库并通过-npm-全局安装)
  - [方式三：克隆仓库并通过 Make 全局安装](#方式三克隆仓库并通过-make-全局安装)
  - [方式四：直接运行（无需安装）](#方式四直接运行无需安装)
- [验证安装](#验证安装)
- [设置 API 密钥](#设置-api-密钥)
- [更新](#更新)
- [卸载](#卸载)
- [使用方法](#使用方法)
  - [交互式 REPL 模式](#交互式-repl-模式)
  - [单次提问模式](#单次提问模式)
  - [命令行选项](#命令行选项)
  - [REPL 斜杠命令](#repl-斜杠命令)
- [配置](#配置)
  - [模型参数](#模型参数)
  - [全局配置文件](#全局配置文件)
  - [项目配置（MERCURY.md）](#项目配置mercurymd)
  - [配置层级](#配置层级)
  - [环境变量](#环境变量)
- [内置工具](#内置工具)
- [权限系统](#权限系统)
  - [权限模式](#权限模式)
  - [权限规则](#权限规则)
- [沙盒隔离](#沙盒隔离)
- [实验性功能（Labs）](#实验性功能labs)
  - [子代理系统](#子代理系统)
  - [代理团队](#代理团队)
- [钩子系统](#钩子系统)
- [项目结构](#项目结构)
- [开发](#开发)
- [故障排除](#故障排除)
  - [安装问题](#安装问题)
  - [运行时错误](#运行时错误)
  - [API 和网络错误](#api-和网络错误)
  - [权限和沙盒错误](#权限和沙盒错误)
  - [平台特定问题](#平台特定问题)
- [许可证](#许可证)

---

## 系统要求

| 要求 | 说明 |
|---|---|
| **操作系统** | Linux（x64、arm64）或 macOS（x64、arm64）。**不支持** Windows。 |
| **Node.js** | **>= 18.17.0**（推荐使用 LTS 20.x 或 22.x）。 |
| **npm** | 随 Node.js 一起安装。Node 18+ 自带的任何版本均可。 |
| **Git** | 用于克隆仓库以及 git 相关的代理功能（worktree 隔离、Diff 工具等）。 |
| **网络连接** | 需要能访问 Mercury-2 API：`https://api.inceptionlabs.ai`。 |
| **API 密钥** | 来自 Inception Labs 的 `INCEPTION_API_KEY`（详见下文）。 |

### 检查 Node.js 版本

```bash
node --version
# 应输出 v18.17.0 或更高版本，例如 v20.11.0
```

如果 Node.js 未安装或版本过旧，请使用以下方式安装或升级：

| 方式 | 命令 |
|---|---|
| **nvm**（推荐） | `nvm install 20 && nvm use 20` |
| **fnm** | `fnm install 20 && fnm use 20` |
| **官方安装包** | 从 [https://nodejs.org](https://nodejs.org) 下载 |
| **Homebrew（macOS）** | `brew install node@20` |
| **apt（Ubuntu/Debian）** | 参见 [NodeSource distributions](https://github.com/nodesource/distributions) |

---

## 获取 API 密钥

1. 访问 **[https://api.inceptionlabs.ai](https://api.inceptionlabs.ai)**。
2. 注册或登录。
3. 进入 API Keys 页面，创建一个新密钥。
4. 复制密钥——下一步会用到。

> **重要提示：** 请妥善保管你的 API 密钥。不要将其提交到版本控制中，不要公开分享。

---

## 安装

### 方式一：一键安装脚本（推荐）

仓库自带了一个自动化安装脚本，它会检查系统环境、全局安装 Mercury Code，并创建默认配置目录。

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
bash install.sh
```

脚本会执行以下步骤：
1. 检测操作系统（Linux 或 macOS）。
2. 验证 Node.js >= 18.17.0 是否已安装。
3. 验证 npm 是否可用。
4. 检查与已有安装的包名冲突。
5. 运行 `npm install -g .` 全局安装 Mercury Code。
6. 在 `~/.mercury/` 创建配置目录和默认 `config.json`。
7. 验证 `mercury-code`、`mercury`、`Mercury` 和 `MERCURY` 命令是否可用。

如果因权限不足导致全局安装失败，脚本会自动使用 `sudo` 重试。

### 方式二：克隆仓库并通过 npm 全局安装

```bash
# 1. 克隆仓库
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2

# 2. 通过 npm link 全局安装
npm install
npm link

# 3. 验证命令是否可用
mercury-code --version
```

`npm link` 会在 npm 全局 `bin` 目录中创建符号链接，使以下命令在系统范围内可用：

| 命令 | 大小写 |
|---|---|
| `mercury` | 全小写 |
| `Mercury` | 首字母大写 |
| `MERCURY` | 全大写 |
| `mercury-code` | 全名 |
| `Mercury-Code` | 全名首字母大写 |

### 方式三：克隆仓库并通过 Make 全局安装

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
make install
```

`make install` 会检查 Node.js 版本、赋予 `cli.js` 执行权限、运行 `npm install` 和 `npm link`。

### 方式四：直接运行（无需安装）

如果你不想全局安装，可以直接从克隆的目录运行 Mercury Code：

```bash
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
cd Cloud-code-for-mercury-2
node cli.js
```

或者使用 npm start 脚本：

```bash
npm start
```

> **注意：** 直接运行方式下，`mercury` / `mercury-code` 命令不会在系统范围内可用。每次使用都需要在项目目录中运行 `node cli.js`。

---

## 验证安装

安装完成后，运行以下任一命令确认 Mercury Code 正常工作：

```bash
# 检查版本
mercury-code --version
# 预期输出: mercury-code v1.2.0

# 显示帮助
mercury-code --help

# 快速连接测试（需要先设置 API 密钥——见下一节）
mercury-code -p "Hello, Mercury!"
```

如果提示 `mercury-code` 命令未找到，请参阅 [故障排除：安装后命令未找到](#安装后-mercury-code-命令未找到)。

---

## 设置 API 密钥

Mercury Code 需要 `INCEPTION_API_KEY` 环境变量来与 Mercury-2 API 通信。

### 临时设置（仅当前终端会话有效）

```bash
export INCEPTION_API_KEY=your_key_here
mercury-code
```

### 永久设置（推荐）

将 export 命令添加到 shell 配置文件中，使其在所有会话中持续生效：

**Bash** (`~/.bashrc` 或 `~/.bash_profile`)：
```bash
echo 'export INCEPTION_API_KEY=your_key_here' >> ~/.bashrc
source ~/.bashrc
```

**Zsh** (`~/.zshrc`)：
```bash
echo 'export INCEPTION_API_KEY=your_key_here' >> ~/.zshrc
source ~/.zshrc
```

**Fish** (`~/.config/fish/config.fish`)：
```fish
set -Ux INCEPTION_API_KEY your_key_here
```

> **安全提示：** 不要将 API 密钥放在被 git 追踪的文件中。`.gitignore` 已排除 `.env` 文件。如果你偏好使用 `.env` 方式，请在项目目录创建 `.env` 文件并手动 source——Mercury Code 不会自动加载 `.env` 文件。

---

## 更新

更新到最新版本：

```bash
cd Cloud-code-for-mercury-2
git pull origin master
npm install
npm link
```

或使用 Make：

```bash
cd Cloud-code-for-mercury-2
git pull origin master
make install
```

---

## 卸载

### 移除全局命令

```bash
npm unlink -g mercury-code
```

或使用 Make：

```bash
cd Cloud-code-for-mercury-2
make uninstall
```

### 删除克隆的仓库

```bash
rm -rf Cloud-code-for-mercury-2
```

### 删除配置数据

```bash
rm -rf ~/.mercury
```

### 删除项目级数据

在使用过 Mercury Code 的项目中，可以删除本地数据目录：

```bash
rm -rf .mercury/
```

---

## 使用方法

### 交互式 REPL 模式

启动交互式读取-求值-打印循环：

```bash
mercury-code
```

你会看到一个欢迎横幅，显示当前配置信息。输入自然语言请求，Mercury Code 会使用内置工具来读取文件、执行命令、编写代码等。

按 `Ctrl+C` 取消当前响应。按 `Ctrl+D` 或输入 `/exit` 退出。

### 单次提问模式

发送一个提问，获取回复后退出：

```bash
mercury-code -p "解释一下这个代码库是做什么的"
mercury-code -p "查找 src/ 中的所有 TODO 注释"
mercury-code -p "为 src/config.js 编写单元测试"
```

### 命令行选项

| 选项 | 说明 |
|---|---|
| `-h`, `--help` | 显示帮助信息并退出。 |
| `-v`, `--version` | 打印版本号并退出。 |
| `--verbose` | 启用详细/调试输出。显示原始 API 请求、Token 计数和耗时。 |
| `-p`, `--prompt <text>` | 以单次提问模式运行。 |
| `--sandbox <mode>` | 设置沙盒模式：`on`（默认）、`strict` 或 `off`。 |
| `--no-sandbox` | `--sandbox off` 的简写。 |

### REPL 斜杠命令

在交互式 REPL 中，以下命令可用：

| 命令 | 说明 |
|---|---|
| `/help` | 显示所有可用命令。 |
| `/clear` | 清除对话历史，重新开始。 |
| `/reasoning <级别>` | 设置推理深度：`instant`、`low`、`medium` 或 `high`。 |
| `/model` | 显示或更改当前模型。 |
| `/config` | 显示当前配置。 |
| `/context` | 显示上下文窗口使用情况（已用 Token / 总计）。 |
| `/compact` | 手动触发上下文压缩。 |
| `/supercompress` | 切换激进上下文压缩模式。 |
| `/memory` | 显示或编辑项目记忆文件（`.mercury/memory.md`）。 |
| `/init` | 创建一个新的 `MERCURY.md` 项目配置文件模板。 |
| `/cost` | 显示当前会话的预估 API 费用。 |
| `/doctor` | 运行诊断（检查 Node 版本、API 密钥、网络连通性等）。 |
| `/login` | 交互式设置或更新 API 密钥。 |
| `/logout` | 移除已存储的 API 密钥。 |
| `/labs` | 显示、启用或禁用实验性功能。 |
| `/undo` 或 `Escape` | 通过回滚撤销上一次 AI 操作（文件修改等）。 |
| `/history` | 显示会话历史。 |
| `/sessions` | 列出过去的对话会话。 |
| `/trust` | 切换工作区信任设置。 |
| `/exit` | 退出 Mercury Code。 |

---

## 配置

### 模型参数

| 参数 | 默认值 | 范围 / 可选值 | 说明 |
|---|---|---|---|
| `model` | `mercury-2` | — | 使用的模型。 |
| `max_tokens` | `50000` | 1 – 50000 | 每次响应的最大输出 Token 数。 |
| `temperature` | `0.75` | 0.5 – 1.0 | 采样随机性。值越低越确定。 |
| `reasoning_effort` | `medium` | `instant`、`low`、`medium`、`high` | 控制模型内部推理的深度。 |
| `reasoning_summary` | `true` | `true` / `false` | 在输出中包含推理摘要。 |
| `stream` | `true` | `true` / `false` | 逐 Token 流式响应（推荐）。 |
| `diffusing` | `false` | `true` / `false` | 启用扩散生成模式。 |

### 全局配置文件

安装脚本会在以下位置创建默认配置文件：

```
~/.mercury/config.json
```

示例内容：

```json
{
  "model": "mercury-2",
  "max_tokens": 50000,
  "temperature": 0.75,
  "reasoning_effort": "medium",
  "stream": true
}
```

### 项目配置（MERCURY.md）

Mercury Code 支持通过 `MERCURY.md` 文件提供项目特定的指令（类似于 Claude Code 中的 `CLAUDE.md`）。当 Mercury Code 在一个目录中启动时，它会查找此文件并将内容注入系统提示词。

支持的文件位置（按顺序检查）：
1. `<项目>/MERCURY.md`
2. `<项目>/.mercury.md`
3. `<项目>/.mercury/MERCURY.md`

可以在 REPL 中使用 `/init` 命令创建，或手动创建：

```markdown
# Mercury Code 项目指令

## 项目概述
这是一个使用 Express 和 PostgreSQL 的 Node.js REST API。

## 代码规范
- 使用 ES 模块（import/export）
- 遵循 Standard.js 风格
- 在 test/ 目录中使用 node:test 编写测试

## 测试
运行测试: npm test
```

### 配置层级

配置按优先级加载（低层级覆盖高层级）：

| 优先级 | 位置 | 作用范围 | 说明 |
|---|---|---|---|
| 1（最低） | `MERCURY_MANAGED_CONFIG` 环境变量 | 组织 | 由企业管理员管理。只读。 |
| 2 | `~/.mercury/MERCURY.md` | 用户 | 个人偏好，应用于所有项目。 |
| 3 | `<项目>/MERCURY.md` | 项目 | 项目特定指令，通过 git 共享。 |
| 4（最高） | `<项目>/.mercury/local/MERCURY.md` | 本地开发者 | 个人覆盖，已被 gitignore。 |

其他配置源：

| 位置 | 说明 |
|---|---|
| `<项目>/.mercury/rules/*.md` | 路径范围的规则（类似 `.claude/rules/`）。每个 `.md` 文件都会被加载。 |
| `<项目>/.mercury/memory.md` | 自动保存的记忆。前 200 行会加载到上下文中。 |
| `<项目>/.mercury/conversation.jsonl` | 完整对话日志（每条消息、工具调用、结果）。 |

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `INCEPTION_API_KEY` | **是** | — | 来自 Inception Labs 的 API 密钥。 |
| `MERCURY_API_BASE` | 否 | `https://api.inceptionlabs.ai/v1` | 覆盖 API 基础 URL（用于代理服务器或本地服务）。 |
| `MERCURY_MANAGED_CONFIG` | 否 | — | 组织管理的配置文件路径。 |
| `MERCURY_AUTOCOMPACT_PCT` | 否 | `90` | 触发自动压缩的上下文使用百分比（1-100）。 |

---

## 内置工具

Mercury Code 拥有 16 个内置工具，用于自主完成你的请求：

### 核心工具（始终可用）

| 工具 | 说明 |
|---|---|
| **Read** | 读取文件内容并显示行号。支持 offset/limit 读取大文件。 |
| **Write** | 创建或覆盖文件。自动创建父目录。 |
| **Edit** | 替换文件中的精确字符串匹配。适用于小修改。 |
| **Patch** | 在单次操作中对文件应用多个编辑。 |
| **Bash** | 执行 Shell 命令。默认 2 分钟超时。工作目录在会话中保持。 |
| **Glob** | 通过 glob 模式查找文件（如 `**/*.ts`）。 |
| **Grep** | 使用正则表达式搜索文件内容。 |
| **ListDir** | 树形目录列表，支持深度控制。 |
| **Diff** | 显示文件差异或 git 更改。 |
| **Fetch** | 发送 HTTP 请求（GET、POST、PUT、DELETE）。30 秒超时。 |
| **Lsp** | 语言服务器协议操作：跳转到定义、查找引用、悬停信息、符号、诊断。 |
| **AstSearch** | 结构化代码搜索：在代码库中按名称查找函数、类、方法。 |

### 实验性工具（需要 `/labs on`）

| 工具 | Labs 特性 | 说明 |
|---|---|---|
| **SubAgent** | `subagent` | 生成自主子代理（explore、plan、general-purpose）。 |
| **SubAgentTeam** | `subagent-team` | 最多 5 个子代理并行运行。 |
| **AgentTeams** | `agent-teams` | 协作式多代理团队，含任务列表和消息传递。 |
| **ContextSearch** | `context-search` | 搜索已压缩的对话历史以找回丢失的上下文。 |

---

## 权限系统

### 权限模式

Mercury Code 支持 5 种权限模式，控制 AI 代理拥有多大的自主权：

| 模式 | 行为 |
|---|---|
| `open` | 工作区内所有工具自动允许。无需确认。 |
| `acceptEdits` | 文件读取和编辑自动允许。Bash 和 Fetch 需要审批。 |
| `approval` **（默认）** | 读取/搜索自动允许。所有写入操作需要用户审批。 |
| `dontAsk` | 自动拒绝所有未通过权限规则明确允许的操作。 |
| `readonly` | 只读模式。无文件写入、无 Bash、无子代理。 |

### 权限规则

可在 `.mercury/permissions.json` 或 `~/.mercury/permissions.json` 中定义细粒度规则：

```json
{
  "allow": ["Read", "Glob", "Grep", "Bash(git *)"],
  "ask":   ["Write", "Edit", "Bash"],
  "deny":  ["Bash(rm -rf *)", "Bash(curl *)"]
}
```

**规则格式：** `工具名` 或 `工具名(限定符)`，支持 glob 模式匹配。

**评估顺序：**
1. **Deny 规则** — 最高优先级，始终阻止。
2. **Allow 规则** — 匹配则自动允许。
3. **Ask 规则** — 提示用户确认。
4. **权限模式默认行为** — 兜底行为。

**设置优先级**（从高到低）：
1. 托管设置（`.mercury/managed-settings.json`）— 企业级，不可覆盖。
2. CLI 参数 — 临时的，仅当前会话。
3. 本地项目设置（`.mercury/settings.local.json`）— 个人的，已被 gitignore。
4. 共享项目设置（`.mercury/settings.json`）— 团队级，受版本控制。
5. 用户设置（`~/.mercury/permissions.json`）— 个人默认值。

---

## 沙盒隔离

Mercury Code 包含一个可配置的沙盒系统，用于隔离工具执行：

| 模式 | 说明 |
|---|---|
| `off` | 无沙盒。标准的工作区边界保护仍然有效。 |
| `on` **（默认）** | 资源限制（内存、文件大小、进程数）。敏感凭据路径被阻止。系统目录禁止写入。 |
| `strict` | 最高隔离：命名空间隔离的 Bash（通过 bubblewrap/firejail）、只读根文件系统、可选网络阻断、Fetch 域名白名单。 |

通过 CLI 启用：

```bash
mercury-code --sandbox strict
mercury-code --sandbox off
mercury-code --no-sandbox
```

**沙盒后端**（在 Linux 上自动检测）：
1. **bubblewrap (bwrap)** — 最佳隔离，Linux 命名空间沙盒。
2. **firejail** — 基于 seccomp 的沙盒。
3. **ulimit 兜底** — 仅资源限制（始终可用）。

在 macOS 上，仅 ulimit 兜底方案可用。

**被阻止的敏感路径**（读写均阻止）：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.npmrc`、`~/.docker/config.json`、`~/.kube/config`、`.env` 文件、Shell 历史文件等。

---

## 实验性功能（Labs）

高级功能通过 Labs 系统进行管控。先启用 Labs 模式，再切换各个功能：

```bash
# 在 REPL 中:
/labs             # 显示所有功能及其状态
/labs on          # 启用 Labs 总开关
/labs off         # 禁用所有 Labs 功能
/labs subagent    # 切换某个特定功能
```

| 功能 | 类别 | 默认 | 说明 |
|---|---|---|---|
| `subagent` | 代理 | 开启 | 生成具有独立上下文的自主子代理。 |
| `subagent-team` | 代理 | 开启 | 最多 5 个子代理并行运行。 |
| `agent-resume` | 代理 | 关闭 | 通过 ID 恢复之前的子代理。 |
| `agent-background` | 代理 | 关闭 | 在后台异步运行子代理。 |
| `agent-worktree` | 代理 | 关闭 | 在 git worktree 中隔离子代理。 |
| `agent-teams` | 代理 | 关闭 | 带消息传递的协作式多代理团队。 |
| `context-search` | 上下文 | 关闭 | 搜索已压缩的对话历史。 |
| `project-config` | 上下文 | 开启 | 从 MERCURY.md 加载项目指令。 |
| `sandbox` | 安全 | 关闭 | 工具执行的沙盒隔离。 |

Labs 状态持久化在 `~/.mercury/labs.json` 中。

### 子代理系统

启用 Labs 子代理后，Mercury Code 可以生成独立的子代理进行并行任务执行：

- **explore** — 快速、只读的代码库搜索和分析代理。
- **plan** — 架构和设计研究代理。
- **general-purpose** — 具有完整读写工具的通用代理。
- **custom** — 在 `.mercury/agents/*.md` 中使用 markdown frontmatter 定义自定义代理。

### 代理团队

代理团队功能支持协作式多代理工作流：

- 创建由领导代理（你）和多个队友（子代理）组成的团队。
- 定义带依赖关系的任务——任务按依赖顺序执行。
- 通过邮箱消息和广播进行代理间通信。
- 共享任务跟踪和状态监控。

---

## 钩子系统

用户可配置的钩子在关键生命周期节点运行。在 `.mercury/hooks.json` 或 `~/.mercury/hooks.json` 中配置。

**可用事件：**

| 事件 | 触发时机 |
|---|---|
| `PreToolUse` | 工具执行前。可修改输入、允许或拒绝。 |
| `PostToolUse` | 工具执行后。 |
| `SubagentStart` | 子代理生成时。 |
| `SubagentStop` | 子代理完成时。 |
| `TeammateIdle` | 代理团队队友空闲时。 |
| `TaskCompleted` | 代理团队任务完成时。 |
| `WorktreeCreate` | 为子代理创建 git worktree 时。 |
| `WorktreeRemove` | 清理 git worktree 时。 |
| `PreCompact` | 上下文压缩前。 |
| `SessionStart` | 会话开始时。 |
| `SessionEnd` | 会话结束时。 |

**处理器类型：** `command`（Shell 脚本）、`prompt`（注入文本）、`function`（内部）。

---

## 项目结构

```
Cloud-code-for-mercury-2/
├── cli.js                 # CLI 入口点（参数解析、进程设置）
├── install.sh             # 自动化安装脚本（Linux/macOS）
├── Makefile               # 开发命令（install, test, lint, clean）
├── package.json           # npm 包定义
├── src/
│   ├── index.js           # 主导出
│   ├── repl.js            # 交互式 REPL（输入、工具循环、显示）
│   ├── client.js          # Mercury-2 API 客户端（流式和非流式）
│   ├── config.js          # 默认配置和 API 密钥管理
│   ├── project-config.js  # MERCURY.md 层级加载器
│   ├── system-prompt.js   # 系统提示词构建器
│   ├── conversation.js    # 对话消息管理
│   ├── memory.js          # 记忆管理器和对话日志器
│   ├── history.js         # 会话历史持久化
│   ├── context.js         # 上下文窗口管理和压缩
│   ├── rollback.js        # 文件更改撤销/回滚系统
│   ├── permissions.js     # 权限规则引擎（5 种模式）
│   ├── sandbox.js         # 沙盒隔离（bwrap/firejail/ulimit）
│   ├── hooks.js           # 生命周期钩子系统
│   ├── labs.js            # 实验性功能开关
│   ├── subagent.js        # 子代理生成和管理
│   ├── agent-definitions.js  # 代理类型定义和发现
│   ├── agent-teams.js     # 多代理团队协作
│   ├── lsp.js             # 语言服务器协议集成
│   ├── ast-search.js      # 基于 AST 的结构化代码搜索
│   ├── tools/
│   │   ├── definitions.js # 工具模式定义（OpenAI function calling 格式）
│   │   └── executor.js    # 工具执行引擎
│   └── ui/
│       ├── display.js     # 终端 UI（颜色、转圈动画、格式化）
│       └── agent-tabs.js  # 代理进度显示
├── test/                  # 测试套件（375 个测试，98 个套件）
│   ├── *.test.js          # 使用 node:test 的测试文件
│   └── ...
├── test-output/           # 生成的测试产物
├── CHANGELOG.md           # 版本历史
├── LICENSE.md             # MIT 许可证
├── README.md              # 英文文档
└── README.zh-CN.md        # 中文文档（本文件）
```

---

## 开发

```bash
# 以开发模式运行（详细日志）
make dev
# 或
npm run dev
# 或
node cli.js --verbose

# 运行测试套件（375 个测试）
make test
# 或
npm test

# 检查语法错误
make lint

# 清理生成的文件
make clean
```

### 运行测试

测试套件使用 Node.js 内置测试运行器（`node:test`）：

```bash
node --test test/*.test.js
```

测试覆盖：权限（全部 5 种模式）、沙盒路径/URL 检查、安全（路径遍历、SSRF、命令注入、凭据阻止）、代理定义、代理团队、工具定义、钩子、Labs 功能以及端到端代理流程。

---

## 故障排除

### 安装问题

#### 安装后 `mercury-code` 命令未找到

**原因：** npm 全局 `bin` 目录不在你的 `PATH` 中。

**解决方法：**

```bash
# 查找 npm 全局二进制文件的安装位置
npm bin -g

# 将该目录添加到 PATH（以 bash 为例）
echo 'export PATH="$(npm bin -g):$PATH"' >> ~/.bashrc
source ~/.bashrc
```

或者，如果你使用 **nvm**，确保激活了正确的 Node 版本：

```bash
nvm use 20
```

如果是用 **sudo** 安装的，二进制文件可能在 `/usr/local/bin`（用 `which mercury-code` 检查）。

#### `npm link` 报 EACCES / 权限被拒绝

**原因：** 你的 npm 全局目录需要 root 权限。

**解决方法 A（推荐）：** 使用 nvm，它将 Node.js 安装在用户主目录下，永远不需要 sudo：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
npm link   # 无需 sudo
```

**解决方法 B：** 更改 npm 的默认全局目录：

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm link
```

**解决方法 C：** 使用 sudo（不推荐日常使用）：

```bash
sudo npm link
```

#### Node.js 版本过旧（< 18.17.0）

**原因：** Mercury Code 需要 Node.js >= 18.17.0 以支持 ES 模块和现代 API。

**解决方法：**

```bash
# 检查当前版本
node --version

# 通过 nvm 升级
nvm install 20
nvm alias default 20

# 通过 fnm 升级
fnm install 20
fnm default 20

# 或从 https://nodejs.org 下载
```

#### `npm install` 失败 / 没有依赖需要安装

**正常现象：** Mercury Code 拥有**零 npm 依赖**（`package.json` 中 `"dependencies": {}`）。它只使用 Node.js 内置模块（`node:fs`、`node:path`、`node:http`、`node:https`、`node:readline`、`node:child_process`、`node:test` 等）。`npm install` 步骤应该瞬间完成且不会安装任何包。如果它失败了，问题很可能出在你的 npm 或 Node.js 安装本身。

#### `bash install.sh` 报"不支持的操作系统"

**原因：** 安装脚本仅支持 Linux 和 macOS。如果在受支持的系统上看到此错误，请检查是否通过不兼容的 Shell 运行。

**解决方法：** 确保使用 bash：

```bash
bash install.sh
# 不要用: sh install.sh（sh 在某些系统上可能是 dash）
```

#### git clone 失败

**解决方法：** 检查 git 安装和网络：

```bash
git --version
git clone https://github.com/LHAMNS/Cloud-code-for-mercury-2.git
```

如果在公司代理后面：

```bash
git config --global http.proxy http://proxy.example.com:8080
git config --global https.proxy http://proxy.example.com:8080
```

---

### 运行时错误

#### `INCEPTION_API_KEY environment variable is required`

**原因：** 你没有设置 API 密钥。

**解决方法：**

```bash
export INCEPTION_API_KEY=your_key_here
mercury-code
```

详见 [设置 API 密钥](#设置-api-密钥) 进行永久设置。

#### `SyntaxError: Cannot use import statement outside a module`

**原因：** Node.js 未将项目识别为 ES 模块。通常发生在使用非常旧的 Node.js 版本或 `package.json` 被修改时。

**解决方法：**

1. 确认 Node.js >= 18.17.0：`node --version`
2. 确认 `package.json` 中存在 `"type": "module"`。
3. 从项目目录运行：`node cli.js`（不要从其他目录运行）。

#### `Error: mercury-code is not recognized`（Windows）

**原因：** Mercury Code 不支持 Windows。`package.json` 中明确声明了 `"os": ["linux", "darwin"]`。

**解决方法：** 使用 WSL 2（Windows 子系统 Linux）：

```powershell
# 在 PowerShell 中（如未安装 WSL，先安装）
wsl --install

# 在 WSL (Ubuntu) 中
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

#### `Fatal error: ...` 或 `Unhandled promise rejection: ...`

**原因：** Mercury Code 或 API 响应中出现了意外错误。

**解决方法：** 使用 `--verbose` 运行以获取完整堆栈追踪：

```bash
mercury-code --verbose
```

然后检查错误消息和堆栈追踪寻找线索。常见原因：
- 网络连接问题（参见下方 API 错误）。
- 格式错误的 API 响应（可能是代理或防火墙拦截了请求）。

---

### API 和网络错误

#### `Mercury API error (401): ...`

**原因：** API 密钥无效或已过期。

**解决方法：**

1. 确认密钥正确：`echo $INCEPTION_API_KEY`
2. 在 [https://api.inceptionlabs.ai](https://api.inceptionlabs.ai) 重新生成密钥。
3. 更新环境变量。

#### `Mercury API error (429): ...`

**原因：** 超出速率限制。

**解决方法：** 等待几秒后重试。如果问题持续，请在 [https://api.inceptionlabs.ai](https://api.inceptionlabs.ai) 检查你的 API 计划限额。

#### `Mercury API error (500/502/503): ...`

**原因：** Inception Labs 服务端错误。

**解决方法：** 稍等片刻后重试。如果问题持续，请查看 [Inception Labs 状态](https://inceptionlabs.ai) 或稍后再试。

#### `Request timed out (120s)`

**原因：** API 在 2 分钟内未响应。这可能发生在提示词很长或服务器过载时。

**解决方法：**
- 尝试较短的提示词。
- 将 `reasoning_effort` 设为 `low` 或 `instant` 以获得更快响应：`/reasoning low`
- 检查网络连接。
- 如果在代理后面，确保代理没有更短的超时设置。

#### `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN`

**原因：** 无法连接到 API 服务器。网络问题。

**解决方法：**

```bash
# 测试连通性
curl -s https://api.inceptionlabs.ai/v1/models -H "Authorization: Bearer $INCEPTION_API_KEY"

# 如果在代理后面，设置环境变量
export HTTPS_PROXY=http://proxy.example.com:8080
```

#### 使用自定义 API 基础 URL

如果需要使用代理、本地服务器或替代端点：

```bash
export MERCURY_API_BASE=http://localhost:8080/v1
mercury-code
```

---

### 权限和沙盒错误

#### `Sandbox: access to ~/.ssh is blocked (sensitive credentials path)`

**正常现象：** 沙盒阻止访问敏感目录以防止意外的凭据泄露。这是安全特性。

**解决方法：** 如果你确实需要访问这些路径（例如用于 git SSH 操作），请禁用沙盒：

```bash
mercury-code --no-sandbox
```

或使用 `--sandbox off`。

#### `Sandbox strict: reads outside workspace are blocked`

**原因：** 在严格沙盒模式下，文件读取仅限于工作区目录。

**解决方法：** 如果需要读取工作区外的文件，使用 `--sandbox on`（默认）而非 `--sandbox strict`。

#### 工具被权限规则拒绝

**原因：** `.mercury/permissions.json` 或 `~/.mercury/permissions.json` 中的 deny 规则阻止了该工具。

**解决方法：** 检查并编辑你的权限规则：

```bash
cat .mercury/permissions.json
cat ~/.mercury/permissions.json
```

移除或修改阻止所需工具的 deny 规则。

#### 权限审计日志

启用审计日志以调试权限决策：

在 `.mercury/settings.json` 中配置：

```json
{
  "permissions": {
    "allow": ["Read", "Glob"],
    "deny": ["Bash(rm -rf *)"]
  },
  "auditLog": true
}
```

权限决策会记录到 `.mercury/audit/permissions.log`。

---

### 平台特定问题

#### macOS：`bwrap` / `firejail` 不可用

**正常现象：** bubblewrap 和 firejail 仅限 Linux。在 macOS 上，沙盒会回退到基于 ulimit 的资源限制。这是正常的，沙盒仍然提供基本保护。

#### Linux：bubblewrap 报"Permission denied"

**原因：** 你的系统可能禁用了用户命名空间。

**解决方法：**

```bash
# 检查用户命名空间是否启用
sysctl kernel.unprivileged_userns_clone
# 如果为 0，启用它：
sudo sysctl -w kernel.unprivileged_userns_clone=1

# 或从包管理器安装 bubblewrap
sudo apt install bubblewrap        # Debian/Ubuntu
sudo dnf install bubblewrap        # Fedora
sudo pacman -S bubblewrap          # Arch
```

如果无法启用用户命名空间，沙盒会自动回退到 firejail 或基于 ulimit 的限制。

#### Linux ARM64：Node.js 安装

在 ARM64 Linux 上（例如树莓派、AWS Graviton）：

```bash
# 通过 nvm（自动检测架构）
nvm install 20

# 或从 nodejs.org 下载 ARM64 二进制包
```

---

## API

Mercury-2 使用 OpenAI 兼容端点：

| 属性 | 值 |
|---|---|
| **基础 URL** | `https://api.inceptionlabs.ai/v1` |
| **端点** | `/chat/completions` |
| **认证** | `Authorization: Bearer <INCEPTION_API_KEY>` |
| **上下文窗口** | 128K Token |
| **最大输出** | 50K Token |
| **温度范围** | 0.5 – 1.0 |
| **流式传输** | SSE (`stream: true`) |

---

## 许可证

[MIT](LICENSE.md)
