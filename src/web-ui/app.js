/*
  Expected backend contract:

  POST   /api/sessions
    -> { sessionId, workspace?, trustMode?, sandbox?, model?, mode? }

  GET    /api/sessions/:sessionId/status
    -> { sessionId, workspace?, trustMode?, sandbox?, model?, mode?, connected? }

  POST   /api/sessions/:sessionId/input
    body: { text, mode: "line" | "multiline" }
    -> { ok: true }

  POST   /api/sessions/:sessionId/interrupt
    -> { ok: true }

  DELETE /api/sessions/:sessionId
    -> { ok: true }

  GET    /api/sessions/:sessionId/events
    SSE messages should carry JSON payloads. Recognized event shapes:
      { type: "session" | "status" | "notice" | "stdout" | "stderr" | "close" | "error", ... }
      For stream output, use { type: "stdout", text } or { type: "stderr", text }.
*/

const dom = {
  terminalStream: document.querySelector("#terminalStream"),
  terminalSurface: document.querySelector("#terminalSurface"),
  connectionPill: document.querySelector("#connectionPill"),
  connectionLabel: document.querySelector("#connectionLabel"),
  composerForm: document.querySelector("#composerForm"),
  composer: document.querySelector("#composer"),
  sendButton: document.querySelector("#sendButton"),
  clearComposerButton: document.querySelector("#clearComposerButton"),
  clearViewportButton: document.querySelector("#clearViewportButton"),
  copyOutputButton: document.querySelector("#copyOutputButton"),
  refreshStatusButton: document.querySelector("#refreshStatusButton"),
  newSessionButton: document.querySelector("#newSessionButton"),
  interruptButton: document.querySelector("#interruptButton"),
  composerHint: document.querySelector("#composerHint"),
  lineCounter: document.querySelector("#lineCounter"),
  charCounter: document.querySelector("#charCounter"),
  sessionIdValue: document.querySelector("#sessionIdValue"),
  modeValue: document.querySelector("#modeValue"),
  workspaceValue: document.querySelector("#workspaceValue"),
  trustValue: document.querySelector("#trustValue"),
  sandboxValue: document.querySelector("#sandboxValue"),
  modelValue: document.querySelector("#modelValue"),
  statusBadges: document.querySelector("#statusBadges"),
  quickActions: document.querySelector("#quickActions"),
  statusBadgeTemplate: document.querySelector("#statusBadgeTemplate"),
};

const MAX_STREAM_FRAGMENTS = 500;

const state = {
  sessionId: null,
  status: {},
  streamAbortController: null,
  ansiRemainder: "",
  connected: false,
  authToken: null,
  _reconnectAttempt: 0,
  _reconnectTimer: null,
};

function clearSavedSessionId() {
  try { sessionStorage.removeItem("mercury-session-id"); } catch { /* storage unavailable */ }
}

function getTokenFromLocation() {
  const currentUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(currentUrl.hash.startsWith("#") ? currentUrl.hash.slice(1) : currentUrl.hash);
  return hashParams.get("token") || currentUrl.searchParams.get("token") || null;
}

function scrubTokenFromUrl() {
  const currentUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(currentUrl.hash.startsWith("#") ? currentUrl.hash.slice(1) : currentUrl.hash);
  let changed = false;

  if (currentUrl.searchParams.has("token")) {
    currentUrl.searchParams.delete("token");
    changed = true;
  }
  if (hashParams.has("token")) {
    hashParams.delete("token");
    currentUrl.hash = hashParams.toString() ? `#${hashParams.toString()}` : "";
    changed = true;
  }

  if (changed) {
    history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  }
}

function getAuthHeaders(extraHeaders = {}) {
  if (!state.authToken) {
    throw new Error("Missing launch token. Re-open the Mercury launch URL from the CLI.");
  }
  return {
    "X-Mercury-Web-Token": state.authToken,
    ...extraHeaders,
  };
}

const ANSI_COLOR_MAP = {
  30: "#6f8097",
  31: "#ff8e8e",
  32: "#76f3b1",
  33: "#ffc87d",
  34: "#7fb8ff",
  35: "#e29bff",
  36: "#83f0ff",
  37: "#edf3ff",
  90: "#58677e",
  91: "#ff6e7b",
  92: "#73f5ad",
  93: "#ffd38d",
  94: "#8cc7ff",
  95: "#f2abff",
  96: "#97f7ff",
  97: "#ffffff",
};

const QUICK_NOTES = {
  connected: "Connected. Enter sends, Shift+Enter adds a line break.",
  connecting: "Starting a Mercury session…",
  disconnected: "Disconnected. Start a new session or retry status.",
};

function setConnection(stateName) {
  state.connected = stateName === "connected";
  dom.connectionPill.dataset.state = stateName;
  dom.connectionLabel.textContent =
    stateName === "connected"
      ? "Connected"
      : stateName === "disconnected"
        ? "Disconnected"
        : "Connecting…";
  dom.composerHint.textContent = QUICK_NOTES[stateName] || QUICK_NOTES.connecting;
}

function updateCounters() {
  const value = dom.composer.value;
  const lineCount = value.length === 0 ? 1 : value.split("\n").length;
  dom.lineCounter.textContent = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  dom.charCounter.textContent = `${value.length} chars`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeStatus(payload = {}) {
  if (payload.sessionId) {
    state.sessionId = payload.sessionId;
  }
  state.status = { ...state.status, ...payload };
  dom.sessionIdValue.textContent = payload.sessionId || state.sessionId || "Pending…";
  dom.modeValue.textContent = payload.mode || state.status.mode || "web";
  dom.workspaceValue.textContent = payload.workspace || state.status.workspace || "Pending…";
  dom.trustValue.textContent = payload.trustMode || state.status.trustMode || "Pending…";
  dom.sandboxValue.textContent = payload.sandbox || state.status.sandbox || "Pending…";
  dom.modelValue.textContent = payload.model || state.status.model || "Pending…";

  const badges = [];
  if (payload.planMode ?? state.status.planMode) badges.push("plan mode");
  if (payload.connected ?? state.status.connected) badges.push("streaming");
  if (payload.messages !== undefined) badges.push(`${payload.messages} msgs`);
  if (payload.contextPercent !== undefined) badges.push(`context ${payload.contextPercent}%`);
  renderBadges(badges);
}

function renderBadges(items) {
  dom.statusBadges.innerHTML = "";
  for (const item of items) {
    const fragment = dom.statusBadgeTemplate.content.cloneNode(true);
    fragment.querySelector(".pill").textContent = item;
    dom.statusBadges.appendChild(fragment);
  }
}

function appendNote(label, message) {
  flushMdBuffer(); // render any pending markdown before adding a note
  const el = document.createElement("div");
  el.className = "stream-note";
  el.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(message)}</span>`;
  dom.terminalStream.appendChild(el);
  scrollToBottom();
}

// Debounced scroll-to-bottom to avoid forced layout thrash on every fragment
let _scrollTimer = null;
function debouncedScrollToBottom() {
  if (_scrollTimer) return;
  _scrollTimer = setTimeout(() => {
    _scrollTimer = null;
    const el = dom.terminalStream;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, 50);
}

function scrollToBottom() {
  debouncedScrollToBottom();
}

// Prune oldest DOM fragments to prevent unbounded DOM growth
function pruneOldFragments() {
  const container = dom.terminalStream;
  while (container.children.length > MAX_STREAM_FRAGMENTS) {
    container.removeChild(container.firstChild);
  }
}

function ansiStyleToCss(styleState) {
  const rules = [];
  if (styleState.fg) rules.push(`color:${styleState.fg}`);
  if (styleState.bg) rules.push(`background:${styleState.bg}`);
  if (styleState.bold) rules.push("font-weight:700");
  if (styleState.dim) rules.push("opacity:0.68");
  if (styleState.italic) rules.push("font-style:italic");
  if (styleState.underline) rules.push("text-decoration:underline");
  return rules.join(";");
}

function extractIncompleteAnsi(buffer) {
  const escIndex = buffer.lastIndexOf("\u001b[");
  if (escIndex === -1) return { complete: buffer, remainder: "" };
  const candidate = buffer.slice(escIndex);
  if (/^\u001b\[[0-9;]*m$/.test(candidate)) {
    return { complete: buffer, remainder: "" };
  }
  if (/^\u001b\[[0-9;]*$/.test(candidate)) {
    return { complete: buffer.slice(0, escIndex), remainder: candidate };
  }
  return { complete: buffer, remainder: "" };
}

// NOTE: ansiToHtml uses a static property (ansiToHtml.styleState) to persist
// ANSI style state across calls. This means style state is shared globally and
// is not reset between different output sources or sessions. Call
// `ansiToHtml.styleState = null` (e.g. in clearViewport) to reset it manually.
function ansiToHtml(chunk) {
  const merged = state.ansiRemainder + chunk;
  const { complete, remainder } = extractIncompleteAnsi(merged);
  state.ansiRemainder = remainder;

  const styleState = ansiToHtml.styleState || {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };

  let html = "";
  let cursor = 0;
  while (cursor < complete.length) {
    if (complete[cursor] === "\u001b" && complete[cursor + 1] === "[") {
      const match = complete.slice(cursor).match(/^\u001b\[([0-9;]*)m/);
      if (match) {
        applyAnsiCodes(styleState, match[1]);
        cursor += match[0].length;
        continue;
      }
    }

    const nextEsc = complete.indexOf("\u001b[", cursor);
    const textChunk = complete.slice(cursor, nextEsc === -1 ? complete.length : nextEsc);
    if (textChunk) {
      const css = ansiStyleToCss(styleState);
      html += css
        ? `<span style="${css}">${escapeHtml(textChunk)}</span>`
        : escapeHtml(textChunk);
    }
    cursor = nextEsc === -1 ? complete.length : nextEsc;
  }

  ansiToHtml.styleState = styleState;
  return html;
}

function applyAnsiCodes(styleState, codeList = "") {
  const codes = codeList.length === 0 ? [0] : codeList.split(";").map((code) => Number(code || "0"));
  for (const code of codes) {
    if (code === 0) {
      styleState.fg = null;
      styleState.bg = null;
      styleState.bold = false;
      styleState.dim = false;
      styleState.italic = false;
      styleState.underline = false;
      continue;
    }
    if (code === 1) styleState.bold = true;
    else if (code === 2) styleState.dim = true;
    else if (code === 3) styleState.italic = true;
    else if (code === 4) styleState.underline = true;
    else if (code === 22) {
      styleState.bold = false;
      styleState.dim = false;
    } else if (code === 23) {
      styleState.italic = false;
    } else if (code === 24) {
      styleState.underline = false;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      styleState.fg = ANSI_COLOR_MAP[code] || null;
    } else if (code === 39) {
      styleState.fg = null;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      styleState.bg = ANSI_COLOR_MAP[code - 10] || null;
    } else if (code === 49) {
      styleState.bg = null;
    }
  }
}

// ─── Markdown + LaTeX Rendering ──────────────────────────────────────
let mdBuffer = "";
let mdFragments = [];
let mdRenderTimer = null;

function stripAnsi(str) {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

function protectMath(text) {
  const mathMap = [];
  let idx = 0;
  const save = (formula, display) => {
    const key = `%%MERCURYMATH${idx}%%`;
    mathMap.push({ key, formula, display });
    idx++;
    return display ? `\n\n${key}\n\n` : key;
  };

  // Protect fenced code blocks from math detection
  const codeMap = [];
  let cidx = 0;
  text = text.replace(/(```[\s\S]*?```)/g, (m) => {
    const key = `%%MERCURYCODE${cidx}%%`;
    codeMap.push({ key, code: m });
    cidx++;
    return key;
  });
  text = text.replace(/(`[^`\n]+`)/g, (m) => {
    const key = `%%MERCURYCODE${cidx}%%`;
    codeMap.push({ key, code: m });
    cidx++;
    return key;
  });

  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => save(f, true));
  // Display math: \[...\]
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, f) => save(f, true));
  // Inline math: \(...\)
  text = text.replace(/\\\((.+?)\\\)/g, (_, f) => save(f, false));
  // Inline math: $...$ (skip currency-like patterns)
  text = text.replace(/(?<![\\$])(?<!\w)\$([^\$\n]+?)\$(?!\d)/g, (match, f) => {
    if (/^\d+([.,]\d+)?$/.test(f.trim())) return match;
    return save(f, false);
  });

  // Restore code blocks
  for (const { key, code } of codeMap) {
    text = text.split(key).join(code);
  }

  return { text, mathMap };
}

function restoreMath(html, mathMap) {
  for (const { key, formula, display } of mathMap) {
    let rendered;
    if (typeof katex !== "undefined") {
      try {
        rendered = katex.renderToString(formula.trim(), {
          displayMode: display,
          throwOnError: false,
        });
      } catch {
        rendered = `<code class="latex-error">${escapeHtml(formula)}</code>`;
      }
    } else {
      rendered = escapeHtml(formula);
    }
    const pWrapped = `<p>${key}</p>`;
    if (html.includes(pWrapped)) {
      html = html.split(pWrapped).join(
        display
          ? `<div class="katex-display-wrapper">${rendered}</div>`
          : `<p>${rendered}</p>`
      );
    }
    html = html.split(key).join(rendered);
  }
  return html;
}

function sanitizeHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  // Remove script tags, event handlers, etc.
  const dangerous = div.querySelectorAll('script,iframe,object,embed,form,input,textarea,select,button,svg,math,style,link,base,meta');
  dangerous.forEach(el => el.remove());
  // Remove event handler attributes and dangerous URIs from all elements
  div.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      const lName = attr.name.toLowerCase();
      const lVal = attr.value.trimStart().toLowerCase();
      if (lName.startsWith('on') || lName === 'srcdoc' || lName === 'formaction' ||
          ((lName === 'href' || lName === 'src' || lName === 'action' || lName === 'xlink:href') &&
           (lVal.startsWith('javascript:') || lVal.startsWith('data:') || lVal.startsWith('vbscript:')))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return div.innerHTML;
}

function renderMarkdownContent(text) {
  if (typeof marked === "undefined") {
    return `<pre>${escapeHtml(text)}</pre>`;
  }

  const { text: mathSafe, mathMap } = protectMath(text);
  let html;
  try {
    html = marked.parse(mathSafe);
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }

  html = sanitizeHtml(html);
  html = restoreMath(html, mathMap);
  return html;
}

function highlightCodeBlocks(container) {
  if (typeof hljs !== "undefined") {
    container.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block);
    });
  }
}

function flushMdBuffer() {
  if (mdRenderTimer) {
    clearTimeout(mdRenderTimer);
    mdRenderTimer = null;
  }
  if (!mdBuffer || !mdBuffer.trim()) {
    mdBuffer = "";
    mdFragments = [];
    return;
  }

  const cleanText = stripAnsi(mdBuffer);
  const html = renderMarkdownContent(cleanText);

  const block = document.createElement("div");
  block.className = "stream-fragment rendered-markdown";
  block.innerHTML = sanitizeHtml(html);
  highlightCodeBlocks(block);

  // Insert before the first raw fragment
  const first = mdFragments[0];
  if (first && first.parentNode === dom.terminalStream) {
    dom.terminalStream.insertBefore(block, first);
  } else {
    dom.terminalStream.appendChild(block);
  }

  // Remove raw fragments
  for (const el of mdFragments) {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  mdBuffer = "";
  mdFragments = [];
  scrollToBottom();
}

function scheduleMdRender() {
  if (mdRenderTimer) clearTimeout(mdRenderTimer);
  mdRenderTimer = setTimeout(flushMdBuffer, 600);
}

function appendStreamText(text, level = "stdout") {
  if (!text) return;
  const wrapper = document.createElement("div");
  wrapper.className = `stream-fragment stream-fragment--${level}`;
  wrapper.innerHTML = ansiToHtml(text);
  dom.terminalStream.appendChild(wrapper);

  // Accumulate stdout for markdown rendering
  if (level === "stdout" && typeof marked !== "undefined") {
    mdBuffer += text;
    mdFragments.push(wrapper);
    scheduleMdRender();
  }

  pruneOldFragments();
  scrollToBottom();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...getAuthHeaders(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function createSession() {
  closeEventSource();
  setConnection("connecting");
  appendNote("Session", "Creating a new Mercury web session…");
  const payload = await requestJson("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  state.sessionId = payload.sessionId;
  try { sessionStorage.setItem("mercury-session-id", state.sessionId); } catch { /* storage unavailable */ }
  normalizeStatus(payload);
  connectToStream();
}

function closeEventSource() {
  if (state.streamAbortController) {
    state.streamAbortController.abort();
    state.streamAbortController = null;
  }
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  let eventName = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

function _scheduleReconnect() {
  if (state._reconnectTimer) return;
  const attempt = state._reconnectAttempt++;
  const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);
  state._reconnectTimer = setTimeout(() => {
    state._reconnectTimer = null;
    connectToStream();
  }, delayMs);
}

function _resetReconnect() {
  state._reconnectAttempt = 0;
  if (state._reconnectTimer) {
    clearTimeout(state._reconnectTimer);
    state._reconnectTimer = null;
  }
}

function retireSession(noteLabel = "Session", noteMessage = "") {
  flushMdBuffer();
  closeEventSource();
  _resetReconnect();
  state.sessionId = null;
  state.status = { ...state.status, connected: false };
  clearSavedSessionId();
  normalizeStatus({ sessionId: null, connected: false });
  setConnection("disconnected");
  if (noteMessage) {
    appendNote(noteLabel, noteMessage);
  }
}

function handleParsedSseEvent(parsed) {
  if (!parsed) return;
  try {
    const payload = JSON.parse(parsed.data);
    if (parsed.event === "close" && !payload.type) {
      payload.type = "close";
    }
    handleServerEvent(payload);
  } catch {
    appendStreamText(parsed.data, parsed.event === "error" ? "stderr" : "stdout");
  }
}

function drainSseBuffer(buffer, flushFinal = false) {
  let working = buffer;
  let boundary = working.indexOf("\n\n");
  while (boundary !== -1) {
    const rawEvent = working.slice(0, boundary);
    working = working.slice(boundary + 2);
    handleParsedSseEvent(parseSseEvent(rawEvent));
    boundary = working.indexOf("\n\n");
  }

  if (flushFinal && working.trim()) {
    handleParsedSseEvent(parseSseEvent(working.trim()));
    working = "";
  }

  return working;
}

async function connectToStream() {
  if (!state.sessionId) return;
  closeEventSource();

  const controller = new AbortController();
  state.streamAbortController = controller;

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/events`, {
      method: "GET",
      headers: getAuthHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 401 || response.status === 404) {
        retireSession("Session", message || "Session expired. Creating a new session…");
        try {
          await createSession();
        } catch (createError) {
          appendNote("Startup Error", createError.message);
        }
        return;
      }
      throw new Error(message || `${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("Streaming response body unavailable.");
    }

    setConnection("connected");
    _resetReconnect();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      buffer = drainSseBuffer(buffer, done);

      if (done) break;
    }

    if (!controller.signal.aborted && state.sessionId) {
      setConnection("disconnected");
      _scheduleReconnect();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    setConnection("disconnected");
    appendNote("Stream", error.message);
    _scheduleReconnect();
  } finally {
    if (state.streamAbortController === controller) {
      state.streamAbortController = null;
    }
  }
}

function handleServerEvent(payload) {
  switch (payload.type) {
    case "session":
    case "status":
      normalizeStatus(payload);
      break;
    case "stdout":
    case "chunk":
      appendStreamText(payload.text || "", "stdout");
      break;
    case "stderr":
    case "error":
      appendStreamText(payload.text || payload.message || "", "stderr");
      if (payload.message) appendNote("Error", payload.message);
      break;
    case "notice":
      appendNote(payload.label || "Notice", payload.message || "");
      break;
    case "close":
      retireSession("Session", payload.message || "Session closed.");
      break;
    default:
      if (payload.text) appendStreamText(payload.text, "stdout");
      else appendNote("Event", JSON.stringify(payload));
  }
}

async function refreshStatus() {
  if (!state.sessionId) return;
  const payload = await requestJson(`/api/sessions/${encodeURIComponent(state.sessionId)}/status`);
  normalizeStatus(payload);
}

async function sendComposerText() {
  const text = dom.composer.value.replace(/\r\n/g, "\n");
  if (!text.trim()) return;
  if (!state.sessionId) {
    await createSession();
  }

  const mode = text.includes("\n") ? "multiline" : "line";
  await requestJson(`/api/sessions/${encodeURIComponent(state.sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({ text, mode }),
  });
  dom.composer.value = "";
  updateCounters();
  dom.composer.focus();
}

async function sendQuickCommand(command) {
  if (!state.sessionId) {
    await createSession();
  }
  await requestJson(`/api/sessions/${encodeURIComponent(state.sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({ text: command, mode: "line" }),
  });
}

async function interruptSession() {
  if (!state.sessionId) return;
  await requestJson(`/api/sessions/${encodeURIComponent(state.sessionId)}/interrupt`, { method: "POST" });
  appendNote("Control", "Interrupt requested.");
}

async function closeSession() {
  if (!state.sessionId) return;
  await requestJson(`/api/sessions/${encodeURIComponent(state.sessionId)}`, { method: "DELETE" });
  retireSession();
}

async function copyOutput() {
  const text = dom.terminalStream.innerText;
  if (!navigator.clipboard?.writeText) {
    appendNote("Clipboard", "Clipboard API is not available in this browser.");
    return;
  }
  await navigator.clipboard.writeText(text);
  appendNote("Clipboard", "Terminal output copied.");
}

function clearViewport() {
  mdBuffer = "";
  mdFragments = [];
  if (mdRenderTimer) {
    clearTimeout(mdRenderTimer);
    mdRenderTimer = null;
  }
  dom.terminalStream.innerHTML = "";
  ansiToHtml.styleState = null;
  state.ansiRemainder = "";
}

function registerEvents() {
  dom.composer.addEventListener("input", updateCounters);
  dom.composer.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendComposerText();
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      await sendComposerText();
    }
  });

  dom.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendComposerText();
  });

  dom.clearComposerButton.addEventListener("click", () => {
    dom.composer.value = "";
    updateCounters();
    dom.composer.focus();
  });

  dom.clearViewportButton.addEventListener("click", clearViewport);
  dom.copyOutputButton.addEventListener("click", copyOutput);
  dom.refreshStatusButton.addEventListener("click", refreshStatus);
  dom.interruptButton.addEventListener("click", interruptSession);
  dom.newSessionButton.addEventListener("click", async () => {
    await closeSession().catch(() => {});
    clearViewport();
    await createSession();
  });

  dom.quickActions.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button) return;
    await sendQuickCommand(button.dataset.command);
  });

  window.addEventListener("beforeunload", () => {
    closeEventSource();
    if (state.sessionId && state.authToken) {
      navigator.sendBeacon(
        `/api/sessions/${encodeURIComponent(state.sessionId)}/beacon-close`,
        new Blob([JSON.stringify({ token: state.authToken })], { type: "application/json" })
      );
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.sessionId && !state.connected) {
      connectToStream();
    }
  });
}

async function bootstrap() {
  // Configure marked.js for GFM markdown
  if (typeof marked !== "undefined") {
    marked.use({ gfm: true, breaks: false });
  }
  registerEvents();
  updateCounters();
  try {
    state.authToken = getTokenFromLocation();
    scrubTokenFromUrl();
    if (!state.authToken) {
      throw new Error("Missing launch token. Re-open Mercury from the CLI.");
    }

    const meta = await requestJson("/api/meta");
    normalizeStatus({
      mode: meta.mode || "web",
      workspace: meta.workspace,
      trustMode: meta.trustMode,
      sandbox: meta.sandbox,
      provider: meta.provider || "mercury",
      model: meta.model || "mercury-2",
    });

    // Try to rejoin a previous session on refresh
    let rejoined = false;
    try {
      const savedId = sessionStorage.getItem("mercury-session-id");
      if (savedId) {
        const statusRes = await requestJson(`/api/sessions/${encodeURIComponent(savedId)}/status`);
        if (statusRes && statusRes.alive) {
          state.sessionId = savedId;
          normalizeStatus(statusRes);
          setConnection("connecting");
          appendNote("Session", "Rejoining existing session…");
          connectToStream();
          rejoined = true;
        }
      }
    } catch {
      // Previous session not available, create new one
    }

    if (!rejoined) {
      await createSession();
    }
    await refreshStatus().catch(() => {});
  } catch (error) {
    setConnection("disconnected");
    appendNote("Startup Error", error.message);
  }
}

bootstrap();
