#!/usr/bin/env bash
# ============================================================================
# Mercury Code - 一键安装脚本
# 交互式 AI 编程助手，由 Inception Labs 的 Mercury-2 扩散模型驱动
# 支持 Linux 和 macOS
# ============================================================================

set -euo pipefail

# ── 颜色定义 ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── 辅助函数 ─────────────────────────────────────────────────────────────────

# 打印带颜色的信息
info()  { echo -e "${CYAN}[信息]${RESET} $1"; }
ok()    { echo -e "${GREEN}[成功]${RESET} $1"; }
warn()  { echo -e "${YELLOW}[警告]${RESET} $1"; }
fail()  { echo -e "${RED}[错误]${RESET} $1"; exit 1; }

# ── 检测操作系统 ─────────────────────────────────────────────────────────────
detect_os() {
    local uname_out
    uname_out="$(uname -s)"
    case "${uname_out}" in
        Linux*)     OS="Linux";;
        Darwin*)    OS="macOS";;
        *)          fail "不支持的操作系统: ${uname_out}。此脚本仅支持 Linux 和 macOS。";;
    esac
    info "检测到操作系统: ${OS}"
}

# ── 检查 Node.js 版本 ────────────────────────────────────────────────────────
# 要求 Node.js >= 18.17.0
check_node() {
    # 检查 node 是否已安装
    if ! command -v node &> /dev/null; then
        fail "未找到 Node.js。请先安装 Node.js >= 18.17.0。
  推荐安装方式:
    - nvm:    https://github.com/nvm-sh/nvm
    - fnm:    https://github.com/Schniz/fnm
    - 官方下载: https://nodejs.org/"
    fi

    # 获取当前 node 版本
    local node_version
    node_version="$(node --version | sed 's/^v//')"
    info "检测到 Node.js 版本: v${node_version}"

    # 解析主版本号和次版本号
    local major minor patch
    IFS='.' read -r major minor patch <<< "${node_version}"

    # 要求 >= 18.17.0
    local required_major=18
    local required_minor=17
    local required_patch=0

    local version_ok=false

    if [ "${major}" -gt "${required_major}" ]; then
        version_ok=true
    elif [ "${major}" -eq "${required_major}" ]; then
        if [ "${minor}" -gt "${required_minor}" ]; then
            version_ok=true
        elif [ "${minor}" -eq "${required_minor}" ]; then
            if [ "${patch}" -ge "${required_patch}" ]; then
                version_ok=true
            fi
        fi
    fi

    if [ "${version_ok}" = false ]; then
        fail "Node.js 版本过低: v${node_version}。需要 >= 18.17.0。
  请升级 Node.js:
    - nvm: nvm install 20
    - fnm: fnm install 20
    - 官方下载: https://nodejs.org/"
    fi

    ok "Node.js 版本检查通过: v${node_version} >= 18.17.0"
}

# ── 检查 npm 是否可用 ─────────────────────────────────────────────────────────
check_npm() {
    if ! command -v npm &> /dev/null; then
        fail "未找到 npm。请确保 npm 已随 Node.js 一起安装。"
    fi

    local npm_version
    npm_version="$(npm --version)"
    info "检测到 npm 版本: v${npm_version}"
}

# ── 检查是否与现有 Claude Code 安装冲突 ──────────────────────────────────────
check_conflicts() {
    info "检查是否存在包名冲突..."

    # 检查全局 npm 包中是否已安装同名 mercury-code
    if npm list -g mercury-code --depth=0 &> /dev/null; then
        warn "检测到已安装的 mercury-code 全局包，将会被覆盖更新。"
    fi

    # 确认不会与 claude-code 冲突（完全不同的包名）
    if npm list -g @anthropic-ai/claude-code --depth=0 &> /dev/null 2>&1; then
        info "检测到已安装的 Claude Code (@anthropic-ai/claude-code)，不会产生冲突。"
        info "Mercury Code 使用独立的命令名 'mercury-code'，两者可以共存。"
    fi

    # 检查 mercury-code 命令是否已存在于 PATH 中（来自其他来源）
    if command -v mercury-code &> /dev/null; then
        local existing_path
        existing_path="$(command -v mercury-code)"
        warn "发现已有 mercury-code 命令: ${existing_path}"
        warn "全局安装将会覆盖此命令。"
    fi

    ok "冲突检查完成，可以安全安装。"
}

# ── 安装 Mercury Code ─────────────────────────────────────────────────────────
install_mercury_code() {
    info "开始全局安装 Mercury Code..."

    # 获取脚本所在目录（即项目根目录）
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    info "项目目录: ${script_dir}"

    # 使用 npm install -g 从本地目录全局安装
    # 这会将 package.json 中 bin 字段定义的命令链接到全局
    if npm install -g "${script_dir}"; then
        ok "Mercury Code 全局安装成功！"
    else
        # 如果权限不够，提示使用 sudo
        warn "全局安装失败，可能需要管理员权限。"
        info "尝试使用 sudo 重新安装..."
        if sudo npm install -g "${script_dir}"; then
            ok "Mercury Code 全局安装成功！（使用了 sudo）"
        else
            fail "安装失败。请检查 npm 全局安装权限。
  解决方案:
    1. 使用 nvm 管理 Node.js（推荐，无需 sudo）
    2. 修改 npm 全局目录权限:
       mkdir -p ~/.npm-global
       npm config set prefix '~/.npm-global'
       export PATH=~/.npm-global/bin:\$PATH"
        fi
    fi
}

# ── 创建配置目录 ──────────────────────────────────────────────────────────────
setup_config_dir() {
    local config_dir="${HOME}/.mercury"

    info "设置配置目录: ${config_dir}"

    if [ -d "${config_dir}" ]; then
        info "配置目录已存在: ${config_dir}"
    else
        mkdir -p "${config_dir}"
        ok "已创建配置目录: ${config_dir}"
    fi

    # 创建默认配置文件（如果不存在）
    local config_file="${config_dir}/config.json"
    if [ ! -f "${config_file}" ]; then
        cat > "${config_file}" << 'CONFIGEOF'
{
  "model": "mercury-2",
  "max_tokens": 50000,
  "temperature": 0.75,
  "reasoning_effort": "medium",
  "stream": true
}
CONFIGEOF
        ok "已创建默认配置文件: ${config_file}"
    else
        info "配置文件已存在，跳过: ${config_file}"
    fi
}

# ── 验证安装 ──────────────────────────────────────────────────────────────────
verify_installation() {
    info "验证安装..."

    if command -v mercury-code &> /dev/null; then
        local installed_path
        installed_path="$(command -v mercury-code)"
        ok "mercury-code 命令已可用: ${installed_path}"
    else
        warn "mercury-code 命令未在 PATH 中找到。"
        warn "您可能需要重新打开终端，或手动将 npm 全局 bin 目录添加到 PATH:"
        local npm_bin
        npm_bin="$(npm bin -g 2>/dev/null || echo '(无法获取)')"
        warn "  export PATH=\"${npm_bin}:\$PATH\""
        return 1
    fi

    # 也检查 mercury 快捷命令
    if command -v mercury &> /dev/null; then
        ok "mercury 快捷命令也已可用。"
    fi

    # 打印版本
    local version
    version="$(mercury-code --version 2>/dev/null || echo '未知')"
    ok "已安装版本: ${version}"

    return 0
}

# ── 打印使用说明 ──────────────────────────────────────────────────────────────
print_getting_started() {
    echo ""
    echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${CYAN}${BOLD}║              Mercury Code 安装完成！                        ║${RESET}"
    echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -e "${BOLD}快速开始:${RESET}"
    echo ""
    echo -e "  ${YELLOW}1.${RESET} 设置 API 密钥（从 https://api.inceptionlabs.ai 获取）:"
    echo ""
    echo -e "     ${GREEN}export INCEPTION_API_KEY=your_key_here${RESET}"
    echo ""
    echo -e "     提示: 将上面这行添加到 ~/.bashrc 或 ~/.zshrc 中以永久生效。"
    echo ""
    echo -e "  ${YELLOW}2.${RESET} 启动交互式会话:"
    echo ""
    echo -e "     ${GREEN}mercury-code${RESET}"
    echo ""
    echo -e "  ${YELLOW}3.${RESET} 或使用单次提问模式:"
    echo ""
    echo -e "     ${GREEN}mercury-code -p \"请解释这个代码库\"${RESET}"
    echo ""
    echo -e "${BOLD}常用命令:${RESET}"
    echo ""
    echo -e "  ${GREEN}mercury-code${RESET}                          启动交互式 REPL"
    echo -e "  ${GREEN}mercury-code -p \"你的问题\"${RESET}            单次提问模式"
    echo -e "  ${GREEN}mercury-code --verbose${RESET}                 详细日志模式"
    echo -e "  ${GREEN}mercury-code --help${RESET}                    查看帮助信息"
    echo ""
    echo -e "${BOLD}交互式命令:${RESET}"
    echo ""
    echo -e "  ${GREEN}/help${RESET}              显示可用命令"
    echo -e "  ${GREEN}/clear${RESET}             清除对话历史"
    echo -e "  ${GREEN}/reasoning <级别>${RESET}  设置推理深度 (instant/low/medium/high)"
    echo -e "  ${GREEN}/supercompress${RESET}     切换上下文压缩模式"
    echo -e "  ${GREEN}/context${RESET}           查看上下文使用情况"
    echo -e "  ${GREEN}/config${RESET}            查看当前配置"
    echo -e "  ${GREEN}/exit${RESET}              退出"
    echo ""
    echo -e "${BOLD}配置目录:${RESET}"
    echo ""
    echo -e "  全局配置: ${CYAN}~/.mercury/config.json${RESET}"
    echo -e "  项目记忆: ${CYAN}.mercury/memory.md${RESET}     (每个项目目录)"
    echo -e "  对话日志: ${CYAN}.mercury/conversation.jsonl${RESET}"
    echo ""
    echo -e "${BOLD}注意:${RESET} Mercury Code 与 Anthropic 的 Claude Code 完全独立，"
    echo -e "两者使用不同的命令名和配置目录，可以在同一系统上共存。"
    echo ""
    echo -e "${CYAN}文档: https://github.com/nicepkg/mercury-code${RESET}"
    echo -e "${CYAN}API:  https://api.inceptionlabs.ai${RESET}"
    echo ""
}

# ============================================================================
# 主程序
# ============================================================================

main() {
    echo ""
    echo -e "${CYAN}${BOLD}Mercury Code 安装程序${RESET}"
    echo -e "${CYAN}由 Inception Labs 的 Mercury-2 扩散模型驱动${RESET}"
    echo ""

    # 第一步: 检测操作系统
    detect_os

    # 第二步: 检查 Node.js 版本
    check_node

    # 第三步: 检查 npm
    check_npm

    # 第四步: 检查冲突
    check_conflicts

    # 第五步: 全局安装
    install_mercury_code

    # 第六步: 创建配置目录
    setup_config_dir

    # 第七步: 验证安装
    verify_installation

    # 第八步: 打印使用说明
    print_getting_started
}

main "$@"
