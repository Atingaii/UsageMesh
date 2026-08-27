use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

pub const SYNC_INTERVAL_SECONDS: u32 = 30;
const SCHEDULER_REVISION: u32 = 3;

#[cfg(target_os = "windows")]
const TASK_NAME: &str = "UsageMeshUsageSync";

fn executable() -> Result<PathBuf> {
    std::env::current_exe().context("cannot locate usagemesh executable")
}

pub const fn revision() -> u32 {
    SCHEDULER_REVISION
}

pub fn install(_interval_seconds: u32) -> Result<String> {
    #[cfg(target_os = "windows")]
    {
        return install_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return install_macos();
    }
    #[cfg(target_os = "linux")]
    {
        return install_linux();
    }
    #[allow(unreachable_code)]
    bail!("automatic scheduling is not supported on this platform")
}

pub fn uninstall() -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        return uninstall_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return uninstall_macos();
    }
    #[cfg(target_os = "linux")]
    {
        return uninstall_linux();
    }
    #[allow(unreachable_code)]
    Ok(())
}

pub fn is_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("schtasks.exe")
            .args(["/Query", "/TN", TASK_NAME])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
    }
    #[cfg(target_os = "macos")]
    {
        return launch_agent_path()
            .map(|path| path.is_file())
            .unwrap_or(false);
    }
    #[cfg(target_os = "linux")]
    {
        if systemd_dir()
            .map(|dir| dir.join("usagemesh.timer").is_file())
            .unwrap_or(false)
        {
            return true;
        }
        return Command::new("crontab")
            .arg("-l")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout).contains("# usagemesh-usage-sync")
            })
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

fn run_ok(mut command: Command, description: &str) -> Result<()> {
    let output = command
        .output()
        .with_context(|| format!("failed to run {description}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    bail!("{description} failed: {detail}")
}

#[cfg(target_os = "windows")]
fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn windows_runner_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("sync-30s.ps1"))
}

#[cfg(target_os = "windows")]
fn install_windows() -> Result<String> {
    let exe = executable()?;
    let runner = windows_runner_path()?;
    if let Some(parent) = runner.parent() {
        fs::create_dir_all(parent)?;
    }
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'\r\n& '{}' sync --quiet\r\nStart-Sleep -Seconds 30\r\n& '{}' sync --quiet\r\n",
        ps_quote(&exe.to_string_lossy()), ps_quote(&exe.to_string_lossy())
    );
    fs::write(&runner, script)?;
    let action = format!(
        "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"",
        runner.display()
    );
    let mut cmd = Command::new("schtasks.exe");
    cmd.args([
        "/Create", "/F", "/SC", "MINUTE", "/MO", "1", "/TN", TASK_NAME, "/TR", &action,
    ]);
    run_ok(cmd, "Windows Task Scheduler registration")?;
    let _ = Command::new("schtasks.exe")
        .args(["/Run", "/TN", TASK_NAME])
        .output();
    Ok("Windows Task Scheduler every 30 seconds (two guarded syncs per minute)".to_string())
}

#[cfg(target_os = "windows")]
fn uninstall_windows() -> Result<()> {
    let _ = Command::new("schtasks.exe")
        .args(["/Delete", "/F", "/TN", TASK_NAME])
        .output();
    if let Ok(path) = windows_runner_path() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("cannot determine home directory")?
        .join("Library/LaunchAgents/io.atingaii.usagemesh.plist"))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn mac_uid() -> Result<String> {
    let output = Command::new("id").arg("-u").output()?;
    if !output.status.success() {
        bail!("cannot determine macOS uid");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn install_macos() -> Result<String> {
    let exe = executable()?;
    let path = launch_agent_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.atingaii.usagemesh</string>
<key>ProgramArguments</key><array><string>{}</string><string>sync</string><string>--quiet</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
</dict></plist>
"#,
        xml_escape(&exe.to_string_lossy())
    );
    fs::write(&path, plist)?;
    let domain = format!("gui/{}", mac_uid()?);
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, path.to_string_lossy().as_ref()])
        .output();
    let mut bootstrap = Command::new("launchctl");
    bootstrap.args(["bootstrap", &domain, path.to_string_lossy().as_ref()]);
    run_ok(bootstrap, "macOS launchd registration")?;
    Ok("macOS launchd every 30 seconds".to_string())
}

#[cfg(target_os = "macos")]
fn uninstall_macos() -> Result<()> {
    let path = launch_agent_path()?;
    let domain = format!("gui/{}", mac_uid()?);
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, path.to_string_lossy().as_ref()])
        .output();
    let _ = fs::remove_file(path);
    Ok(())
}

#[cfg(target_os = "linux")]
fn systemd_dir() -> Result<PathBuf> {
    Ok(dirs::config_dir()
        .context("cannot determine config directory")?
        .join("systemd/user"))
}

#[cfg(target_os = "linux")]
fn systemd_exec_path(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "linux")]
fn try_install_systemd() -> Result<String> {
    let exe = executable()?;
    let dir = systemd_dir()?;
    fs::create_dir_all(&dir)?;
    let service = format!(
        "[Unit]\nDescription=UsageMesh usage snapshot\n\n[Service]\nType=oneshot\nExecStart={} sync --quiet\nNice=10\nIOSchedulingClass=idle\n",
        systemd_exec_path(&exe)
    );
    let timer = "[Unit]\nDescription=Near-real-time UsageMesh usage snapshot\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=30s\nAccuracySec=1s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n";
    fs::write(dir.join("usagemesh.service"), service)?;
    fs::write(dir.join("usagemesh.timer"), timer)?;
    let mut reload = Command::new("systemctl");
    reload.args(["--user", "daemon-reload"]);
    run_ok(reload, "systemd user daemon reload")?;
    let mut enable = Command::new("systemctl");
    enable.args(["--user", "enable", "--now", "usagemesh.timer"]);
    run_ok(enable, "systemd user timer registration")?;
    Ok("systemd user timer every 30 seconds".to_string())
}

#[cfg(target_os = "linux")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "linux")]
fn install_cron() -> Result<String> {
    if Command::new("crontab").arg("-l").output().is_err() {
        bail!("neither a usable systemd --user session nor crontab is available; run usagemesh sync manually")
    }
    let exe = executable()?;
    let existing = Command::new("crontab")
        .arg("-l")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();
    let marker = "# usagemesh-usage-sync";
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| !line.contains(marker))
        .map(str::to_string)
        .collect();
    let quoted = shell_single_quote(&exe.to_string_lossy());
    lines.push(format!("* * * * * {quoted} sync --quiet {marker}:00"));
    lines.push(format!(
        "* * * * * sleep 30; {quoted} sync --quiet {marker}:30"
    ));
    let mut child = Command::new("crontab")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .context("failed to start crontab")?;
    use std::io::Write;
    child
        .stdin
        .as_mut()
        .context("crontab stdin unavailable")?
        .write_all(format!("{}\n", lines.join("\n")).as_bytes())?;
    if !child.wait()?.success() {
        bail!("crontab registration failed");
    }
    Ok("cron every 30 seconds (two guarded entries per minute)".to_string())
}

#[cfg(target_os = "linux")]
fn install_linux() -> Result<String> {
    if Command::new("systemctl").arg("--version").output().is_ok() {
        match try_install_systemd() {
            Ok(description) => return Ok(description),
            Err(systemd_error) => {
                if let Ok(dir) = systemd_dir() {
                    let _ = fs::remove_file(dir.join("usagemesh.timer"));
                    let _ = fs::remove_file(dir.join("usagemesh.service"));
                }
                return install_cron().with_context(|| format!("systemd user timer unavailable ({systemd_error}); cron fallback also failed"));
            }
        }
    }
    install_cron()
}

#[cfg(target_os = "linux")]
fn uninstall_linux() -> Result<()> {
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "usagemesh.timer"])
        .output();
    if let Ok(dir) = systemd_dir() {
        let _ = fs::remove_file(dir.join("usagemesh.timer"));
        let _ = fs::remove_file(dir.join("usagemesh.service"));
    }
    let existing = Command::new("crontab")
        .arg("-l")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();
    if !existing.is_empty() {
        let cleaned = existing
            .lines()
            .filter(|line| !line.contains("# usagemesh-usage-sync"))
            .collect::<Vec<_>>()
            .join("\n");
        if let Ok(mut child) = Command::new("crontab")
            .arg("-")
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(format!("{cleaned}\n").as_bytes());
            }
            let _ = child.wait();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cadence_is_thirty_seconds() {
        assert_eq!(SYNC_INTERVAL_SECONDS, 30);
    }
}
