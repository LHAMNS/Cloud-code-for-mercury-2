// Mercury Code - Internationalization (i18n) Module
// Zero-dependency locale detection and string translation.
// Supports: English (en), Chinese (zh)
//
// Usage:
//   import { t, setLocale, getLocale } from './i18n.js';
//   t('welcome.powered_by')  → "Powered by Mercury-2 Diffusion Model"
//   setLocale('zh');
//   t('welcome.powered_by')  → "由 Mercury-2 扩散模型驱动"

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Supported locales ────────────────────────────────────────────────────────

const SUPPORTED_LOCALES = ["en", "zh"];
const DEFAULT_LOCALE = "en";

// Current locale (module-level state)
let _currentLocale = DEFAULT_LOCALE;

// ── String tables ────────────────────────────────────────────────────────────

const strings = {
  en: {
    // ── Welcome / Banner ───────────────────────────────────────────────
    "welcome.powered_by": "Powered by Mercury-2 Diffusion Model",
    "welcome.help_hint": "Type /help for commands, /exit to quit",
    "welcome.shortcuts": "Shortcuts:",
    "welcome.shortcut_rollback": "rollback",
    "welcome.shortcut_agents": "agents",
    "welcome.shortcut_interrupt": "interrupt",

    // ── Help / Commands ────────────────────────────────────────────────
    "help.title": "Commands",
    "help.cat_general": "General",
    "help.cat_security": "Security & Workspace",
    "help.cat_model": "Model Settings",
    "help.cat_features": "Features",
    "help.cat_session": "Session",

    "help.cmd_help": "Show this help",
    "help.cmd_clear": "Clear conversation",
    "help.cmd_edit": "Open $EDITOR for multiline input",
    "help.cmd_exit": "Exit Mercury Code",
    "help.cmd_trust": "readonly | approval | open | outside",
    "help.cmd_workspace": "View/change workspace directory",
    "help.cmd_reasoning": "instant | low | medium | high",
    "help.cmd_settings": "View/modify any setting",
    "help.cmd_config": "Show raw config (read-only)",
    "help.cmd_labs": "Labs mode — toggle experimental features",
    "help.cmd_sandbox": "on | off | strict | subagents | network",
    "help.cmd_supercompress": "Toggle aggressive compression",
    "help.cmd_contextsearch": "Toggle context search tool",
    "help.cmd_agents": "list | create <name> — manage agents",
    "help.cmd_history": "save | restore | list",
    "help.cmd_context": "View context usage & stats",
    "help.cmd_diff": "Show git diff (default: HEAD)",
    "help.cmd_compact": "Compact/summarize conversation",
    "help.cmd_new": "Start new conversation (saves current)",
    "help.cmd_copy": "Copy last assistant reply to clipboard",
    "help.cmd_init": "Create .mercury.md project config",

    "help.shortcut_esc": "Enter rollback mode",
    "help.shortcut_backslash": "Open $EDITOR for multiline input",
    "help.shortcut_at": "Include file contents in prompt",
    "help.shortcut_ctrlc": "Abort running tool execution",
    "help.shortcut_ctrlj": "Insert newline (multiline input)",
    "help.shortcut_bang": "Execute shell command inline",
    "help.shortcut_tab": "Auto-complete slash commands",

    // ── Setup ──────────────────────────────────────────────────────────
    "setup.title": "Setup",
    "setup.step_workspace": "Workspace",
    "setup.step_trust": "Trust Mode",
    "setup.step_sandbox": "Sandbox Isolation",
    "setup.current_dir": "Current directory:",
    "setup.press_enter": "Press Enter to accept, or type a new path:",
    "setup.trust_readonly": "Read-only",
    "setup.trust_readonly_desc": "Model can only read files",
    "setup.trust_approval": "Approval",
    "setup.trust_approval_desc": "Asks before writes/commands (recommended)",
    "setup.trust_open": "Full open",
    "setup.trust_open_desc": "All ops within workspace",
    "setup.trust_change_tip": "Tip: Change later with /trust",
    "setup.select": "Select",
    "setup.detected_backend": "Detected backend:",
    "setup.sandbox_on": "On",
    "setup.sandbox_on_desc": "Workspace-scoped filesystem, resource limits (default)",
    "setup.sandbox_strict": "Strict",
    "setup.sandbox_strict_desc": "Read-only root, no network for Bash, domain allowlist",
    "setup.sandbox_off": "Off",
    "setup.sandbox_off_desc": "No isolation (use caution)",
    "setup.sandbox_tip": "Tip: Change later with /sandbox",

    // ── Rollback ───────────────────────────────────────────────────────
    "rollback.title": "Rollback Mode",
    "rollback.hint": "Use ↑↓ to select checkpoint, Enter to confirm, ESC",
    "rollback.no_checkpoints": "(No checkpoints available)",
    "rollback.confirm_title": "Confirm Rollback",
    "rollback.target": "Target:",
    "rollback.full": "Full Rollback",
    "rollback.full_desc": "Restore all file changes + conversation to this checkpoint",
    "rollback.context_only": "Context Only",
    "rollback.context_only_desc": "Keep files unchanged, only rollback conversation state",
    "rollback.cancel": "Cancel",
    "rollback.cancel_desc": "Go back, do nothing",

    // ── Session ────────────────────────────────────────────────────────
    "session.title": "Session History",
    "session.no_sessions": "No saved sessions. Use /history save to save current session.",
    "session.restore_hint": "Use /history restore <number> to restore a session",
    "session.msgs": "msgs",

    // ── Spinner / Status ───────────────────────────────────────────────
    "status.thinking": "Thinking...",
    "status.initializing": "Initializing...",
    "status.executing_tool": "Executing tool...",
    "status.processing_result": "Processing result...",
    "status.compressing_context": "Compressing context...",
    "status.done": "Done",
    "status.error": "Error",
    "status.result": "Result:",
    "status.chars_total": "chars total",
    "status.turns": "turns",

    // ── Agent panels ───────────────────────────────────────────────────
    "agent.panel_title": "Agent",
    "agent.results_title": "Sub-Agent Results",
    "agent.navigate_hint": "Press ↓ to navigate agents",
    "agent.nav_keys": "←/→ switch  Enter open/close  ↑/Esc exit",
    "agent.agents": "Agents",
    "agent.turns_label": "Turns:",
    "agent.tools_label": "Tools:",

    // ── Tool display ───────────────────────────────────────────────────
    "tool.uncommitted_changes": "uncommitted changes",
    "tool.edits": "edits",
    "tool.agents": "agent(s)",
    "tool.tokens": "tokens",

    // ── REPL messages ──────────────────────────────────────────────────
    "repl.loaded_project_config": "Loaded project config:",
    "repl.interrupted": "Interrupted by user (Ctrl+C).",
    "repl.exit_hint": "Press Ctrl+C again or type /exit to quit.",
    "repl.included_file": "Included",
    "repl.chars": "chars",
    "repl.could_not_read": "Could not read",
    "repl.conversation_cleared": "Conversation cleared.",
    "repl.current_config": "Current config:",
    "repl.reasoning": "Reasoning:",
    "repl.invalid_options": "Invalid. Options:",
    "repl.super_compress": "Super compress:",
    "repl.context_search": "Context search:",
    "repl.trust": "Trust:",
    "repl.outside_workspace": "Outside workspace:",
    "repl.allowed": "allowed",
    "repl.blocked": "blocked",
    "repl.trust_usage": "Usage: /trust readonly|approval|open|outside",
    "repl.unknown_mode": "Unknown mode:",
    "repl.workspace": "Workspace:",
    "repl.opening_editor": "Opening",
    "repl.for_multiline": "for multiline input...",
    "repl.editor_cancelled": "Editor cancelled (empty input).",
    "repl.received_chars": "Received",
    "repl.chars_from_editor": "chars from editor.",
    "repl.unknown_command": "Unknown command:",
    "repl.type_help": "Type /help for commands.",
    "repl.output_truncated": "Output truncated — auto-recovering",
    "repl.max_tool_turns": "Max tool turns",
    "repl.reached": "reached.",
    "repl.remaining_skipped": "Remaining tool calls skipped.",
    "repl.bad_json": "Bad JSON arguments for tool",
    "repl.context_above_90": "Context usage above 90%. Consider /clear or /supercompress to free space.",
    "repl.context_above_75": "Context usage above 75%. Compression may trigger soon.",
    "repl.no_checkpoints": "No checkpoints available.",
    "repl.rollback_failed": "Rollback failed.",
    "repl.context_restore_failed": "Context restore failed.",
    "repl.rollback_error": "Rollback error:",
    "repl.exited_rollback": "Exited rollback mode.",
    "repl.api_error": "API error:",
    "repl.error": "Error:",
    "repl.unexpected_error": "Unexpected error:",

    // ── Settings ───────────────────────────────────────────────────────
    "settings.title": "Settings",
    "settings.usage": "Usage: /settings <key> <value>",
    "settings.usage_key": "Usage: /settings",
    "settings.must_be_0_2": "Must be 0-2.",
    "settings.must_be_1_50000": "Must be 1-50000.",
    "settings.unknown_setting": "Unknown setting:",
    "settings.updated": "updated.",
    "settings.not_set": "(not set)",

    // ── Sandbox ────────────────────────────────────────────────────────
    "sandbox.title": "Sandbox",
    "sandbox.sandboxed": "sandboxed",
    "sandbox.unsandboxed": "unsandboxed",
    "sandbox.all_domains": "(all)",
    "sandbox.usage": "Usage: /sandbox on|off|strict|subagents|network",
    "sandbox.on_msg": "Sandbox: ON (workspace-scoped, resource limits)",
    "sandbox.strict_msg": "Sandbox: STRICT (read-only root, network restricted)",
    "sandbox.off_msg": "Sandbox: OFF — no isolation active",
    "sandbox.subagent_sandbox": "Sub-agent sandbox:",
    "sandbox.network": "Sandbox network:",
    "sandbox.unknown_option": "Unknown sandbox option:",
    "sandbox.options": "Options: on, off, strict, subagents, network",

    // ── Agents ─────────────────────────────────────────────────────────
    "agents.create_usage": "Usage: /agents create <name>",
    "agents.created": "Created agent:",
    "agents.edit_hint": "Edit the file to customize the agent's system prompt and tools.",
    "agents.create_error": "Error creating agent:",
    "agents.unknown_option": "Unknown /agents option:",
    "agents.options": "Options: list, create <name>",

    // ── Labs ───────────────────────────────────────────────────────────
    "labs.title": "Labs (Experimental Features)",
    "labs.master_switch": "Master switch:",
    "labs.on": "Labs mode: ON — experimental features available",
    "labs.off": "Labs mode: OFF — all experimental features disabled",
    "labs.master_off_note": "Note: Labs master switch is OFF. Enable with /labs on",
    "labs.available_ids": "Available IDs:",
    "labs.toggle_hint": "Toggle: /labs <feature-id> [on|off]",
    "labs.ids_label": "IDs:",
    "labs.active": "active",
    "labs.off_status": "off",

    // ── Init ───────────────────────────────────────────────────────────
    "init.already_exists": "Project config already exists:",
    "init.created": "Created project config:",
    "init.edit_hint": "Edit this file to add project-specific instructions for Mercury Code.",
    "init.error": "Error creating config:",

    // ── Diff ───────────────────────────────────────────────────────────
    "diff.no_changes": "No changes detected.",
    "diff.error": "Git diff error:",

    // ── Compact ────────────────────────────────────────────────────────
    "compact.compacting": "Compacting conversation...",
    "compact.done": "Compacted:",
    "compact.messages": "messages",
    "compact.error": "Compact error:",

    // ── New / Copy ─────────────────────────────────────────────────────
    "new.session_saved": "Current session saved.",
    "new.started": "Started new conversation. Previous session saved.",
    "copy.no_message": "No assistant message to copy.",
    "copy.copied": "Copied",
    "copy.chars_to_clipboard": "chars to clipboard.",
    "copy.not_available": "Clipboard not available. Last assistant response:",

    // ── History ────────────────────────────────────────────────────────
    "history.saved": "Saved:",
    "history.restore_usage": "Usage: /history restore <number>",
    "history.not_found": "Not found:",
    "history.restored": "Restored",
    "history.messages": "messages",
    "history.unknown": "Unknown:",
    "history.options": "Options: list, save, restore",

    // ── Context Info ───────────────────────────────────────────────────
    "context.title": "Context Usage",
    "context.api_reported": "API-reported",
    "context.estimated": "estimated (bytes/4)",
    "context.messages": "Messages",
    "context.checkpoints": "Checkpoints",
    "context.session": "Session",
    "context.compression": "Compression",
    "context.super": "Super (50%)",
    "context.normal": "Normal (80%)",
    "context.estimation": "Estimation",
    "context.estimation_desc": "Codex-style (bytes÷4 + API usage)",

    // ── Exit ───────────────────────────────────────────────────────────
    "exit.auto_saved": "Session auto-saved.",
    "exit.goodbye": "Goodbye!",

    // ── Language ──────────────────────────────────────────────────────
    "lang.current": "Language:",
    "lang.changed": "Language changed to:",
    "lang.invalid": "Invalid language. Supported:",
  },

  zh: {
    // ── 欢迎 / 横幅 ───────────────────────────────────────────────────
    "welcome.powered_by": "由 Mercury-2 扩散模型驱动",
    "welcome.help_hint": "输入 /help 查看命令，/exit 退出",
    "welcome.shortcuts": "快捷键：",
    "welcome.shortcut_rollback": "回滚",
    "welcome.shortcut_agents": "代理",
    "welcome.shortcut_interrupt": "中断",

    // ── 帮助 / 命令 ───────────────────────────────────────────────────
    "help.title": "命令列表",
    "help.cat_general": "通用",
    "help.cat_security": "安全与工作区",
    "help.cat_model": "模型设置",
    "help.cat_features": "功能",
    "help.cat_session": "会话",

    "help.cmd_help": "显示帮助信息",
    "help.cmd_clear": "清除对话",
    "help.cmd_edit": "打开编辑器进行多行输入",
    "help.cmd_exit": "退出 Mercury Code",
    "help.cmd_trust": "readonly | approval | open | outside",
    "help.cmd_workspace": "查看/更改工作区目录",
    "help.cmd_reasoning": "instant | low | medium | high",
    "help.cmd_settings": "查看/修改设置",
    "help.cmd_config": "显示原始配置（只读）",
    "help.cmd_labs": "实验室模式 — 切换实验性功能",
    "help.cmd_sandbox": "on | off | strict | subagents | network",
    "help.cmd_supercompress": "切换激进压缩模式",
    "help.cmd_contextsearch": "切换上下文搜索工具",
    "help.cmd_agents": "list | create <名称> — 管理代理",
    "help.cmd_history": "save | restore | list",
    "help.cmd_context": "查看上下文使用情况和统计",
    "help.cmd_diff": "显示 git diff（默认：HEAD）",
    "help.cmd_compact": "压缩/摘要对话",
    "help.cmd_new": "开始新对话（保存当前会话）",
    "help.cmd_copy": "复制最后一条助手回复到剪贴板",
    "help.cmd_init": "创建 .mercury.md 项目配置",

    "help.shortcut_esc": "进入回滚模式",
    "help.shortcut_backslash": "打开编辑器进行多行输入",
    "help.shortcut_at": "在提示中包含文件内容",
    "help.shortcut_ctrlc": "中止正在运行的工具",
    "help.shortcut_ctrlj": "插入换行（多行输入）",
    "help.shortcut_bang": "内联执行 shell 命令",
    "help.shortcut_tab": "自动补全斜杠命令",

    // ── 设置向导 ──────────────────────────────────────────────────────
    "setup.title": "设置",
    "setup.step_workspace": "工作区",
    "setup.step_trust": "信任模式",
    "setup.step_sandbox": "沙箱隔离",
    "setup.current_dir": "当前目录：",
    "setup.press_enter": "按 Enter 接受，或输入新路径：",
    "setup.trust_readonly": "只读",
    "setup.trust_readonly_desc": "模型只能读取文件",
    "setup.trust_approval": "审批",
    "setup.trust_approval_desc": "写入/命令前请求确认（推荐）",
    "setup.trust_open": "完全开放",
    "setup.trust_open_desc": "工作区内所有操作均允许",
    "setup.trust_change_tip": "提示：之后可用 /trust 更改",
    "setup.select": "选择",
    "setup.detected_backend": "检测到后端：",
    "setup.sandbox_on": "开启",
    "setup.sandbox_on_desc": "工作区范围的文件系统隔离和资源限制（默认）",
    "setup.sandbox_strict": "严格",
    "setup.sandbox_strict_desc": "只读根文件系统，Bash 无网络，域名白名单",
    "setup.sandbox_off": "关闭",
    "setup.sandbox_off_desc": "无隔离（请谨慎使用）",
    "setup.sandbox_tip": "提示：之后可用 /sandbox 更改",

    // ── 回滚 ──────────────────────────────────────────────────────────
    "rollback.title": "回滚模式",
    "rollback.hint": "使用 ↑↓ 选择检查点，Enter 确认，ESC 退出",
    "rollback.no_checkpoints": "（没有可用的检查点）",
    "rollback.confirm_title": "确认回滚",
    "rollback.target": "目标：",
    "rollback.full": "完全回滚",
    "rollback.full_desc": "恢复所有文件更改 + 对话到此检查点",
    "rollback.context_only": "仅恢复上下文",
    "rollback.context_only_desc": "保持文件不变，仅回滚对话状态",
    "rollback.cancel": "取消",
    "rollback.cancel_desc": "返回，不做任何操作",

    // ── 会话 ──────────────────────────────────────────────────────────
    "session.title": "会话历史",
    "session.no_sessions": "没有已保存的会话。使用 /history save 保存当前会话。",
    "session.restore_hint": "使用 /history restore <编号> 恢复会话",
    "session.msgs": "条消息",

    // ── 状态 ──────────────────────────────────────────────────────────
    "status.thinking": "思考中...",
    "status.initializing": "初始化中...",
    "status.executing_tool": "执行工具中...",
    "status.processing_result": "处理结果中...",
    "status.compressing_context": "压缩上下文中...",
    "status.done": "完成",
    "status.error": "错误",
    "status.result": "结果：",
    "status.chars_total": "字符",
    "status.turns": "轮次",

    // ── 代理面板 ──────────────────────────────────────────────────────
    "agent.panel_title": "代理",
    "agent.results_title": "子代理结果",
    "agent.navigate_hint": "按 ↓ 浏览代理",
    "agent.nav_keys": "←/→ 切换  Enter 展开/折叠  ↑/Esc 退出",
    "agent.agents": "代理",
    "agent.turns_label": "轮次：",
    "agent.tools_label": "工具：",

    // ── 工具显示 ──────────────────────────────────────────────────────
    "tool.uncommitted_changes": "未提交的更改",
    "tool.edits": "次编辑",
    "tool.agents": "个代理",
    "tool.tokens": "令牌",

    // ── REPL 消息 ─────────────────────────────────────────────────────
    "repl.loaded_project_config": "已加载项目配置：",
    "repl.interrupted": "被用户中断 (Ctrl+C)。",
    "repl.exit_hint": "再次按 Ctrl+C 或输入 /exit 退出。",
    "repl.included_file": "已包含",
    "repl.chars": "字符",
    "repl.could_not_read": "无法读取",
    "repl.conversation_cleared": "对话已清除。",
    "repl.current_config": "当前配置：",
    "repl.reasoning": "推理级别：",
    "repl.invalid_options": "无效。选项：",
    "repl.super_compress": "超级压缩：",
    "repl.context_search": "上下文搜索：",
    "repl.trust": "信任模式：",
    "repl.outside_workspace": "工作区外操作：",
    "repl.allowed": "允许",
    "repl.blocked": "阻止",
    "repl.trust_usage": "用法：/trust readonly|approval|open|outside",
    "repl.unknown_mode": "未知模式：",
    "repl.workspace": "工作区：",
    "repl.opening_editor": "正在打开",
    "repl.for_multiline": "进行多行输入...",
    "repl.editor_cancelled": "编辑器已取消（空输入）。",
    "repl.received_chars": "已接收",
    "repl.chars_from_editor": "字符来自编辑器。",
    "repl.unknown_command": "未知命令：",
    "repl.type_help": "输入 /help 查看命令。",
    "repl.output_truncated": "输出被截断 — 自动恢复中",
    "repl.max_tool_turns": "工具最大轮次",
    "repl.reached": "已达到。",
    "repl.remaining_skipped": "剩余工具调用已跳过。",
    "repl.bad_json": "工具的 JSON 参数无效",
    "repl.context_above_90": "上下文使用率超过 90%。考虑使用 /clear 或 /supercompress 释放空间。",
    "repl.context_above_75": "上下文使用率超过 75%。压缩可能很快触发。",
    "repl.no_checkpoints": "没有可用的检查点。",
    "repl.rollback_failed": "回滚失败。",
    "repl.context_restore_failed": "上下文恢复失败。",
    "repl.rollback_error": "回滚错误：",
    "repl.exited_rollback": "已退出回滚模式。",
    "repl.api_error": "API 错误：",
    "repl.error": "错误：",
    "repl.unexpected_error": "意外错误：",

    // ── 设置 ──────────────────────────────────────────────────────────
    "settings.title": "设置",
    "settings.usage": "用法：/settings <键> <值>",
    "settings.usage_key": "用法：/settings",
    "settings.must_be_0_2": "必须在 0-2 之间。",
    "settings.must_be_1_50000": "必须在 1-50000 之间。",
    "settings.unknown_setting": "未知设置：",
    "settings.updated": "已更新。",
    "settings.not_set": "（未设置）",

    // ── 沙箱 ──────────────────────────────────────────────────────────
    "sandbox.title": "沙箱",
    "sandbox.sandboxed": "已沙箱隔离",
    "sandbox.unsandboxed": "未隔离",
    "sandbox.all_domains": "（全部）",
    "sandbox.usage": "用法：/sandbox on|off|strict|subagents|network",
    "sandbox.on_msg": "沙箱：开启（工作区范围，资源限制）",
    "sandbox.strict_msg": "沙箱：严格（只读根文件系统，网络受限）",
    "sandbox.off_msg": "沙箱：关闭 — 无隔离保护",
    "sandbox.subagent_sandbox": "子代理沙箱：",
    "sandbox.network": "沙箱网络：",
    "sandbox.unknown_option": "未知沙箱选项：",
    "sandbox.options": "选项：on, off, strict, subagents, network",

    // ── 代理 ──────────────────────────────────────────────────────────
    "agents.create_usage": "用法：/agents create <名称>",
    "agents.created": "已创建代理：",
    "agents.edit_hint": "编辑该文件以自定义代理的系统提示和工具。",
    "agents.create_error": "创建代理出错：",
    "agents.unknown_option": "未知 /agents 选项：",
    "agents.options": "选项：list, create <名称>",

    // ── 实验室 ────────────────────────────────────────────────────────
    "labs.title": "实验室（实验性功能）",
    "labs.master_switch": "主开关：",
    "labs.on": "实验室模式：开启 — 实验性功能可用",
    "labs.off": "实验室模式：关闭 — 所有实验性功能已禁用",
    "labs.master_off_note": "注意：实验室主开关已关闭。使用 /labs on 开启",
    "labs.available_ids": "可用 ID：",
    "labs.toggle_hint": "切换：/labs <功能ID> [on|off]",
    "labs.ids_label": "ID：",
    "labs.active": "已激活",
    "labs.off_status": "关闭",

    // ── 初始化 ────────────────────────────────────────────────────────
    "init.already_exists": "项目配置已存在：",
    "init.created": "已创建项目配置：",
    "init.edit_hint": "编辑此文件以添加 Mercury Code 的项目专属指令。",
    "init.error": "创建配置出错：",

    // ── Diff ──────────────────────────────────────────────────────────
    "diff.no_changes": "未检测到更改。",
    "diff.error": "Git diff 错误：",

    // ── 压缩 ──────────────────────────────────────────────────────────
    "compact.compacting": "正在压缩对话...",
    "compact.done": "已压缩：",
    "compact.messages": "条消息",
    "compact.error": "压缩错误：",

    // ── 新建 / 复制 ──────────────────────────────────────────────────
    "new.session_saved": "当前会话已保存。",
    "new.started": "已开始新对话。之前的会话已保存。",
    "copy.no_message": "没有助手消息可复制。",
    "copy.copied": "已复制",
    "copy.chars_to_clipboard": "字符到剪贴板。",
    "copy.not_available": "剪贴板不可用。最后一条助手回复：",

    // ── 历史 ──────────────────────────────────────────────────────────
    "history.saved": "已保存：",
    "history.restore_usage": "用法：/history restore <编号>",
    "history.not_found": "未找到：",
    "history.restored": "已恢复",
    "history.messages": "条消息",
    "history.unknown": "未知：",
    "history.options": "选项：list, save, restore",

    // ── 上下文信息 ───────────────────────────────────────────────────
    "context.title": "上下文使用情况",
    "context.api_reported": "API 报告",
    "context.estimated": "估算 (bytes/4)",
    "context.messages": "消息数",
    "context.checkpoints": "检查点",
    "context.session": "会话",
    "context.compression": "压缩",
    "context.super": "超级 (50%)",
    "context.normal": "普通 (80%)",
    "context.estimation": "估算方式",
    "context.estimation_desc": "Codex 风格 (bytes÷4 + API 使用量)",

    // ── 退出 ──────────────────────────────────────────────────────────
    "exit.auto_saved": "会话已自动保存。",
    "exit.goodbye": "再见！",

    // ── 语言 ──────────────────────────────────────────────────────────
    "lang.current": "语言：",
    "lang.changed": "语言已切换为：",
    "lang.invalid": "无效的语言。支持：",
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a translated string by key.
 * Falls back to English if key is missing in current locale.
 * Falls back to the key itself if not found in English either.
 * @param {string} key - Dot-separated key (e.g., "welcome.powered_by")
 * @returns {string}
 */
export function t(key) {
  return strings[_currentLocale]?.[key]
    || strings[DEFAULT_LOCALE]?.[key]
    || key;
}

/**
 * Get the current locale.
 * @returns {string}
 */
export function getLocale() {
  return _currentLocale;
}

/**
 * Set the current locale.
 * @param {string} locale - Locale code ("en" or "zh")
 * @returns {boolean} Whether the locale was valid and set
 */
export function setLocale(locale) {
  const normalized = _normalizeLocale(locale);
  if (SUPPORTED_LOCALES.includes(normalized)) {
    _currentLocale = normalized;
    _saveLocale(normalized);
    return true;
  }
  return false;
}

/**
 * Get list of supported locales.
 * @returns {string[]}
 */
export function getSupportedLocales() {
  return [...SUPPORTED_LOCALES];
}

/**
 * Detect locale from environment and persisted config.
 * Priority: persisted config > MERCURY_LANG env > LANG env > default
 */
export async function detectLocale() {
  // 1. Check persisted preference
  const saved = await _loadLocale();
  if (saved && SUPPORTED_LOCALES.includes(saved)) {
    _currentLocale = saved;
    return;
  }

  // 2. Check MERCURY_LANG env var
  const envLang = process.env.MERCURY_LANG;
  if (envLang) {
    const normalized = _normalizeLocale(envLang);
    if (SUPPORTED_LOCALES.includes(normalized)) {
      _currentLocale = normalized;
      return;
    }
  }

  // 3. Check system LANG env var
  const sysLang = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "";
  const normalized = _normalizeLocale(sysLang);
  if (SUPPORTED_LOCALES.includes(normalized)) {
    _currentLocale = normalized;
    return;
  }

  // 4. Default
  _currentLocale = DEFAULT_LOCALE;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a locale string to our supported format.
 * "zh_CN.UTF-8" → "zh", "en_US" → "en", "Chinese" → "zh"
 */
function _normalizeLocale(input) {
  if (!input || typeof input !== "string") return DEFAULT_LOCALE;
  const lower = input.toLowerCase().trim();

  // Direct match
  if (SUPPORTED_LOCALES.includes(lower)) return lower;

  // Common aliases
  if (lower.startsWith("zh") || lower === "chinese" || lower === "中文") return "zh";
  if (lower.startsWith("en") || lower === "english") return "en";

  // Extract language code from locale string (e.g., "en_US.UTF-8" → "en")
  const code = lower.split(/[_.\-]/)[0];
  if (SUPPORTED_LOCALES.includes(code)) return code;

  return DEFAULT_LOCALE;
}

const _configPath = path.join(os.homedir(), ".mercury", "locale.json");

async function _loadLocale() {
  try {
    const data = await readFile(_configPath, "utf-8");
    const config = JSON.parse(data);
    return config.locale || null;
  } catch {
    return null;
  }
}

async function _saveLocale(locale) {
  try {
    const dir = path.dirname(_configPath);
    await mkdir(dir, { recursive: true });
    await writeFile(_configPath, JSON.stringify({ locale }, null, 2), "utf-8");
  } catch {
    // non-critical
  }
}
