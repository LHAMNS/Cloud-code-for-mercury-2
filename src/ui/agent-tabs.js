// Mercury Code - Interactive Agent Tab System
// Shows running sub-agents as navigable tabs below terminal output.
// Navigation: ↓ focus bar, ←/→ switch agent, Enter open/close, ↑/Esc exit.

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const GRAY = `${ESC}90m`;
const fg256 = (n) => `${ESC}38;5;${n}m`;
const BRAND = [fg256(30), fg256(37), fg256(44), fg256(51), fg256(87), fg256(123)];
const TAB_SPINNER = ["◐", "◓", "◑", "◒"];

function termWidth() {
  return process.stdout.columns || 80;
}

/**
 * Interactive tab bar for sub-agent display and navigation.
 * Renders below the terminal output with real-time status updates.
 *
 * Usage:
 *   const bar = new AgentTabBar();
 *   bar.addAgent("Search codebase for bugs");
 *   bar.addAgent("Audit security issues");
 *   bar.start(); // begins animation + keyboard listener
 *   // ... agents run, call bar.update() / bar.finish() ...
 *   bar.cleanup(); // stop animation, remove listener, clear display
 */
export class AgentTabBar {
  constructor() {
    this.agents = [];
    this.selectedIndex = 0;
    this.focused = false;
    this._spinnerFrame = 0;
    this._interval = null;
    this._drawnLines = 0;
    this._keyHandler = null;
    this._onNavigate = null; // optional callback when navigation changes
  }

  /**
   * Add a new agent to the tab bar.
   * @param {string|{task:string}} task - Agent task description
   * @returns {number} Index of the added agent
   */
  addAgent(task) {
    const agent = {
      task: typeof task === "string" ? task : task.task,
      status: "waiting",    // waiting | thinking | tool | compress | done | error
      statusText: "Initializing...",
      activity: [],          // recent action log (last 8 entries)
      open: false,           // whether detail panel is expanded
      done: false,
      success: false,
      turns: 0,
      toolCount: 0,
      startTime: Date.now(),
    };
    this.agents.push(agent);
    return this.agents.length - 1;
  }

  /**
   * Start animation timer and install keyboard listener.
   */
  start() {
    if (this._interval) return;
    process.stdout.write(`${ESC}?25l`); // hide cursor

    // Spinner + re-render at 150ms
    this._interval = setInterval(() => {
      this._spinnerFrame++;
      this._render();
    }, 150);

    // Install keypress handler for tab navigation
    this._keyHandler = (_str, key) => {
      if (!key || this.agents.length === 0) return;

      if (this.focused) {
        switch (key.name) {
          case "left":
            this.selectedIndex = (this.selectedIndex - 1 + this.agents.length) % this.agents.length;
            this._render();
            break;
          case "right":
            this.selectedIndex = (this.selectedIndex + 1) % this.agents.length;
            this._render();
            break;
          case "return":
            this.agents[this.selectedIndex].open = !this.agents[this.selectedIndex].open;
            this._render();
            break;
          case "up":
          case "escape":
            this.focused = false;
            this._render();
            break;
        }
      } else if (key.name === "down") {
        this.focused = true;
        this._render();
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.on("keypress", this._keyHandler);
    }

    this._render();
  }

  /**
   * Update an agent's status.
   * @param {number} index - Agent index
   * @param {string} event - Event type: thinking | tool_call | tool_result | compressing
   * @param {string} [detail] - Event detail text
   */
  update(index, event, detail) {
    if (index < 0 || index >= this.agents.length) return;
    const agent = this.agents[index];
    if (agent.done) return;

    switch (event) {
      case "thinking":
        agent.status = "thinking";
        agent.turns++;
        agent.statusText = `Thinking... (Turn ${agent.turns})`;
        break;
      case "tool_call":
        agent.status = "tool";
        agent.toolCount++;
        agent.statusText = detail || "Running tool...";
        agent.activity.push(`├─ ${detail || "tool"}`);
        if (agent.activity.length > 8) agent.activity.shift();
        break;
      case "tool_result":
        agent.statusText = detail || "Processing...";
        break;
      case "compressing":
        agent.status = "compress";
        agent.statusText = "Compressing context...";
        agent.activity.push("├─ 🗜 Context compression");
        if (agent.activity.length > 8) agent.activity.shift();
        break;
    }
  }

  /**
   * Mark an agent as finished.
   * @param {number} index - Agent index
   * @param {boolean} success - Whether the agent succeeded
   * @param {string} [summary] - Brief result summary
   */
  finish(index, success, summary) {
    if (index < 0 || index >= this.agents.length) return;
    const agent = this.agents[index];
    agent.done = true;
    agent.success = success;
    const elapsed = ((Date.now() - agent.startTime) / 1000).toFixed(1);
    agent.statusText = success
      ? `Done (${agent.turns} turns, ${agent.toolCount} tools, ${elapsed}s)`
      : `Error (${elapsed}s)`;
    agent.activity.push(
      success
        ? `└─ ${GREEN}✓${RESET} Completed in ${elapsed}s`
        : `└─ ${RED}✗${RESET} ${(summary || "Failed").slice(0, 60)}`
    );
  }

  /**
   * Check if all agents are done.
   */
  get allDone() {
    return this.agents.length > 0 && this.agents.every((a) => a.done);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render() {
    // Clear previously drawn lines
    this._clearDrawn();

    const lines = this._buildOutput();
    this._drawnLines = lines.length;
    if (lines.length > 0) {
      process.stdout.write(lines.join("\n") + "\n");
    }
  }

  _clearDrawn() {
    if (this._drawnLines > 0) {
      process.stdout.write(`${ESC}${this._drawnLines}A`);
      for (let i = 0; i < this._drawnLines; i++) {
        process.stdout.write(`${ESC}2K\n`);
      }
      process.stdout.write(`${ESC}${this._drawnLines}A`);
    }
  }

  _buildOutput() {
    if (this.agents.length === 0) return [];
    const w = Math.min(termWidth() - 2, 80);
    const lines = [];

    // Hint line (only when not focused)
    if (!this.focused && !this.allDone) {
      lines.push(`${GRAY}  Press ↓ to navigate agents${RESET}`);
    } else if (this.focused) {
      lines.push(`${fg256(87)}  ←/→ switch  Enter open/close  ↑/Esc exit${RESET}`);
    }

    // Tab bar line
    lines.push(this._renderTabLine());

    // Expanded agent details
    for (let i = 0; i < this.agents.length; i++) {
      if (this.agents[i].open) {
        lines.push(...this._renderDetail(i, w));
      }
    }

    return lines;
  }

  _renderTabLine() {
    const tabs = this.agents.map((_, i) => this._renderTab(i));
    const label = this.focused
      ? `${fg256(87)}${BOLD}  Agents${RESET} `
      : `${GRAY}  Agents${RESET} `;
    return label + tabs.join(" ");
  }

  _renderTab(index) {
    const agent = this.agents[index];
    const isSelected = this.focused && index === this.selectedIndex;
    const num = index + 1;

    // Status icon
    let icon;
    if (agent.done) {
      icon = agent.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    } else {
      const frame = TAB_SPINNER[this._spinnerFrame % TAB_SPINNER.length];
      const color = BRAND[this._spinnerFrame % BRAND.length];
      icon = `${color}${frame}${RESET}`;
    }

    // Short task label
    const maxLen = 20;
    const label = agent.task.length > maxLen
      ? agent.task.slice(0, maxLen - 3) + "..."
      : agent.task;

    // Expand indicator
    const exp = agent.open ? "▾" : "▸";

    if (isSelected) {
      return `${fg256(87)}${BOLD}[${exp}${num}: ${icon} ${label}]${RESET}`;
    }
    return `${GRAY}[${exp}${num}: ${icon} ${label}]${RESET}`;
  }

  _renderDetail(index, width) {
    const agent = this.agents[index];
    const lines = [];
    const inner = width - 6;

    // Border color based on status
    const bc = agent.done
      ? (agent.success ? GREEN : RED)
      : fg256(75);

    // Task title
    const title = agent.task.length > inner - 14
      ? agent.task.slice(0, inner - 17) + "..."
      : agent.task;
    const pad = Math.max(0, inner - title.length - 10);
    lines.push(`${bc}  ╭─ Agent ${index + 1}: ${BOLD}${title}${RESET}${bc} ${"─".repeat(pad)}╮${RESET}`);

    // Status + elapsed
    const elapsed = ((Date.now() - agent.startTime) / 1000).toFixed(1);
    const statusIcon = agent.done
      ? (agent.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`)
      : `${BRAND[this._spinnerFrame % BRAND.length]}${TAB_SPINNER[this._spinnerFrame % TAB_SPINNER.length]}${RESET}`;
    lines.push(`${bc}  │${RESET} ${statusIcon} ${agent.statusText} ${GRAY}(${elapsed}s)${RESET}`);

    // Stats line
    lines.push(`${bc}  │${RESET} ${DIM}Turns: ${agent.turns}  Tools: ${agent.toolCount}${RESET}`);

    // Activity log
    const recentActivity = agent.activity.slice(-5);
    for (const act of recentActivity) {
      const truncAct = act.length > inner ? act.slice(0, inner - 3) + "..." : act;
      lines.push(`${bc}  │${RESET}   ${DIM}${truncAct}${RESET}`);
    }

    // Footer
    lines.push(`${bc}  ╰${"─".repeat(width - 4)}╯${RESET}`);

    return lines;
  }

  /**
   * Stop animation, remove keyboard listener, clear display.
   */
  cleanup() {
    // Stop animation
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    // Remove keyboard listener
    if (this._keyHandler) {
      process.stdin.removeListener("keypress", this._keyHandler);
      this._keyHandler = null;
    }

    // Clear drawn content
    this._clearDrawn();
    this._drawnLines = 0;

    // Show cursor
    process.stdout.write(`${ESC}?25h`);
  }

  /**
   * Render a final compact summary of all agent results (non-interactive).
   * Called after cleanup to show a brief summary.
   */
  printSummary() {
    console.log("");
    const header = `${fg256(75)}  ┌─ ${BOLD}Sub-Agent Results${RESET}${fg256(75)} ${"─".repeat(Math.min(termWidth() - 28, 50))}${RESET}`;
    console.log(header);

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      const icon = agent.done
        ? (agent.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`)
        : `${YELLOW}?${RESET}`;
      const elapsed = ((Date.now() - agent.startTime) / 1000).toFixed(1);
      const label = agent.task.length > 45
        ? agent.task.slice(0, 42) + "..."
        : agent.task;

      console.log(
        `${fg256(75)}  │${RESET} ${icon} ${BOLD}${i + 1}.${RESET} ${label} ${GRAY}(${elapsed}s, ${agent.turns}t)${RESET}`
      );
    }

    console.log(`${fg256(75)}  └${"─".repeat(Math.min(termWidth() - 4, 68))}${RESET}`);
  }
}
