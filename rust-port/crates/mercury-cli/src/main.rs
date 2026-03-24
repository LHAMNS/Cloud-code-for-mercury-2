// Mercury Code - CLI Entry Point
// Interactive AI coding assistant powered by Mercury-2 from Inception Labs
// Cross-platform: Linux, macOS (Intel + Apple Silicon), Windows
// Ported from: cli.js (485 lines)

use std::io::IsTerminal;
use std::path::PathBuf;

use clap::Parser;
use tracing::{error, info, warn};

mod command_router;
mod history;
mod hooks;
mod labs;
mod mcp;
mod project_config;
mod repl;
mod rollback;
mod skills;
mod system_prompt;
mod utils;

use repl::MercuryRepl;

// ── CLI argument parsing ───────────────────────────────────────────────────────

/// Interactive AI coding assistant powered by Mercury-2 from Inception Labs.
#[derive(Parser, Debug)]
#[command(
    name = "mercury-code",
    version,
    about = "Interactive AI coding assistant powered by Mercury-2"
)]
struct Cli {
    /// Start browser-hosted web console mode
    #[arg(long)]
    web: bool,

    /// Enable verbose / debug output
    #[arg(long)]
    verbose: bool,

    /// Force command-line mode
    #[arg(long)]
    cli: bool,

    /// AI provider: mercury (default), openai
    #[arg(long)]
    provider: Option<String>,

    /// Model to use (e.g., mercury-2, gpt-4o)
    #[arg(long)]
    model: Option<String>,

    /// Permission mode: readonly, approval (default), acceptEdits, open, dontAsk, aiSafetyDecide
    #[arg(long, value_name = "MODE")]
    trust_mode: Option<String>,

    /// Set initial workspace directory
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// Resume a saved session by ID
    #[arg(long)]
    resume: Option<String>,

    /// Run in non-interactive (single-shot) mode with given prompt
    #[arg(short, long)]
    prompt: Option<String>,

    /// Start in plan mode (read-only, creates a plan file)
    #[arg(long)]
    plan: bool,

    /// Disable sandbox isolation
    #[arg(long)]
    no_sandbox: bool,

    /// Set sandbox mode: on (default), strict, off
    #[arg(long, value_name = "MODE")]
    sandbox: Option<String>,

    /// Web mode bind host (default: 127.0.0.1)
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Web mode bind port (default: random free port)
    #[arg(long, default_value = "0")]
    port: u16,

    /// Path to MCP servers config file
    #[arg(long, value_name = "PATH")]
    mcp_config: Option<PathBuf>,

    /// Allow workspace .mercury/mcp.json or .mcp.json
    #[arg(long)]
    allow_project_mcp: bool,

    /// Allow workspace .mercury/hooks.json
    #[arg(long)]
    allow_project_hooks: bool,
}

// ── API key resolution ─────────────────────────────────────────────────────────

/// Resolve the API key from environment or interactive prompt.
fn resolve_api_key(provider_name: &str, is_web_child: bool) -> anyhow::Result<Option<String>> {
    let env_key = match provider_name {
        "openai" => "OPENAI_API_KEY",
        _ => "INCEPTION_API_KEY",
    };

    if let Ok(val) = std::env::var(env_key) {
        if !val.is_empty() {
            return Ok(Some(val));
        }
    }

    if is_web_child {
        return Ok(None);
    }

    // Non-interactive: error out
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        anyhow::bail!(
            "{} environment variable is required for provider \"{}\".\n\
             Set it with:\n  export {}=your_key_here",
            env_key,
            provider_name,
            env_key
        );
    }

    // Interactive: ask for API key
    eprintln!();
    eprintln!("\x1b[33m\x1b[1mAPI key required.\x1b[0m");
    eprintln!("Provider: {}", provider_name);
    eprintln!(
        "Paste your API key for this session (env: {}).",
        env_key
    );
    eprintln!("It will only be kept in memory unless you export it yourself.");

    // Read key from stdin without echoing (best-effort)
    eprint!("\n{}: ", env_key);
    let mut key = String::new();
    std::io::stdin().read_line(&mut key)?;
    let key = key.trim().to_string();

    if key.is_empty() {
        anyhow::bail!(
            "{} is required to start Mercury Code with provider \"{}\".\n\
             Set it with:\n  export {}=your_key_here",
            env_key,
            provider_name,
            env_key
        );
    }

    Ok(Some(key))
}

// ── Launch mode selection ──────────────────────────────────────────────────────

/// Determine the launch mode (cli or web) interactively if needed.
fn determine_launch_mode(cli: &Cli) -> String {
    if cli.prompt.is_some() || cli.web {
        if cli.web {
            return "web".to_string();
        }
        return "cli".to_string();
    }

    if cli.cli || std::env::var("MERCURY_WEB_CHILD").as_deref() == Ok("1") {
        return "cli".to_string();
    }

    // Check if running as a web child
    if std::env::var("MERCURY_WEB_CHILD").as_deref() == Ok("1") {
        return "cli-child".to_string();
    }

    // Non-interactive: default to CLI
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return "cli".to_string();
    }

    // Interactive: ask user
    eprintln!();
    eprintln!("\x1b[36m\x1b[1mMercury Code Launch\x1b[0m");
    eprintln!("  1. Command line");
    eprintln!("  2. Web console");
    eprint!("\nSelect mode [1]: ");

    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    let normalized = answer.trim().to_lowercase();

    if normalized == "2" || normalized == "web" || normalized == "w" {
        "web".to_string()
    } else {
        "cli".to_string()
    }
}

// ── Main ───────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Initialize tracing
    let filter = if cli.verbose {
        "mercury=debug,info"
    } else {
        "mercury=info,warn"
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter)),
        )
        .with_writer(std::io::stderr)
        .init();

    if let Err(e) = run(cli).await {
        error!("{}", e);
        if let Some(source) = e.source() {
            error!("Caused by: {}", source);
        }
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let is_web_child = std::env::var("MERCURY_WEB_CHILD").as_deref() == Ok("1");
    let selected_mode = determine_launch_mode(&cli);

    let provider_name = cli
        .provider
        .clone()
        .or_else(|| std::env::var("MERCURY_PROVIDER").ok())
        .unwrap_or_else(|| "mercury".to_string());

    // Resolve trust mode
    let initial_trust_mode = if cli.plan {
        "readonly".to_string()
    } else {
        cli.trust_mode
            .clone()
            .unwrap_or_else(|| "approval".to_string())
    };

    // Resolve workspace
    let workspace = cli
        .workspace
        .clone()
        .or_else(|| std::env::var("MERCURY_WORKSPACE").ok().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let workspace_str = workspace.to_string_lossy().to_string();

    // Resolve sandbox mode
    let sandbox_mode = if cli.no_sandbox {
        "off".to_string()
    } else {
        cli.sandbox
            .clone()
            .unwrap_or_else(|| "on".to_string())
    };

    // Resolve API key
    let api_key = resolve_api_key(&provider_name, is_web_child || selected_mode == "cli-child")?;

    // ── Web mode ──
    if selected_mode == "web" {
        // Security warning for non-localhost binding
        if cli.host != "127.0.0.1" && cli.host != "localhost" && cli.host != "::1" {
            warn!("");
            warn!("\x1b[33m\x1b[1mSecurity Warning:\x1b[0m");
            warn!(
                "\x1b[33m   Binding to {} will expose Mercury Code to the network.\x1b[0m",
                cli.host
            );
            warn!("\x1b[33m   Anyone on the network could access your AI coding assistant.\x1b[0m");
            warn!("\x1b[33m   Only use this if you understand the risks.\x1b[0m");
            warn!("");
        }

        let options = mercury_web::server::WebServerOptions {
            host: cli.host.clone(),
            port: cli.port,
            workspace: workspace_str.clone(),
            trust_mode: initial_trust_mode.clone(),
            sandbox_mode: sandbox_mode.clone(),
            verbose: cli.verbose,
            auto_open: true,
            provider: provider_name.clone(),
            model: cli.model.clone(),
            max_sessions: 8,
        };

        let mut server = mercury_web::server::start_web_server(options).await?;

        let opened = server.open_browser();
        if opened {
            println!("Mercury Web UI listening at {}", server.url());
        } else {
            println!("Mercury Web UI listening at {}", server.launch_url());
            println!("Automatic browser open failed. Open the launch URL above manually.");
        }

        // Wait for shutdown signal
        let shutdown = async {
            let _ = tokio::signal::ctrl_c().await;
        };
        shutdown.await;

        server.close().await;
        return Ok(());
    }

    // ── CLI mode (REPL or single-shot) ──
    let repl_config = repl::ReplConfig {
        verbose: cli.verbose,
        workspace: PathBuf::from(&workspace_str),
        trust_mode: Some(initial_trust_mode.clone()),
        api_key,
        provider: Some(provider_name.clone()),
        model: cli.model.clone(),
        resume_session: cli.resume.clone(),
        pipe_prompt: cli.prompt.clone(),
        base_url: None,
    };

    let mut repl = MercuryRepl::new(repl_config).await?;

    if cli.prompt.is_some() {
        // Non-interactive / single-shot mode (handled via pipe_prompt in ReplConfig)
        repl.run().await?;
    } else {
        // Interactive REPL mode
        repl.run().await?;
    }

    Ok(())
}
