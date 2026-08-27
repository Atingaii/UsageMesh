use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::crypto::generate_key;
use crate::model::CURRENT_LEDGER_SCHEMA_VERSION;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub repo: String,
    pub github_token: String,
    pub dashboard_key: String,
    pub device_id: String,
    pub device_name: String,
    pub interval_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinCode {
    version: u32,
    repo: String,
    dashboard_key: String,
    interval_minutes: u32,
}

pub fn config_dir() -> Result<PathBuf> {
    dirs::config_dir()
        .map(|path| path.join("usagemesh"))
        .context("cannot determine the user configuration directory")
}
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.json"))
}
pub fn ledger_cache_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("ledger-cache.json"))
}

pub fn normalize_repo(value: &str) -> Result<String> {
    let raw = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let repo = raw
        .strip_prefix("https://github.com/")
        .unwrap_or(raw)
        .to_string();
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.trim().is_empty()) {
        bail!("repository must be OWNER/REPO or a github.com repository URL");
    }
    Ok(repo)
}

pub fn default_device_name() -> String {
    hostname::get()
        .ok()
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{}-device", std::env::consts::OS))
}

pub fn sanitize_device_id(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "device".to_string()
    } else {
        trimmed.to_string()
    }
}

fn unique_device_id(name: &str) -> String {
    let mut bytes = [0u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("{}-{}", sanitize_device_id(name), hex::encode(bytes))
}

pub fn new_config(
    repo: &str,
    token: String,
    device_name: Option<String>,
    interval_minutes: u32,
) -> Result<Config> {
    let name = device_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(default_device_name);
    Ok(Config {
        version: 2,
        repo: normalize_repo(repo)?,
        github_token: token,
        dashboard_key: generate_key(),
        device_id: unique_device_id(&name),
        device_name: name,
        interval_minutes: interval_minutes.clamp(5, 1440),
    })
}

pub fn from_join(code: &str, token: String, device_name: Option<String>) -> Result<Config> {
    let bytes = URL_SAFE_NO_PAD
        .decode(code.trim())
        .context("invalid join code")?;
    let join: JoinCode = serde_json::from_slice(&bytes).context("invalid join code payload")?;
    if join.version != 2 {
        bail!("unsupported join-code version {}", join.version);
    }
    crate::crypto::decode_key(&join.dashboard_key)?;
    let name = device_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(default_device_name);
    Ok(Config {
        version: 2,
        repo: normalize_repo(&join.repo)?,
        github_token: token,
        dashboard_key: join.dashboard_key,
        device_id: unique_device_id(&name),
        device_name: name,
        interval_minutes: join.interval_minutes.clamp(5, 1440),
    })
}

pub fn join_code(config: &Config) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&JoinCode {
        version: 2,
        repo: config.repo.clone(),
        dashboard_key: config.dashboard_key.clone(),
        interval_minutes: config.interval_minutes,
    })?))
}

/// Stable, shareable URL. The random encryption key is never placed in the URL.
/// The project's own production workspace gets the shortest possible URL;
/// other forks keep an explicit repo query parameter so the same dashboard can
/// still serve them without a second deployment.
pub fn dashboard_url(config: &Config) -> String {
    let mut parts = config.repo.splitn(2, '/');
    let owner = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    let repo = parts.next().unwrap_or_default().trim();
    if owner.is_empty() || repo.is_empty() {
        return String::new();
    }
    format!("https://{owner}.github.io/{repo}/")
}

pub fn load() -> Result<Config> {
    let path = config_path()?;
    let data = fs::read(&path).with_context(|| {
        format!(
            "configuration not found at {}. Run `usagemesh setup` first",
            path.display()
        )
    })?;
    let config: Config =
        serde_json::from_slice(&data).context("invalid usagemesh configuration")?;
    if config.version != 2 {
        bail!("unsupported config version {}", config.version);
    }
    crate::crypto::decode_key(&config.dashboard_key)?;
    Ok(config)
}

pub fn save(config: &Config) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_private(&path, &serde_json::to_vec_pretty(config)?)
}

pub fn read_cached_ledger() -> Result<Option<crate::model::Ledger>> {
    let path = ledger_cache_path()?;
    match fs::read(&path) {
        Ok(data) => {
            let ledger: crate::model::Ledger =
                serde_json::from_slice(&data).context("invalid local ledger cache")?;
            if ledger.schema_version < CURRENT_LEDGER_SCHEMA_VERSION {
                return Ok(None);
            }
            Ok(Some(ledger))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn write_cached_ledger(ledger: &crate::model::Ledger) -> Result<()> {
    let path = ledger_cache_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_private(&path, &serde_json::to_vec(ledger)?)
}

fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tmp, data)?;
    }
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_code_roundtrip_shape() {
        let config = new_config("owner/repo", "t".into(), Some("My PC".into()), 15).unwrap();
        let code = join_code(&config).unwrap();
        let other = from_join(&code, "x".into(), Some("Other".into())).unwrap();
        assert_eq!(other.repo, "owner/repo");
        assert_eq!(other.dashboard_key, config.dashboard_key);
        assert_ne!(other.device_id, config.device_id);
    }

    #[test]
    fn dashboard_url_never_exposes_workspace_key() {
        let config = new_config("owner/repo", "t".into(), Some("x".into()), 15).unwrap();
        let url = dashboard_url(&config);
        assert_eq!(url, "https://owner.github.io/repo/");
        assert!(!url.contains(&config.dashboard_key));
        assert!(!url.contains("#key="));
    }

    #[test]
    fn primary_workspace_uses_short_dashboard_url() {
        let config = new_config("Atingaii/UsageMesh", "t".into(), Some("x".into()), 15).unwrap();
        assert_eq!(
            dashboard_url(&config),
            "https://atingaii.github.io/UsageMesh/"
        );
    }

    #[test]
    fn same_name_devices_do_not_collide() {
        let first = new_config("owner/repo", "t".into(), Some("server".into()), 15).unwrap();
        let second = new_config("owner/repo", "t".into(), Some("server".into()), 15).unwrap();
        assert_ne!(first.device_id, second.device_id);
        assert!(first.device_id.starts_with("server-"));
    }
}
