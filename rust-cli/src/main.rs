mod codex_tier;
mod collector;
mod config;
mod crypto;
mod evidence;
mod github;
mod model;
mod pricing;
mod provider;
mod scheduler;
mod update;

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration as StdDuration, SystemTime};

use anyhow::{bail, Context, Result};
use chrono::{Duration, Local};
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::github::GithubClient;
use crate::model::DeviceInfo;

#[derive(Parser)]
#[command(
    name = "usagemesh",
    version,
    about = "Zero-server, cross-device AI coding token analytics"
)]
struct Cli {
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Subcommand)]
enum CommandKind {
    /// Configure the first device. The user's project fork is discovered/created automatically.
    Setup {
        /// Advanced override for a renamed or organization-owned fork.
        #[arg(long)]
        repo: Option<String>,
        /// GitHub credential. Usually omitted: env vars or an authenticated `gh` are auto-detected.
        #[arg(long)]
        token: Option<String>,
        /// Friendly device name. Defaults to the hostname.
        #[arg(long)]
        device: Option<String>,
        /// Dashboard password. Prefer the hidden prompt or USAGEMESH_DASHBOARD_PASSWORD over CLI history.
        #[arg(long)]
        dashboard_password: Option<String>,
        /// Configure without installing the native OS timer.
        #[arg(long)]
        no_schedule: bool,
    },
    /// Add this machine to an existing UsageMesh workspace using its pair code.
    Join {
        /// Pair code printed by `setup` or `invite` on an existing device.
        code: String,
        #[arg(long)]
        token: Option<String>,
        #[arg(long)]
        device: Option<String>,
        #[arg(long)]
        no_schedule: bool,
    },
    /// Set or change the memorable password used to open the web dashboard from any browser.
    Password {
        /// Prefer the hidden prompt or USAGEMESH_DASHBOARD_PASSWORD over CLI history.
        #[arg(long)]
        password: Option<String>,
    },
    /// Incrementally collect local usage and replace this device's encrypted GitHub snapshot.
    Sync {
        #[arg(long)]
        full: bool,
        #[arg(long)]
        quiet: bool,
    },
    /// Show local configuration, last sync and aggregate usage.
    Status,
    /// List every AI coding client supported by the embedded Tokscale scanner.
    Clients,
    /// Print a copy-paste command for adding another device.
    Invite,
    /// Print only the stable dashboard URL.
    Dashboard,
    /// Remove the native timer; optionally remove the remote snapshot and local data.
    Uninstall {
        #[arg(long)]
        remove_remote: bool,
        #[arg(long)]
        purge: bool,
    },
}

fn resolve_token(explicit: Option<String>) -> Result<String> {
    if let Some(token) = explicit.filter(|value| !value.trim().is_empty()) {
        return Ok(token.trim().to_string());
    }
    for key in ["USAGEMESH_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(token) = std::env::var(key) {
            if !token.trim().is_empty() {
                return Ok(token.trim().to_string());
            }
        }
    }
    if let Ok(output) = Command::new("gh").args(["auth", "token"]).output() {
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Ok(token);
            }
        }
    }
    let token =
        rpassword::prompt_password("GitHub token (hidden; stored locally for scheduled sync): ")?;
    if token.trim().is_empty() {
        bail!("GitHub authentication is required. Sign in with `gh auth login`, set GITHUB_TOKEN, or paste a token when prompted")
    }
    Ok(token.trim().to_string())
}

fn validate_dashboard_password(password: &str) -> Result<String> {
    let password = password.trim().to_string();
    if password.as_bytes().len() < 8 {
        bail!("dashboard password must be at least 8 bytes long")
    }
    if password.as_bytes().len() > 256 {
        bail!("dashboard password is unexpectedly long")
    }
    Ok(password)
}

fn resolve_dashboard_password(explicit: Option<String>) -> Result<String> {
    if let Some(password) = explicit.filter(|value| !value.trim().is_empty()) {
        return validate_dashboard_password(&password);
    }
    if let Ok(password) = std::env::var("USAGEMESH_DASHBOARD_PASSWORD") {
        if !password.trim().is_empty() {
            return validate_dashboard_password(&password);
        }
    }

    println!("Create a dashboard password (same password works from any browser).");
    let first = rpassword::prompt_password("Dashboard password (hidden, min 8 chars): ")?;
    let password = validate_dashboard_password(&first)?;
    let confirm = rpassword::prompt_password("Confirm dashboard password: ")?;
    if password != confirm.trim() {
        bail!("dashboard password confirmation did not match")
    }
    Ok(password)
}

fn device_info(config: &Config) -> DeviceInfo {
    DeviceInfo {
        id: config.device_id.clone(),
        name: config.device_name.clone(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: config::default_device_name(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

fn publish_dashboard_access(config: &Config, password: &str) -> Result<String> {
    let envelope = crypto::wrap_dashboard_key(&config.repo, &config.dashboard_key, password)?;
    let github = GithubClient::new(config.repo.clone(), config.github_token.clone())?;
    let branch = github
        .replace_dashboard_access(&envelope)
        .context("failed to publish the password-wrapped dashboard access manifest")?;
    github
        .refresh_dashboard_index()
        .context("failed to publish the dashboard device index")?;
    Ok(branch)
}

struct SyncLock {
    path: PathBuf,
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_sync_lock() -> Result<Option<SyncLock>> {
    let path = config::config_dir()?.join("sync.lock");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    for attempt in 0..2 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(Some(SyncLock { path })),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age > StdDuration::from_secs(15 * 60));
                if stale && attempt == 0 {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(None)
}

fn run_sync(full: bool, quiet: bool) -> Result<()> {
    let config = config::load()?;

    // Every normal scheduler run doubles as a lightweight update check. Stable
    // releases are checksum-verified and installed in place, so users configure
    // UsageMesh once and keep their existing sync cadence across upgrades.
    match update::maybe_auto_update(&config, full, quiet) {
        Ok(update::AutoUpdateOutcome::Restarted) => return Ok(()),
        Ok(update::AutoUpdateOutcome::Current) => {}
        Err(error) => {
            if !quiet {
                eprintln!("Auto-update check skipped: {error:#}");
            }
        }
    }

    // v2.1 standardizes near-real-time synchronization at 30 seconds. Existing
    // native schedulers are migrated once. --no-schedule devices remain manual.
    let mut config = config;
    let mut save_config = false;
    if config.interval_seconds != scheduler::SYNC_INTERVAL_SECONDS {
        config.interval_seconds = scheduler::SYNC_INTERVAL_SECONDS;
        save_config = true;
    }
    if scheduler::is_installed() && config.scheduler_revision < scheduler::revision() {
        match scheduler::install(config.interval_seconds) {
            Ok(description) => {
                config.scheduler_revision = scheduler::revision();
                save_config = true;
                if !quiet {
                    println!("Automatic sync cadence migrated: {description}");
                }
            }
            Err(error) => {
                if !quiet {
                    eprintln!("Could not migrate the existing scheduler to 30 seconds: {error:#}");
                }
            }
        }
    }
    if save_config {
        config::save(&config).context("failed to persist the 30-second sync cadence")?;
    }

    let _sync_lock = match acquire_sync_lock()? {
        Some(lock) => lock,
        None => {
            if !quiet {
                println!("Another UsageMesh sync is still running; skipping this tick.");
            }
            return Ok(());
        }
    };

    let previous = config::read_cached_ledger()?;
    let previous_for_compare = previous.clone();

    let (ledger, mode) = if full || previous.is_none() {
        (collector::collect(device_info(&config), None)?, "full")
    } else {
        let since = (Local::now().date_naive() - Duration::days(2))
            .format("%Y-%m-%d")
            .to_string();
        let partial = collector::collect(device_info(&config), Some(since.clone()))?;
        (
            collector::merge_incremental(previous.expect("checked above"), partial, &since),
            "incremental",
        )
    };

    config::write_cached_ledger(&ledger)?;
    let github = GithubClient::new(config.repo.clone(), config.github_token.clone())?;
    if full {
        github
            .sync_main_with_upstream()
            .context("failed to synchronize the UsageMesh fork with the current upstream main")?;
        if !quiet && !config.repo.eq_ignore_ascii_case(github::UPSTREAM_REPO) {
            println!(
                "Fork source synchronized with {} main.",
                github::UPSTREAM_REPO
            );
        }
    }
    if previous_for_compare
        .as_ref()
        .is_some_and(|previous| collector::same_accounting(previous, &ledger))
    {
        // A manual full sync is also the migration/repair path for the static
        // dashboard index. Refresh it even when accounting itself is unchanged.
        if full {
            github
                .refresh_dashboard_index()
                .context("failed to refresh the dashboard device index")?;
        }
        if !quiet {
            println!(
                "No usage changes on {}; GitHub snapshot unchanged.",
                config.device_name
            );
            println!("  Scan: {} ms", ledger.scan_ms);
        }
        return Ok(());
    }

    let envelope = crypto::encrypt_ledger(&ledger, &config.dashboard_key)?;
    let branch = github.replace_snapshot(&config.device_id, &envelope)?;
    github
        .refresh_dashboard_index()
        .context("failed to refresh the dashboard device index")?;
    if !quiet {
        println!("Synced {} ({mode})", config.device_name);
        println!("  Branch: {branch}");
        println!("  Rows: {}", ledger.rows.len());
        println!("  Tokens: {}", ledger.totals.total_tokens());
        println!(
            "  Subscription-equivalent cost: ${:.2}",
            ledger.totals.cost_usd
        );
        println!("  Pricing: {}", ledger.pricing.source);
        println!("  Scan: {} ms", ledger.scan_ms);
    }
    Ok(())
}

fn finish_onboarding(config: &Config, no_schedule: bool) -> Result<()> {
    println!("Collecting the first local snapshot...");
    run_sync(true, false)?;
    if !no_schedule {
        match scheduler::install(config.interval_seconds) {
            Ok(description) => {
                println!("Automatic sync: {description}");
                let mut persisted = config.clone();
                persisted.scheduler_revision = scheduler::revision();
                let _ = config::save(&persisted);
            }
            Err(error) => {
                eprintln!("Automatic timer could not be installed: {error}");
                eprintln!("You can still run `usagemesh sync` manually.");
            }
        }
    }
    println!();
    println!("Dashboard:");
    println!("{}", config::dashboard_url(config));
    println!("Open this same URL on any browser and enter your dashboard password.");
    println!();
    println!("Add another device with this single command:");
    println!("usagemesh join '{}'", config::join_code(config)?);
    println!();
    println!("No UsageMesh process stays resident between scheduled syncs.");
    Ok(())
}

fn setup(
    repo: Option<String>,
    token: Option<String>,
    device: Option<String>,
    dashboard_password: Option<String>,
    no_schedule: bool,
) -> Result<()> {
    let token = resolve_token(token)?;
    let repo = match repo {
        Some(repo) => config::normalize_repo(&repo)?,
        None => {
            println!("Finding or creating your UsageMesh fork on GitHub...");
            github::ensure_user_fork(&token)
                .context("could not automatically prepare your UsageMesh fork")?
        }
    };
    let config = config::new_config(&repo, token, device)?;
    GithubClient::new(config.repo.clone(), config.github_token.clone())?
        .validate()
        .context("cannot use the selected UsageMesh fork")?;
    let password = resolve_dashboard_password(dashboard_password)?;
    config::save(&config)?;
    let branch = publish_dashboard_access(&config, &password)?;
    println!("Workspace: {}", config.repo);
    println!("Dashboard access: {branch}/access.json (password itself is not stored)");
    finish_onboarding(&config, no_schedule)
}

fn join(
    code: String,
    token: Option<String>,
    device: Option<String>,
    no_schedule: bool,
) -> Result<()> {
    let token = resolve_token(token)?;
    let config = config::from_join(&code, token, device)?;
    GithubClient::new(config.repo.clone(), config.github_token.clone())?
        .validate()
        .context("cannot access the UsageMesh fork encoded in this pair code")?;
    config::save(&config)?;
    println!("Joined workspace: {}", config.repo);
    println!("Use the same dashboard password configured on the first device.");
    finish_onboarding(&config, no_schedule)
}

fn set_dashboard_password(explicit: Option<String>) -> Result<()> {
    let config = config::load()?;
    let password = resolve_dashboard_password(explicit)?;
    let branch = publish_dashboard_access(&config, &password)?;
    println!("Dashboard password updated.");
    println!("  Access manifest: {branch}/access.json");
    println!("  Password stored on GitHub: no");
    println!("  Dashboard: {}", config::dashboard_url(&config));
    Ok(())
}

fn status() -> Result<()> {
    let config = config::load()?;
    println!("UsageMesh {}", env!("CARGO_PKG_VERSION"));
    println!(
        "Device: {} ({}/{})",
        config.device_name,
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Workspace fork: {}", config.repo);
    println!(
        "Snapshot branch: {}",
        GithubClient::snapshot_branch(&config.device_id)
    );
    println!("Sync interval: {} seconds", config.interval_seconds);
    if let Some(ledger) = config::read_cached_ledger()? {
        println!("Last scan: {}", ledger.generated_at);
        println!("Tokens: {}", ledger.totals.total_tokens());
        println!(
            "Subscription-equivalent cost: ${:.2}",
            ledger.totals.cost_usd
        );
        if !ledger.pricing.source.is_empty() {
            println!("Pricing: {}", ledger.pricing.source);
        }
        println!("Rows: {}", ledger.rows.len());
        println!("Scan work: {} ms wall time", ledger.scan_ms);
    } else {
        println!("Last scan: never");
    }
    println!("Dashboard: {}", config::dashboard_url(&config));
    Ok(())
}

fn uninstall(remove_remote: bool, purge: bool) -> Result<()> {
    let config = config::load().ok();
    scheduler::uninstall()?;
    if remove_remote {
        if let Some(ref config) = config {
            GithubClient::new(config.repo.clone(), config.github_token.clone())?
                .remove_snapshot_branch(&config.device_id)?;
        }
    }
    if purge {
        if let Ok(dir) = config::config_dir() {
            let _ = fs::remove_dir_all(dir);
        }
    }
    println!(
        "Automatic sync removed{}.",
        if purge {
            " and local configuration purged"
        } else {
            ""
        }
    );
    Ok(())
}

fn real_main() -> Result<()> {
    match Cli::parse().command {
        CommandKind::Setup {
            repo,
            token,
            device,
            dashboard_password,
            no_schedule,
        } => setup(repo, token, device, dashboard_password, no_schedule),
        CommandKind::Join {
            code,
            token,
            device,
            no_schedule,
        } => join(code, token, device, no_schedule),
        CommandKind::Password { password } => set_dashboard_password(password),
        CommandKind::Sync { full, quiet } => run_sync(full, quiet),
        CommandKind::Status => status(),
        CommandKind::Clients => {
            for client in collector::supported_clients() {
                println!("{client}");
            }
            Ok(())
        }
        CommandKind::Invite => {
            let config = config::load()?;
            println!("usagemesh join '{}'", config::join_code(&config)?);
            Ok(())
        }
        CommandKind::Dashboard => {
            println!("{}", config::dashboard_url(&config::load()?));
            Ok(())
        }
        CommandKind::Uninstall {
            remove_remote,
            purge,
        } => uninstall(remove_remote, purge),
    }
}

fn main() {
    if let Err(error) = real_main() {
        eprintln!("Error: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_dashboard_password_is_rejected() {
        assert!(validate_dashboard_password("1234567").is_err());
        assert!(validate_dashboard_password("12345678").is_ok());
    }
}
