// Mercury Code - Web Child Process Manager
// Spawns and manages the mercury-code CLI as a child process for web mode.
// Ported from: src/web-child.js (168 lines)

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tracing::{debug, error};

// ── WebChild ───────────────────────────────────────────────────────────────────

/// Manages a CLI child process for web bridge mode.
///
/// The child process is a `mercury-code` binary spawned with environment
/// variables that put it into web-bridge mode. Communication happens via
/// stdin (write input) and stdout/stderr (read output).
pub struct WebChild {
    child: Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout_rx: Mutex<Option<mpsc::Receiver<String>>>,
    stderr_rx: Mutex<Option<mpsc::Receiver<String>>>,
}

impl WebChild {
    /// Spawn a new mercury-code child process in web bridge mode.
    ///
    /// The child inherits the workspace, trust mode, sandbox mode, and other
    /// settings via environment variables. Its stdout and stderr are captured
    /// and forwarded via channels.
    pub async fn spawn(
        workspace: &str,
        trust_mode: &str,
        sandbox_mode: &str,
        verbose: bool,
        provider: &str,
        model: Option<&str>,
    ) -> anyhow::Result<Self> {
        // Find the mercury-code binary (same binary, different mode)
        let exe = std::env::current_exe()
            .unwrap_or_else(|_| std::path::PathBuf::from("mercury-code"));

        let mut cmd = Command::new(&exe);
        cmd.arg("--cli");
        cmd.current_dir(workspace);

        // Set environment variables for web bridge mode
        cmd.env("MERCURY_WEB_CHILD", "1");
        cmd.env("MERCURY_WORKSPACE", workspace);
        cmd.env("MERCURY_TRUST_MODE", trust_mode);
        cmd.env("MERCURY_SANDBOX_MODE", sandbox_mode);
        cmd.env("MERCURY_VERBOSE", if verbose { "1" } else { "0" });
        cmd.env("MERCURY_PROVIDER", provider);

        if let Some(model) = model {
            cmd.env("MERCURY_MODEL", model);
        }

        // Propagate API keys from current environment
        for key in &[
            "INCEPTION_API_KEY",
            "OPENAI_API_KEY",
            "FORCE_COLOR",
            "TERM",
        ] {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, val);
            }
        }

        // Default terminal settings
        if std::env::var("FORCE_COLOR").is_err() {
            cmd.env("FORCE_COLOR", "1");
        }
        if std::env::var("TERM").is_err() {
            cmd.env("TERM", "xterm-256color");
        }

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "Failed to spawn mercury-code child process: {}. Binary: {:?}",
                e,
                exe
            )
        })?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Set up stdout reader channel
        let (stdout_tx, stdout_rx) = mpsc::channel::<String>(1024);
        if let Some(stdout) = stdout {
            let tx = stdout_tx;
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::with_capacity(4096);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let text = String::from_utf8_lossy(&buf).to_string();
                            if tx.send(text).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            debug!("Child stdout read error: {}", e);
                            break;
                        }
                    }
                }
            });
        }

        // Set up stderr reader channel
        let (stderr_tx, stderr_rx) = mpsc::channel::<String>(1024);
        if let Some(stderr) = stderr {
            let tx = stderr_tx;
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::with_capacity(4096);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let text = String::from_utf8_lossy(&buf).to_string();
                            if tx.send(text).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            debug!("Child stderr read error: {}", e);
                            break;
                        }
                    }
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            stdout_rx: Mutex::new(Some(stdout_rx)),
            stderr_rx: Mutex::new(Some(stderr_rx)),
        })
    }

    /// Get the child process PID.
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Send user input to the child process via stdin.
    pub async fn send_input(&mut self, text: &str) -> anyhow::Result<()> {
        if let Some(ref mut stdin) = self.stdin {
            stdin.write_all(text.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
            Ok(())
        } else {
            anyhow::bail!("Child stdin is not available")
        }
    }

    /// Send SIGINT (Ctrl+C) to the child process.
    pub fn interrupt(&self) -> bool {
        #[cfg(unix)]
        {
            if let Some(pid) = self.child.id() {
                // Send SIGINT to the child process
                unsafe {
                    libc::kill(pid as i32, libc::SIGINT) == 0
                }
            } else {
                false
            }
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// Kill the child process.
    pub async fn kill(&mut self) {
        // Drop stdin to signal EOF
        self.stdin.take();

        // Try SIGTERM first, then SIGKILL after a timeout
        if let Err(e) = self.child.kill().await {
            debug!("Failed to kill child process: {}", e);
        }
    }

    /// Take the stdout receiver channel (can only be called once).
    pub async fn take_stdout_rx(&self) -> Option<mpsc::Receiver<String>> {
        self.stdout_rx.lock().await.take()
    }

    /// Take the stderr receiver channel (can only be called once).
    pub async fn take_stderr_rx(&self) -> Option<mpsc::Receiver<String>> {
        self.stderr_rx.lock().await.take()
    }

    /// Wait for the child to exit and return the exit code.
    pub async fn wait(&mut self) -> Option<i32> {
        match self.child.wait().await {
            Ok(status) => status.code(),
            Err(e) => {
                error!("Failed to wait for child process: {}", e);
                None
            }
        }
    }

    /// Check if the child process is still running.
    pub fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,  // Still running
            Ok(Some(_)) => false, // Exited
            Err(_) => false,
        }
    }
}

impl Drop for WebChild {
    fn drop(&mut self) {
        // Best-effort kill on drop
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.start_kill();
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_web_child_struct_size() {
        // Ensure the struct is not accidentally huge
        assert!(std::mem::size_of::<WebChild>() < 1024);
    }
}
