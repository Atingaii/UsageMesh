use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::github::{GithubClient, UPSTREAM_REPO};

const API_VERSION: &str = "2022-11-28";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoUpdateOutcome {
    Current,
    Restarted,
}

#[derive(Debug, Deserialize)]
struct ReleaseInfo {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

fn disabled() -> bool {
    std::env::var("USAGEMESH_AUTO_UPDATE")
        .ok()
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(false)
}

fn parse_version(value: &str) -> Option<Vec<u64>> {
    let raw = value.trim().trim_start_matches('v');
    if raw.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for part in raw.split('.') {
        let digits = part.chars().take_while(|ch| ch.is_ascii_digit()).collect::<String>();
        if digits.is_empty() {
            return None;
        }
        out.push(digits.parse().ok()?);
    }
    while out.len() < 3 {
        out.push(0);
    }
    Some(out)
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(mut latest), Some(mut current)) => {
            let width = latest.len().max(current.len());
            latest.resize(width, 0);
            current.resize(width, 0);
            latest > current
        }
        _ => false,
    }
}

fn http_client() -> Result<Client> {
    Ok(Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?)
}

fn latest_stable_release(client: &Client, token: &str) -> Result<ReleaseInfo> {
    let url = format!("https://api.github.com/repos/{UPSTREAM_REPO}/releases/latest");
    let mut request = client
        .get(&url)
        .header(USER_AGENT, "usagemesh-auto-update")
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION);
    if !token.trim().is_empty() {
        request = request.header(AUTHORIZATION, format!("Bearer {}", token.trim()));
    }
    let response = request.send().context("failed to check the latest UsageMesh release")?;
    if !response.status().is_success() {
        bail!("latest release check returned HTTP {}", response.status());
    }
    let release: ReleaseInfo = response.json().context("invalid latest release metadata")?;
    if release.draft || release.prerelease {
        bail!("GitHub returned a non-stable release as latest");
    }
    Ok(release)
}

fn platform_asset() -> Result<(&'static str, &'static str)> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => bail!("automatic update is not supported on architecture {other}"),
    };
    match std::env::consts::OS {
        "linux" => Ok((if arch == "x86_64" { "usagemesh-linux-x86_64" } else { "usagemesh-linux-aarch64" }, "tar.gz")),
        "macos" => Ok((if arch == "x86_64" { "usagemesh-macos-x86_64" } else { "usagemesh-macos-aarch64" }, "tar.gz")),
        "windows" => Ok((if arch == "x86_64" { "usagemesh-windows-x86_64" } else { "usagemesh-windows-aarch64" }, "zip")),
        other => bail!("automatic update is not supported on {other}"),
    }
}

fn download(client: &Client, url: &str, path: &Path) -> Result<()> {
    let response = client
        .get(url)
        .header(USER_AGENT, "usagemesh-auto-update")
        .send()
        .with_context(|| format!("failed to download {url}"))?;
    if !response.status().is_success() {
        bail!("download returned HTTP {} for {url}", response.status());
    }
    let bytes = response.bytes()?;
    fs::write(path, &bytes)?;
    Ok(())
}

fn verify_checksum(archive: &Path, checksum: &Path) -> Result<()> {
    let expected_text = fs::read_to_string(checksum).context("cannot read update checksum")?;
    let expected = expected_text
        .split_whitespace()
        .next()
        .context("update checksum file is empty")?
        .trim()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
        bail!("update checksum has an invalid SHA-256 value");
    }
    let bytes = fs::read(archive).context("cannot read downloaded update archive")?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        bail!("UsageMesh update SHA-256 mismatch");
    }
    Ok(())
}

fn extract_archive(archive: &Path, destination: &Path) -> Result<PathBuf> {
    fs::create_dir_all(destination)?;
    #[cfg(windows)]
    {
        let command = format!(
            "Expand-Archive -Force -LiteralPath {} -DestinationPath {}",
            ps_quote(archive),
            ps_quote(destination)
        );
        let status = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &command])
            .status()
            .context("failed to start PowerShell for update extraction")?;
        if !status.success() {
            bail!("PowerShell failed to extract the UsageMesh update");
        }
        return Ok(destination.join("usagemesh.exe"));
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(destination)
            .status()
            .context("failed to start tar for update extraction")?;
        if !status.success() {
            bail!("tar failed to extract the UsageMesh update");
        }
        Ok(destination.join("usagemesh"))
    }
}

fn verify_staged_binary(binary: &Path, expected_version: &str) -> Result<()> {
    if !binary.is_file() {
        bail!("update archive did not contain the UsageMesh binary");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(binary, fs::Permissions::from_mode(0o755))?;
    }
    let output = Command::new(binary)
        .arg("--version")
        .output()
        .context("downloaded UsageMesh update could not be executed")?;
    if !output.status.success() {
        bail!("downloaded UsageMesh update failed its version check");
    }
    let reported = String::from_utf8_lossy(&output.stdout);
    if !reported.contains(expected_version.trim_start_matches('v')) {
        bail!("downloaded UsageMesh update reports an unexpected version");
    }
    Ok(())
}

fn sync_args(full: bool, quiet: bool) -> Vec<&'static str> {
    let mut args = vec!["sync"];
    if full {
        args.push("--full");
    }
    if quiet {
        args.push("--quiet");
    }
    args
}

#[cfg(windows)]
fn ps_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

#[cfg(windows)]
fn replace_and_restart(staged: &Path, current: &Path, full: bool, quiet: bool) -> Result<()> {
    let parent = std::process::id();
    let adjacent = current.with_extension("update.exe");
    let _ = fs::remove_file(&adjacent);
    fs::copy(staged, &adjacent).context("cannot stage the UsageMesh update beside the current executable")?;

    let mut command = format!(
        "$parentPid={parent}; while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 200 }}; Move-Item -Force -LiteralPath {} -Destination {}; & {} sync",
        ps_quote(&adjacent),
        ps_quote(current),
        ps_quote(current)
    );
    if full {
        command.push_str(" --full");
    }
    if quiet {
        command.push_str(" --quiet");
    }

    Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", &command])
        .stdin(Stdio::null())
        .stdout(if quiet { Stdio::null() } else { Stdio::inherit() })
        .stderr(if quiet { Stdio::null() } else { Stdio::inherit() })
        .spawn()
        .context("failed to schedule the Windows UsageMesh self-update")?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_and_restart(staged: &Path, current: &Path, full: bool, quiet: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let adjacent = current.with_file_name(format!(".usagemesh-update-{}", std::process::id()));
    let _ = fs::remove_file(&adjacent);
    fs::copy(staged, &adjacent).context("cannot stage the UsageMesh update beside the current executable")?;
    fs::set_permissions(&adjacent, fs::Permissions::from_mode(0o755))?;
    fs::rename(&adjacent, current).context("cannot atomically replace the UsageMesh executable")?;

    let status = Command::new(current)
        .args(sync_args(full, quiet))
        .status()
        .context("failed to restart UsageMesh after updating")?;
    if !status.success() {
        bail!("updated UsageMesh failed while resuming synchronization");
    }
    Ok(())
}

pub fn maybe_auto_update(config: &Config, full: bool, quiet: bool) -> Result<AutoUpdateOutcome> {
    if disabled() {
        return Ok(AutoUpdateOutcome::Current);
    }

    let client = http_client()?;
    let release = latest_stable_release(&client, &config.github_token)?;
    let current = env!("CARGO_PKG_VERSION");
    let latest = release.tag_name.trim_start_matches('v');
    if !is_newer(latest, current) {
        return Ok(AutoUpdateOutcome::Current);
    }

    // A release is also the synchronization point for fork-owned source/workflows.
    // This keeps the user's Pages workflow current before the new binary resumes.
    GithubClient::new(config.repo.clone(), config.github_token.clone())?
        .sync_main_with_upstream()
        .context("failed to synchronize the workspace fork before auto-update")?;

    let (stem, extension) = platform_asset()?;
    let archive_name = format!("{stem}.{extension}");
    let checksum_name = format!("{stem}.sha256");
    let base = format!(
        "https://github.com/{UPSTREAM_REPO}/releases/download/{}/",
        release.tag_name
    );

    let update_dir = crate::config::config_dir()?
        .join("updates")
        .join(format!("{}-{}", latest, std::process::id()));
    let _ = fs::remove_dir_all(&update_dir);
    fs::create_dir_all(&update_dir)?;
    let archive = update_dir.join(&archive_name);
    let checksum = update_dir.join(&checksum_name);
    download(&client, &format!("{base}{archive_name}"), &archive)?;
    download(&client, &format!("{base}{checksum_name}"), &checksum)?;
    verify_checksum(&archive, &checksum)?;

    let extracted = update_dir.join("extracted");
    let staged = extract_archive(&archive, &extracted)?;
    verify_staged_binary(&staged, latest)?;

    if !quiet {
        println!("UsageMesh update available: {current} -> {latest}");
        println!("Verified SHA-256; installing the stable GitHub Release now...");
    }

    let current_exe = std::env::current_exe().context("cannot locate the running UsageMesh executable")?;
    replace_and_restart(&staged, &current_exe, full, quiet)?;
    let _ = fs::remove_dir_all(&update_dir);
    Ok(AutoUpdateOutcome::Restarted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions() {
        assert!(is_newer("2.0.2", "2.0.1"));
        assert!(is_newer("v2.1.0", "2.0.9"));
        assert!(!is_newer("2.0.1", "2.0.1"));
        assert!(!is_newer("1.9.9", "2.0.0"));
        assert!(is_newer("2.0.10", "2.0.9"));
    }
}
