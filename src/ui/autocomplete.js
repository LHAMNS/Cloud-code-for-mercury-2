// Mercury Code - Interactive Cascading Autocomplete Widget
// Provides two-level dropdown completion for slash commands:
//   Level 1: Command selection (/trust, /sandbox, /reasoning, ...)
//   Level 2: Parameter selection (readonly, approval, on, off, ...)
// Flow: Tab → command menu → Enter/→ drill into params → Enter confirm.
// Navigation: ↑↓ scroll, →/Enter drill/confirm, ←back, Esc cancel.

import { ESC, RESET, BOLD, DIM, GRAY, CYAN } from "../utils/colors.js";

const TEAL = `${ESC}38;2;78;201;176m`;
const AMBER = `${ESC}38;2;206;145;120m`;
const BG_SEL = `${ESC}48;2;40;60;80m`;  // Selection background
const BG_MENU = `${ESC}48;2;25;25;35m`; // Menu background
const ARROW_R = "\u25B8"; // ▸

// ── Command Parameter Definitions ──────────────────────────────────────────

const COMMAND_PARAMS = {
  trust: {
    params: ["readonly", "approval", "acceptedits", "open", "dontask", "aisafetydecide", "plan", "outside"],
    descriptions: {
      readonly:       "Read-only mode (no file writes)",
      approval:       "Ask before each action",
      acceptedits:    "Auto-accept file edits",
      open:           "Allow all actions",
      dontask:        "Skip all confirmations",
      aisafetydecide: "AI judges safety of actions",
      plan:           "Read-only analysis mode",
      outside:        "Toggle outside-workspace access",
    },
  },
  reasoning: {
    params: ["instant", "low", "medium", "high"],
    descriptions: {
      instant: "Fastest, no reasoning chain",
      low:     "Light reasoning",
      medium:  "Balanced (default)",
      high:    "Deep reasoning, slower",
    },
  },
  sandbox: {
    params: ["on", "off", "strict", "status"],
    descriptions: {
      on:     "Enable sandbox (default)",
      off:    "Disable sandbox",
      strict: "Strict sandbox mode",
      status: "Show sandbox status",
    },
  },
  history: {
    params: ["list", "save", "load", "delete", "export"],
    descriptions: {
      list:   "List saved sessions",
      save:   "Save current session",
      load:   "Load a saved session",
      delete: "Delete a saved session",
      export: "Export session to file",
    },
  },
  memory: {
    params: ["show", "add", "clear", "search"],
    descriptions: {
      show:   "Show current memory",
      add:    "Add a memory entry",
      clear:  "Clear all memory",
      search: "Search memory entries",
    },
  },
  export: {
    params: [".md", ".json", ".txt", ".html"],
    descriptions: {
      ".md":   "Markdown format",
      ".json": "JSON transcript",
      ".txt":  "Plain text",
      ".html": "Interactive HTML",
    },
  },
  sentinel: {
    params: ["on", "off", "status", "strict"],
    descriptions: {
      on:     "Enable context sentinel",
      off:    "Disable context sentinel",
      status: "Show sentinel status",
      strict: "Strict mode (block suspicious)",
    },
  },
  labs: {
    params: ["list", "enable", "disable"],
    descriptions: {
      list:    "List experimental features",
      enable:  "Enable a lab feature",
      disable: "Disable a lab feature",
    },
  },
  mcp: {
    params: ["status", "add", "remove", "restart", "list"],
    descriptions: {
      status:  "Show MCP server status",
      add:     "Add an MCP server",
      remove:  "Remove an MCP server",
      restart: "Restart MCP servers",
      list:    "List configured servers",
    },
  },
  agents: {
    params: ["list", "create", "delete", "show"],
    descriptions: {
      list:   "List available agents",
      create: "Create a new agent definition",
      delete: "Delete an agent definition",
      show:   "Show agent details",
    },
  },
  diff: {
    params: ["--staged", "--stat", "--name-only"],
    descriptions: {
      "--staged":    "Show only staged changes",
      "--stat":      "Show diff statistics",
      "--name-only": "Show only changed file names",
    },
  },
  provider: {
    params: ["list", "mercury", "openai"],
    descriptions: {
      list:    "List all providers and models",
      mercury: "Switch to Mercury-2 (Inception Labs)",
      openai:  "Switch to OpenAI (ChatGPT)",
    },
  },
  settings: {
    params: ["model", "max_tokens", "temperature", "reasoning_effort", "reasoning_summary", "stream", "diffusing"],
    descriptions: {
      model:             "Change AI model",
      max_tokens:        "Set max output tokens",
      temperature:       "Set temperature (0-2)",
      reasoning_effort:  "Set reasoning effort",
      reasoning_summary: "Toggle reasoning summary",
      stream:            "Toggle streaming output",
      diffusing:         "Toggle diffusion mode",
    },
  },
};

// ── Command-Level Descriptions ─────────────────────────────────────────────

const COMMAND_DESCRIPTIONS = {
  "/help":          "Show available commands",
  "/clear":         "Clear the terminal screen",
  "/trust":         "Set permission level",
  "/workspace":     "Show workspace info",
  "/reasoning":     "Set reasoning depth",
  "/supercompress": "Aggressively compress context",
  "/contextsearch": "Search conversation context",
  "/sandbox":       "Configure sandbox mode",
  "/history":       "Manage session history",
  "/context":       "Show context usage",
  "/settings":      "View/change settings",
  "/config":        "Edit configuration",
  "/edit":          "Open file in editor",
  "/exit":          "Exit Mercury Code",
  "/agents":        "Manage agent definitions",
  "/diff":          "Show git diff",
  "/compact":       "Compress conversation",
  "/new":           "Start new conversation",
  "/copy":          "Copy last response",
  "/init":          "Initialize project config",
  "/labs":          "Experimental features",
  "/cost":          "Show token costs",
  "/doctor":        "Run diagnostic checks",
  "/bug":           "Report a bug",
  "/status":        "Show system status",
  "/memory":        "Manage memory entries",
  "/model":         "Switch AI model",
  "/undo":          "Undo last change",
  "/login":         "Set API key",
  "/logout":        "Remove API key",
  "/verbose":       "Toggle verbose output",
  "/mcp":           "MCP server management",
  "/skills":        "List available skills",
  "/export":        "Export conversation",
  "/sentinel":      "Context sentinel settings",
  "/provider":      "Switch AI provider",
};

// ── Autocomplete Controller ────────────────────────────────────────────────

/**
 * Interactive cascading autocomplete widget for the Mercury REPL.
 * Two-level menu: commands → parameters.
 */
export class AutocompleteWidget {
  constructor(rl, slashCmds, skillManager) {
    this._rl = rl;
    this._slashCmds = slashCmds;
    this._skillManager = skillManager;
    this._menuVisible = false;
    this._menuItems = [];
    this._menuDescriptions = {};
    this._selectedIndex = 0;
    this._menuHeight = 0;
    this._commandContext = "";  // The command part (e.g., "/trust")
    this._menuType = "";        // "command" or "param"
    this._keypressHandler = null;
    this._originalTtyWrite = null;
  }

  getCommandParams(cmdName) {
    return COMMAND_PARAMS[cmdName] || null;
  }

  // ── Completer (called by readline on Tab) ────────────────────────────────

  completer(line) {
    if (!line.startsWith("/")) return [[], line];

    const parts = line.split(/\s+/);
    const cmd = parts[0];

    // ── Level 1: Command completion ──
    if (parts.length === 1) {
      const allCmds = [
        ...this._slashCmds,
        ...(this._skillManager ? this._skillManager.getCompletions() : []),
      ];
      const hits = allCmds.filter((c) => c.startsWith(line));

      if (hits.length === 1) {
        // Exact single match — auto-drill into its params
        const cmdName = hits[0].slice(1);
        const paramDef = COMMAND_PARAMS[cmdName];
        if (paramDef && paramDef.params.length > 0) {
          this._updateLine(hits[0] + " ");
          this._commandContext = hits[0];
          this._menuType = "param";
          this._showMenu(paramDef.params, paramDef.descriptions || {});
          return [[], line];
        }
        return [[hits[0] + " "], line];
      }

      if (hits.length > 1) {
        // Multiple matches — show interactive command menu
        this._commandContext = "";
        this._menuType = "command";
        const descs = {};
        for (const h of hits) descs[h] = COMMAND_DESCRIPTIONS[h] || "";
        this._showMenu(hits, descs);
        return [[], line];
      }

      return [[], line];
    }

    // ── Level 2: Parameter completion ──
    const cmdName = cmd.slice(1);
    const paramDef = COMMAND_PARAMS[cmdName];
    if (!paramDef) return [[], line];

    const partial = parts.slice(1).join(" ");
    const hits = paramDef.params.filter((p) => p.startsWith(partial));

    if (hits.length === 1) {
      return [[`${cmd} ${hits[0]}`], line];
    }

    const itemsToShow = hits.length > 0 ? hits : paramDef.params;
    this._commandContext = cmd;
    this._menuType = "param";
    this._showMenu(itemsToShow, paramDef.descriptions || {});
    return [[], line];
  }

  // ── Line manipulation ────────────────────────────────────────────────────

  _updateLine(newLine) {
    if (!this._rl) return;
    this._rl.line = newLine;
    this._rl.cursor = newLine.length;
    process.stdout.write(`\r${ESC}2K`);
    const prompt = (this._rl.getPrompt && this._rl.getPrompt()) || "";
    process.stdout.write(`${prompt}${newLine}`);
  }

  // ── Menu lifecycle ───────────────────────────────────────────────────────

  _showMenu(items, descriptions) {
    if (this._menuVisible) this._hideMenu();

    this._menuItems = items;
    this._menuDescriptions = descriptions;
    this._selectedIndex = 0;
    this._menuVisible = true;

    this._drawMenu();
    this._installMenuKeyHandler();
  }

  _hideMenu() {
    if (!this._menuVisible) return;
    this._clearMenuArea();
    this._menuVisible = false;
    this._uninstallMenuKeyHandler();
  }

  _clearMenuArea() {
    process.stdout.write(`${ESC}s`);
    for (let i = 0; i < this._menuHeight + 1; i++) {
      process.stdout.write(`\n${ESC}2K`);
    }
    process.stdout.write(`${ESC}u`);
  }

  _redrawMenu() {
    this._clearMenuArea();
    this._drawMenu();
  }

  // ── Menu rendering ───────────────────────────────────────────────────────

  _drawMenu() {
    const items = this._menuItems;
    const descs = this._menuDescriptions;
    const sel = this._selectedIndex;
    const isCmd = this._menuType === "command";

    const maxLabelLen = Math.max(...items.map((i) => i.length));
    const maxDescLen = Math.max(0, ...items.map((i) => (descs[i] || "").length));
    const drillCol = isCmd ? 3 : 0;
    const menuWidth = Math.min(
      (process.stdout.columns || 80) - 4,
      maxLabelLen + maxDescLen + 8 + drillCol
    );
    const displayCount = Math.min(items.length, 10);
    this._menuHeight = displayCount + 2;

    let scrollOff = 0;
    if (items.length > displayCount) {
      scrollOff = Math.max(0, Math.min(sel - Math.floor(displayCount / 2), items.length - displayCount));
    }

    process.stdout.write(`${ESC}s\n`);

    // Top border with contextual title
    const title = isCmd ? " Commands " : ` ${this._commandContext} `;
    const bLeft = Math.min(2, menuWidth - title.length);
    const bRight = Math.max(0, menuWidth - bLeft - title.length);
    process.stdout.write(
      `  ${GRAY}\u256D${"\u2500".repeat(bLeft)}${RESET}${DIM}${title}${RESET}${GRAY}${"\u2500".repeat(bRight)}\u256E${RESET}\n`
    );

    // Items
    for (let i = 0; i < displayCount; i++) {
      const idx = i + scrollOff;
      const item = items[idx];
      const desc = descs[item] || "";
      const isSel = idx === sel;
      const hasSub = isCmd && !!COMMAND_PARAMS[item.slice(1)];

      const label = item.padEnd(maxLabelLen + 2);
      const availW = menuWidth - maxLabelLen - 6 - drillCol;
      const dTrunc = desc.length > availW ? desc.slice(0, availW - 3) + "..." : desc;
      const pad = Math.max(0, menuWidth - label.length - dTrunc.length - 3 - drillCol);

      const drillMark = hasSub
        ? (isSel ? `${BG_SEL}${AMBER}${ARROW_R}${RESET}${BG_SEL} ${RESET}` : `${AMBER}${ARROW_R}${RESET} `)
        : (isSel ? `${BG_SEL}  ${RESET}` : "  ");

      if (isSel) {
        process.stdout.write(
          `  ${GRAY}\u2502${RESET}${BG_SEL}${BOLD}${CYAN} ${ARROW_R} ${label}${RESET}${BG_SEL}${DIM}${dTrunc}${RESET}${BG_SEL}${" ".repeat(pad)}${RESET}${drillMark}${GRAY}\u2502${RESET}\n`
        );
      } else {
        process.stdout.write(
          `  ${GRAY}\u2502${RESET}   ${label}${DIM}${dTrunc}${" ".repeat(pad)}${RESET}${drillMark}${GRAY}\u2502${RESET}\n`
        );
      }
    }

    // Scroll indicator
    if (items.length > displayCount) {
      const hasUp = scrollOff > 0;
      const hasDown = scrollOff + displayCount < items.length;
      const info = `${hasUp ? "\u25B2" : " "} ${sel + 1}/${items.length} ${hasDown ? "\u25BC" : " "}`;
      const sp = Math.max(0, menuWidth - info.length);
      process.stdout.write(
        `  ${GRAY}\u2502${RESET}${DIM}${" ".repeat(Math.floor(sp / 2))}${info}${" ".repeat(Math.ceil(sp / 2))}${RESET}${GRAY}\u2502${RESET}\n`
      );
      this._menuHeight++;
    }

    // Bottom border with context-sensitive hints
    const hint = isCmd
      ? `${DIM}\u2191\u2193 select  \u2192/Enter open  Esc cancel${RESET}`
      : `${DIM}\u2191\u2193 select  Enter confirm  \u2190 back  Esc cancel${RESET}`;
    const hintLen = isCmd ? 33 : 40;
    const padLen = Math.max(0, menuWidth - hintLen);
    process.stdout.write(
      `  ${GRAY}\u2570${"\u2500".repeat(Math.min(2, menuWidth))}${RESET} ${hint} ${GRAY}${"\u2500".repeat(Math.max(0, padLen - 3))}\u256F${RESET}\n`
    );

    process.stdout.write(`${ESC}u`);
  }

  // ── Selection handlers ───────────────────────────────────────────────────

  _selectItem() {
    const item = this._menuItems[this._selectedIndex];
    if (!item) return;

    if (this._menuType === "command") {
      this._selectCommand(item);
    } else {
      this._selectParam(item);
    }
  }

  /**
   * Command selected → insert it and cascade into param menu if available.
   */
  _selectCommand(cmd) {
    const cmdName = cmd.slice(1);
    const paramDef = COMMAND_PARAMS[cmdName];

    this._hideMenu();

    if (paramDef && paramDef.params.length > 0) {
      // Has params — insert command + space, then show param menu
      this._updateLine(cmd + " ");
      this._commandContext = cmd;
      this._menuType = "param";
      this._showMenu(paramDef.params, paramDef.descriptions || {});
    } else {
      // No params — just insert the command
      this._updateLine(cmd);
    }
  }

  /**
   * Parameter selected → insert full "command param" and close.
   */
  _selectParam(param) {
    this._hideMenu();
    if (this._commandContext) {
      this._updateLine(`${this._commandContext} ${param}`);
    }
  }

  /**
   * Go back from param menu → command menu (← key).
   */
  _goBack() {
    if (this._menuType !== "param") return;

    this._hideMenu();
    this._updateLine("/");

    // Rebuild command list and show command menu
    const allCmds = [
      ...this._slashCmds,
      ...(this._skillManager ? this._skillManager.getCompletions() : []),
    ];
    const descs = {};
    for (const c of allCmds) descs[c] = COMMAND_DESCRIPTIONS[c] || "";

    this._commandContext = "";
    this._menuType = "command";
    this._showMenu(allCmds, descs);
  }

  // ── Keyboard handling ────────────────────────────────────────────────────

  _installMenuKeyHandler() {
    this._uninstallMenuKeyHandler();

    // Block readline from processing keys while menu is open
    if (this._rl && this._rl._ttyWrite && !this._originalTtyWrite) {
      this._originalTtyWrite = this._rl._ttyWrite.bind(this._rl);
      this._rl._ttyWrite = (s, key) => {
        if (this._menuVisible) {
          // Only pass through Ctrl+C as safety valve
          if (key && key.ctrl && key.name === "c") {
            this._hideMenu();
            if (this._originalTtyWrite) this._originalTtyWrite(s, key);
          }
          return;
        }
        if (this._originalTtyWrite) this._originalTtyWrite(s, key);
      };
    }

    this._keypressHandler = (_str, key) => {
      if (!key || !this._menuVisible) return;

      switch (key.name) {
        case "up":
          this._selectedIndex = Math.max(0, this._selectedIndex - 1);
          this._redrawMenu();
          break;
        case "down":
          this._selectedIndex = Math.min(this._menuItems.length - 1, this._selectedIndex + 1);
          this._redrawMenu();
          break;
        case "return":
        case "right":
          // Enter or → : drill into params (command) or confirm (param)
          this._selectItem();
          break;
        case "left":
          // ← : go back from param menu to command menu
          if (this._menuType === "param") {
            this._goBack();
          }
          break;
        case "escape":
          this._hideMenu();
          break;
        case "tab":
          // Tab cycles forward
          this._selectedIndex = (this._selectedIndex + 1) % this._menuItems.length;
          this._redrawMenu();
          break;
      }
    };

    process.stdin.on("keypress", this._keypressHandler);
  }

  _uninstallMenuKeyHandler() {
    if (this._keypressHandler) {
      process.stdin.removeListener("keypress", this._keypressHandler);
      this._keypressHandler = null;
    }
    if (this._originalTtyWrite && this._rl) {
      this._rl._ttyWrite = this._originalTtyWrite;
      this._originalTtyWrite = null;
    }
  }

  dispose() {
    this._hideMenu();
    this._uninstallMenuKeyHandler();
  }
}
