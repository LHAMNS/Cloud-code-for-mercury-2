// Mercury Code - Web Server
// HTTP server with SSE streaming, session management, and static file serving.
// Ported from: src/web-server.js (907 lines)

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream::{self, Stream};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::child::WebChild;

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_SESSIONS: usize = 8;
const MAX_BACKLOG: usize = 200;
const MAX_BACKLOG_BYTES: usize = 2 * 1024 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const ORPHAN_GRACE: Duration = Duration::from_secs(60);

// ── Embedded static files ──────────────────────────────────────────────────────

const INDEX_HTML: &str = include_str!("../static/index.html");
const APP_JS: &str = include_str!("../static/app.js");
const STYLES_CSS: &str = include_str!("../static/styles.css");

// ── Types ──────────────────────────────────────────────────────────────────────

/// Options for creating a MercuryWebServer.
#[derive(Debug, Clone)]
pub struct WebServerOptions {
    pub host: String,
    pub port: u16,
    pub workspace: String,
    pub trust_mode: String,
    pub sandbox_mode: String,
    pub verbose: bool,
    pub auto_open: bool,
    pub provider: String,
    pub model: Option<String>,
    pub max_sessions: usize,
}

impl Default for WebServerOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 0,
            workspace: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()),
            trust_mode: "approval".to_string(),
            sandbox_mode: "on".to_string(),
            verbose: false,
            auto_open: true,
            provider: "mercury".to_string(),
            model: None,
            max_sessions: MAX_SESSIONS,
        }
    }
}

/// A session snapshot returned to the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub id: String,
    pub mode: String,
    pub workspace: String,
    pub trust_mode: String,
    pub sandbox: String,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub last_activity_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    pub status: String,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub backlog_size: usize,
}

/// SSE event payload sent to clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsePayload {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    #[serde(flatten)]
    pub data: Value,
}

/// Request body for creating a session.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreateSessionRequest {
    pub workspace: Option<String>,
}

/// Request body for sending input.
#[derive(Debug, Clone, Deserialize)]
pub struct InputRequest {
    pub text: Option<String>,
    pub chars: Option<String>,
    pub mode: Option<String>,
}

/// Request body for beacon close.
#[derive(Debug, Clone, Deserialize)]
pub struct BeaconCloseRequest {
    pub token: Option<String>,
}

// ── WebCliSession ──────────────────────────────────────────────────────────────

/// A single web CLI session managing a child process and SSE broadcast.
pub struct WebCliSession {
    pub id: String,
    pub workspace: String,
    pub trust_mode: String,
    pub sandbox_mode: String,
    pub verbose: bool,
    pub provider: String,
    pub model: Option<String>,
    pub created_at: Instant,
    pub created_at_millis: i64,
    pub last_activity_at: RwLock<Instant>,
    pub last_activity_millis: RwLock<i64>,
    pub closed_at: RwLock<Option<i64>>,
    pub status: RwLock<String>,
    pub exit_code: RwLock<Option<i32>>,
    pub exit_signal: RwLock<Option<String>>,
    pub pid: Option<u32>,
    pub child: Mutex<Option<WebChild>>,
    pub backlog: RwLock<Vec<SsePayload>>,
    pub tx: broadcast::Sender<SsePayload>,
    seq: Mutex<u64>,
}

impl WebCliSession {
    /// Create a new session and spawn the child process.
    pub async fn new(
        id: String,
        workspace: String,
        trust_mode: String,
        sandbox_mode: String,
        verbose: bool,
        provider: String,
        model: Option<String>,
    ) -> anyhow::Result<Self> {
        let (tx, _) = broadcast::channel(256);
        let now = Instant::now();
        let now_millis = chrono::Utc::now().timestamp_millis();

        let child = WebChild::spawn(
            &workspace,
            &trust_mode,
            &sandbox_mode,
            verbose,
            &provider,
            model.as_deref(),
        )
        .await?;

        let pid = child.pid();

        let session = Self {
            id: id.clone(),
            workspace,
            trust_mode,
            sandbox_mode,
            verbose,
            provider,
            model,
            created_at: now,
            created_at_millis: now_millis,
            last_activity_at: RwLock::new(now),
            last_activity_millis: RwLock::new(now_millis),
            closed_at: RwLock::new(None),
            status: RwLock::new("running".to_string()),
            exit_code: RwLock::new(None),
            exit_signal: RwLock::new(None),
            pid,
            child: Mutex::new(Some(child)),
            backlog: RwLock::new(Vec::new()),
            tx,
            seq: Mutex::new(0),
        };

        // Start background reader for child stdout/stderr
        session.start_output_reader().await;

        Ok(session)
    }

    /// Start background tasks to read child output and broadcast as SSE events.
    async fn start_output_reader(&self) {
        let tx = self.tx.clone();
        let session_id = self.id.clone();

        let child_guard = self.child.lock().await;
        if let Some(child) = child_guard.as_ref() {
            // Clone the stdout/stderr receivers
            if let Some(mut stdout_rx) = child.take_stdout_rx().await {
                let tx_clone = tx.clone();
                let sid = session_id.clone();
                tokio::spawn(async move {
                    while let Some(text) = stdout_rx.recv().await {
                        let payload = SsePayload {
                            event_type: "stdout".to_string(),
                            session_id: sid.clone(),
                            data: json!({
                                "text": text,
                                "ts": chrono::Utc::now().timestamp_millis(),
                            }),
                        };
                        let _ = tx_clone.send(payload);
                    }
                });
            }

            if let Some(mut stderr_rx) = child.take_stderr_rx().await {
                let tx_clone = tx.clone();
                let sid = session_id.clone();
                tokio::spawn(async move {
                    while let Some(text) = stderr_rx.recv().await {
                        let payload = SsePayload {
                            event_type: "stderr".to_string(),
                            session_id: sid.clone(),
                            data: json!({
                                "text": text,
                                "ts": chrono::Utc::now().timestamp_millis(),
                            }),
                        };
                        let _ = tx_clone.send(payload);
                    }
                });
            }
        }
    }

    /// Emit an SSE event to all connected clients and store in backlog.
    pub async fn emit(&self, event_type: &str, data: Value) {
        let now_millis = chrono::Utc::now().timestamp_millis();
        *self.last_activity_at.write().await = Instant::now();
        *self.last_activity_millis.write().await = now_millis;

        let payload = SsePayload {
            event_type: event_type.to_string(),
            session_id: self.id.clone(),
            data,
        };

        // Store in backlog
        {
            let mut backlog = self.backlog.write().await;
            backlog.push(payload.clone());

            // Prune by count
            while backlog.len() > MAX_BACKLOG {
                backlog.remove(0);
            }

            // Prune by byte size
            let mut total_size = 0usize;
            let mut cutoff = None;
            for (i, item) in backlog.iter().enumerate().rev() {
                total_size += serde_json::to_string(item).unwrap_or_default().len();
                if total_size > MAX_BACKLOG_BYTES {
                    cutoff = Some(i + 1);
                    break;
                }
            }
            if let Some(cut) = cutoff {
                backlog.drain(0..cut);
            }
        }

        let _ = self.tx.send(payload);
    }

    /// Send user input to the child process.
    pub async fn send_input(&self, text: &str, mode: &str) -> anyhow::Result<()> {
        let mut child_guard = self.child.lock().await;
        if let Some(child) = child_guard.as_mut() {
            let normalized = text.replace("\r\n", "\n");
            child.send_input(&normalized).await?;

            let mut seq = self.seq.lock().await;
            *seq += 1;
            self.emit(
                "input",
                json!({
                    "seq": *seq,
                    "mode": mode,
                    "text": normalized,
                    "ts": chrono::Utc::now().timestamp_millis(),
                }),
            )
            .await;
        } else {
            anyhow::bail!("Session is not accepting input");
        }
        Ok(())
    }

    /// Send SIGINT to the child process.
    pub async fn interrupt(&self) -> bool {
        let child_guard = self.child.lock().await;
        if let Some(child) = child_guard.as_ref() {
            child.interrupt()
        } else {
            false
        }
    }

    /// Close the session and kill the child process.
    pub async fn close(&self, reason: &str) {
        let already_closed = self.closed_at.read().await.is_some();
        if already_closed {
            return;
        }

        let now_millis = chrono::Utc::now().timestamp_millis();
        *self.closed_at.write().await = Some(now_millis);

        let mut seq = self.seq.lock().await;
        *seq += 1;
        self.emit(
            "notice",
            json!({
                "seq": *seq,
                "label": "Session",
                "message": reason,
                "ts": now_millis,
            }),
        )
        .await;

        // Kill the child
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            child.kill().await;
        }

        *self.status.write().await = "exited".to_string();
    }

    /// Get a snapshot of the session state.
    pub async fn snapshot(&self) -> SessionSnapshot {
        let closed_at = *self.closed_at.read().await;
        let status = self.status.read().await.clone();
        let exit_code = *self.exit_code.read().await;
        let exit_signal = self.exit_signal.read().await.clone();
        let last_activity = *self.last_activity_millis.read().await;
        let backlog_size = self.backlog.read().await.len();

        SessionSnapshot {
            session_id: self.id.clone(),
            id: self.id.clone(),
            mode: "web".to_string(),
            workspace: self.workspace.clone(),
            trust_mode: self.trust_mode.clone(),
            sandbox: self.sandbox_mode.clone(),
            provider: self.provider.clone(),
            model: self.model.clone().unwrap_or_else(|| "mercury-2".to_string()),
            created_at: self.created_at_millis,
            last_activity_at: last_activity,
            closed_at,
            status,
            connected: closed_at.is_none(),
            exit_code,
            exit_signal,
            pid: self.pid,
            backlog_size,
        }
    }
}

// ── Shared server state ────────────────────────────────────────────────────────

/// Shared state across all request handlers.
pub struct ServerState {
    pub host: String,
    pub port: RwLock<u16>,
    pub workspace: String,
    pub trust_mode: String,
    pub sandbox_mode: String,
    pub verbose: bool,
    pub provider: String,
    pub model: Option<String>,
    pub max_sessions: usize,
    pub auth_token: String,
    pub sessions: RwLock<HashMap<String, Arc<WebCliSession>>>,
}

impl ServerState {
    /// Get the allowed origin hosts for CSRF checks.
    fn allowed_origin_hosts(&self) -> Vec<String> {
        let mut hosts = vec![self.host.clone()];
        if self.host == "127.0.0.1" || self.host == "0.0.0.0" {
            hosts.push("localhost".to_string());
            hosts.push("127.0.0.1".to_string());
        }
        if self.host == "::1" || self.host == "[::1]" {
            hosts.push("localhost".to_string());
            hosts.push("::1".to_string());
            hosts.push("[::1]".to_string());
        }
        hosts
    }

    /// Check if the request has a valid auth token.
    fn has_valid_token(&self, headers: &HeaderMap) -> bool {
        headers
            .get("x-mercury-web-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == self.auth_token)
            .unwrap_or(false)
    }

    /// Clamp a requested workspace path to be within the root workspace.
    fn clamp_workspace(&self, requested: Option<&str>) -> String {
        let root = &self.workspace;
        match requested {
            None => root.clone(),
            Some(req) => {
                let resolved = std::path::Path::new(root).join(req);
                match resolved.canonicalize() {
                    Ok(real) => {
                        let real_root = std::path::Path::new(root)
                            .canonicalize()
                            .unwrap_or_else(|_| std::path::PathBuf::from(root));
                        if real.starts_with(&real_root) {
                            resolved.to_string_lossy().to_string()
                        } else {
                            root.clone()
                        }
                    }
                    Err(_) => root.clone(),
                }
            }
        }
    }

    /// Create a new session.
    async fn create_session(
        self: &Arc<Self>,
        body: &CreateSessionRequest,
    ) -> anyhow::Result<Arc<WebCliSession>> {
        let sessions = self.sessions.read().await;
        if sessions.len() >= self.max_sessions {
            anyhow::bail!("Maximum {} web sessions reached", self.max_sessions);
        }
        drop(sessions);

        let session_id = Uuid::new_v4().to_string();
        let workspace = self.clamp_workspace(body.workspace.as_deref());

        let session = WebCliSession::new(
            session_id.clone(),
            workspace,
            self.trust_mode.clone(),
            self.sandbox_mode.clone(),
            self.verbose,
            self.provider.clone(),
            self.model.clone(),
        )
        .await?;

        let session = Arc::new(session);
        self.sessions
            .write()
            .await
            .insert(session_id, session.clone());
        Ok(session)
    }

    /// Get a session by ID.
    async fn get_session(&self, id: &str) -> Option<Arc<WebCliSession>> {
        self.sessions.read().await.get(id).cloned()
    }

    /// Remove a session by ID.
    async fn remove_session(&self, id: &str) {
        self.sessions.write().await.remove(id);
    }
}

// ── Route handlers ─────────────────────────────────────────────────────────────

/// Serve index.html.
async fn serve_index() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        INDEX_HTML,
    )
}

/// Serve app.js.
async fn serve_app_js() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        APP_JS,
    )
}

/// Serve styles.css.
async fn serve_styles_css() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        STYLES_CSS,
    )
}

/// JSON error response helper.
fn json_error(status: StatusCode, msg: &str) -> Response {
    let body = json!({"error": msg});
    (status, Json(body)).into_response()
}

/// JSON success response helper.
fn json_ok(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// Health check endpoint.
async fn api_health(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let port = *state.port.read().await;
    let session_count = state.sessions.read().await.len();
    json_ok(
        StatusCode::OK,
        json!({
            "ok": true,
            "url": format!("http://{}:{}", state.host, port),
            "sessions": session_count,
        }),
    )
}

/// Server metadata endpoint.
async fn api_meta(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let port = *state.port.read().await;
    let sessions = state.sessions.read().await;
    let mut snapshots = Vec::new();
    for session in sessions.values() {
        snapshots.push(session.snapshot().await);
    }
    json_ok(
        StatusCode::OK,
        json!({
            "mode": "web",
            "workspace": state.workspace,
            "trustMode": state.trust_mode,
            "sandbox": state.sandbox_mode,
            "provider": state.provider,
            "model": state.model.as_deref().unwrap_or("mercury-2"),
            "url": format!("http://{}:{}", state.host, port),
            "sessions": snapshots,
        }),
    )
}

/// List sessions endpoint.
async fn api_list_sessions(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let sessions = state.sessions.read().await;
    let mut snapshots = Vec::new();
    for session in sessions.values() {
        snapshots.push(session.snapshot().await);
    }
    json_ok(StatusCode::OK, json!({"sessions": snapshots}))
}

/// Create a new session.
async fn api_create_session(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(body): Json<CreateSessionRequest>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    match state.create_session(&body).await {
        Ok(session) => {
            let snapshot = session.snapshot().await;
            let events_url = format!("/api/sessions/{}/events", session.id);
            let mut resp = serde_json::to_value(&snapshot).unwrap_or_default();
            if let Some(obj) = resp.as_object_mut() {
                obj.insert("eventsUrl".to_string(), json!(events_url));
            }
            json_ok(StatusCode::CREATED, resp)
        }
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// Get session status.
async fn api_session_status(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    match state.get_session(&session_id).await {
        Some(session) => {
            let snapshot = session.snapshot().await;
            let mut val = serde_json::to_value(&snapshot).unwrap_or_default();
            if let Some(obj) = val.as_object_mut() {
                obj.insert("alive".to_string(), json!(true));
            }
            json_ok(StatusCode::OK, val)
        }
        None => json_ok(StatusCode::OK, json!({"alive": false})),
    }
}

/// Get session snapshot.
async fn api_get_session(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::NOT_FOUND, "Session not found");
    }
    match state.get_session(&session_id).await {
        Some(session) => {
            let snapshot = session.snapshot().await;
            json_ok(
                StatusCode::OK,
                serde_json::to_value(&snapshot).unwrap_or_default(),
            )
        }
        None => json_error(StatusCode::NOT_FOUND, "Session not found"),
    }
}

/// SSE event stream for a session.
async fn api_session_events(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::NOT_FOUND, "Session not found");
    }
    let session = match state.get_session(&session_id).await {
        Some(s) => s,
        None => return json_error(StatusCode::NOT_FOUND, "Session not found"),
    };

    let mut rx = session.tx.subscribe();

    // Replay backlog first, then live events
    let backlog = session.backlog.read().await.clone();
    let snapshot = session.snapshot().await;

    let mut status_payload = serde_json::to_value(&snapshot).unwrap_or_default();
    if let Some(obj) = status_payload.as_object_mut() {
        obj.insert("type".to_string(), json!("status"));
    }
    let backlog_stream = stream::iter(
        std::iter::once(Ok::<Event, axum::Error>(Event::default().data(
            serde_json::to_string(&status_payload).unwrap_or_default(),
        )))
        .chain(backlog.into_iter().map(|payload| {
            Ok(Event::default().data(serde_json::to_string(&payload).unwrap_or_default()))
        })),
    );

    let live_stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(payload) => {
                    let data = serde_json::to_string(&payload).unwrap_or_default();
                    yield Ok(Event::default().data(data));
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("SSE client lagged by {} messages", n);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    let combined = backlog_stream.chain(live_stream);

    Sse::new(combined)
        .keep_alive(KeepAlive::new().interval(HEARTBEAT_INTERVAL))
        .into_response()
}

/// Send input to a session.
async fn api_session_input(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<InputRequest>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::NOT_FOUND, "Session not found");
    }
    let session = match state.get_session(&session_id).await {
        Some(s) => s,
        None => return json_error(StatusCode::NOT_FOUND, "Session not found"),
    };
    let text = body
        .text
        .or(body.chars)
        .unwrap_or_default();
    let mode = body.mode.as_deref().unwrap_or("line");
    match session.send_input(&text, mode).await {
        Ok(()) => json_ok(StatusCode::ACCEPTED, json!({"ok": true})),
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err.to_string()),
    }
}

/// Interrupt a session.
async fn api_session_interrupt(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::NOT_FOUND, "Session not found");
    }
    let session = match state.get_session(&session_id).await {
        Some(s) => s,
        None => return json_error(StatusCode::NOT_FOUND, "Session not found"),
    };
    let ok = session.interrupt().await;
    json_ok(StatusCode::OK, json!({"ok": ok}))
}

/// Delete (close) a session.
async fn api_delete_session(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    if !state.has_valid_token(&headers) {
        return json_error(StatusCode::NOT_FOUND, "Session not found");
    }
    if let Some(session) = state.get_session(&session_id).await {
        session.close("Session closed from web UI").await;
    }
    json_ok(StatusCode::OK, json!({"ok": true}))
}

/// Beacon close endpoint (sendBeacon from browser tab close).
async fn api_session_beacon_close(
    State(state): State<Arc<ServerState>>,
    Path(session_id): Path<String>,
    Json(body): Json<BeaconCloseRequest>,
) -> Response {
    // Beacon close uses token in POST body (sendBeacon cannot set headers)
    let authorized = body
        .token
        .as_ref()
        .map(|t| t == &state.auth_token)
        .unwrap_or(false);
    if !authorized {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    if let Some(session) = state.get_session(&session_id).await {
        session
            .close("Browser tab closed (beacon)")
            .await;
    }
    json_ok(StatusCode::OK, json!({"ok": true}))
}

// ── Server builder ─────────────────────────────────────────────────────────────

/// The Mercury web server.
pub struct MercuryWebServer {
    pub state: Arc<ServerState>,
    pub actual_port: u16,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl MercuryWebServer {
    /// Get the server URL.
    pub fn url(&self) -> String {
        format!("http://{}:{}", self.state.host, self.actual_port)
    }

    /// Get the launch URL with auth token in fragment.
    pub fn launch_url(&self) -> String {
        format!(
            "{}/#token={}",
            self.url(),
            urlencoding::encode(&self.state.auth_token)
        )
    }

    /// Open the browser to the launch URL.
    pub fn open_browser(&self) -> bool {
        let url = self.launch_url();
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&url)
                .spawn()
                .is_ok()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/c", "start", "", &url])
                .spawn()
                .is_ok()
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(&url)
                .spawn()
                .is_ok()
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            false
        }
    }

    /// Shut down the server and all sessions.
    pub async fn close(&mut self) {
        // Close all sessions
        let sessions: Vec<Arc<WebCliSession>> =
            self.state.sessions.read().await.values().cloned().collect();
        for session in &sessions {
            session.close("Server shutting down").await;
        }
        self.state.sessions.write().await.clear();

        // Signal shutdown
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Build the axum router.
fn build_router(state: Arc<ServerState>) -> Router {
    Router::new()
        // Static files
        .route("/", get(serve_index))
        .route("/index.html", get(serve_index))
        .route("/app.js", get(serve_app_js))
        .route("/styles.css", get(serve_styles_css))
        // API routes
        .route("/api/health", get(api_health))
        .route("/api/meta", get(api_meta))
        .route("/api/sessions", get(api_list_sessions).post(api_create_session))
        .route("/api/sessions/:session_id", get(api_get_session).delete(api_delete_session))
        .route("/api/sessions/:session_id/status", get(api_session_status))
        .route(
            "/api/sessions/:session_id/events",
            get(api_session_events),
        )
        .route(
            "/api/sessions/:session_id/stream",
            get(api_session_events),
        )
        .route("/api/sessions/:session_id/input", post(api_session_input))
        .route(
            "/api/sessions/:session_id/interrupt",
            post(api_session_interrupt),
        )
        .route(
            "/api/sessions/:session_id/beacon-close",
            post(api_session_beacon_close),
        )
        .with_state(state)
}

/// Start the web server and return the server handle.
pub async fn start_web_server(options: WebServerOptions) -> anyhow::Result<MercuryWebServer> {
    // Security: reject binding to 0.0.0.0 — force loopback only
    let host = if options.host == "0.0.0.0" || options.host == "::" {
        warn!("[Mercury Web] Warning: binding to 0.0.0.0 is blocked for security. Using 127.0.0.1 instead.");
        "127.0.0.1".to_string()
    } else {
        options.host.clone()
    };

    let auth_token = Uuid::new_v4().to_string();

    let state = Arc::new(ServerState {
        host: host.clone(),
        port: RwLock::new(options.port),
        workspace: options.workspace,
        trust_mode: options.trust_mode,
        sandbox_mode: options.sandbox_mode,
        verbose: options.verbose,
        provider: options.provider,
        model: options.model,
        max_sessions: options.max_sessions,
        auth_token,
        sessions: RwLock::new(HashMap::new()),
    });

    let app = build_router(state.clone());

    let addr: SocketAddr = format!("{}:{}", host, options.port)
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid bind address: {}", e))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_addr = listener.local_addr()?;
    let actual_port = actual_addr.port();

    *state.port.write().await = actual_port;

    info!(
        "Mercury Web UI listening at http://{}:{}",
        host, actual_port
    );

    // Start idle session reaper
    let reaper_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let sessions = reaper_state.sessions.read().await;
            let mut to_close = Vec::new();
            for (id, session) in sessions.iter() {
                let last = *session.last_activity_at.read().await;
                if last.elapsed() >= SESSION_TTL {
                    to_close.push(id.clone());
                }
            }
            drop(sessions);
            for id in to_close {
                if let Some(session) = reaper_state.get_session(&id).await {
                    session.close("Idle session reaped").await;
                    reaper_state.remove_session(&id).await;
                }
            }
        }
    });

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    // Spawn the server
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
    });

    Ok(MercuryWebServer {
        state,
        actual_port,
        shutdown_tx: Some(shutdown_tx),
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_options() {
        let opts = WebServerOptions::default();
        assert_eq!(opts.host, "127.0.0.1");
        assert_eq!(opts.port, 0);
        assert_eq!(opts.trust_mode, "approval");
        assert_eq!(opts.sandbox_mode, "on");
        assert!(!opts.verbose);
        assert_eq!(opts.max_sessions, MAX_SESSIONS);
    }

    #[test]
    fn test_session_snapshot_serialization() {
        let snapshot = SessionSnapshot {
            session_id: "test-id".to_string(),
            id: "test-id".to_string(),
            mode: "web".to_string(),
            workspace: "/tmp".to_string(),
            trust_mode: "approval".to_string(),
            sandbox: "on".to_string(),
            provider: "mercury".to_string(),
            model: "mercury-2".to_string(),
            created_at: 1000,
            last_activity_at: 2000,
            closed_at: None,
            status: "running".to_string(),
            connected: true,
            exit_code: None,
            exit_signal: None,
            pid: Some(1234),
            backlog_size: 0,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("sessionId"));
        assert!(json.contains("trustMode"));
    }

    #[test]
    fn test_clamp_workspace() {
        let state = ServerState {
            host: "127.0.0.1".to_string(),
            port: RwLock::new(3000),
            workspace: "/tmp/test-workspace".to_string(),
            trust_mode: "approval".to_string(),
            sandbox_mode: "on".to_string(),
            verbose: false,
            provider: "mercury".to_string(),
            model: None,
            max_sessions: 8,
            auth_token: "test-token".to_string(),
            sessions: RwLock::new(HashMap::new()),
        };

        // None -> root
        assert_eq!(state.clamp_workspace(None), "/tmp/test-workspace");

        // Traversal attempt -> root
        assert_eq!(
            state.clamp_workspace(Some("../../etc")),
            "/tmp/test-workspace"
        );
    }
}
