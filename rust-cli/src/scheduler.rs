use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

pub const SYNC_INTERVAL_SECONDS: u32 = 30;
const SCHEDULER_REVISION: u32 = 5;

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
            .map(|dir| {
                dir.join("usagemesh.service").is_file() || dir.join("usagemesh.timer").is_file()
            })
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
                let text = String::from_utf8_lossy(&output.stdout);
                text.contains("# usagemesh-resident-agent")
                    || text.contains("# usagemesh-usage-sync")
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_runner_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("resident-agent.sh"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_pid_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("resident-agent.pid"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_unix_runner() -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let exe = executable()?;
    let runner = unix_runner_path()?;
    let pid = unix_pid_path()?;
    if let Some(parent) = runner.parent() {
        fs::create_dir_all(parent)?;
    }
    let script = format!(
        r#"#!/bin/sh
set -u
PID_FILE={pid}
USAGEMESH_BIN={exe}

run_loop() {{
  printf '%s\n' "$$" > "$PID_FILE"
  trap 'rm -f "$PID_FILE"; exit 0' INT TERM EXIT
  while :; do
    "$USAGEMESH_BIN" sync --quiet || true
    sleep {interval} &
    wait $! || true
  done
}}

ensure_loop() {{
  if [ -f "$PID_FILE" ]; then
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      exit 0
    fi
    rm -f "$PID_FILE"
  fi
  nohup "$0" --run >/dev/null 2>&1 &
}}

case "${{1:-}}" in
  --ensure) ensure_loop ;;
  *) run_loop ;;
esac
"#,
        pid = shell_single_quote(&pid.to_string_lossy()),
        exe = shell_single_quote(&exe.to_string_lossy()),
        interval = SYNC_INTERVAL_SECONDS,
    );
    fs::write(&runner, script)?;
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o700))?;
    Ok(runner)
}

#[cfg(target_os = "windows")]
fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn windows_runner_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("resident-agent.ps1"))
}

#[cfg(target_os = "windows")]
fn install_windows() -> Result<String> {
    let exe = executable()?;
    let runner = windows_runner_path()?;
    if let Some(parent) = runner.parent() {
        fs::create_dir_all(parent)?;
    }
    let script = format!(
        "$ErrorActionPreference='Continue'\r\nwhile ($true) {{\r\n  try {{ & '{}' sync --quiet }} catch {{ }}\r\n  Start-Sleep -Seconds {}\r\n}}\r\n",
        ps_quote(&exe.to_string_lossy()),
        SYNC_INTERVAL_SECONDS,
    );
    fs::write(&runner, script)?;
    let action = format!(
        "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"",
        runner.display()
    );
    let mut cmd = Command::new("schtasks.exe");
    cmd.args([
        "/Create",
        "/F",
        "/SC",
        "ONLOGON",
        "/TN",
        TASK_NAME,
        "/TR",
        &action,
    ]);
    run_ok(cmd, "Windows resident Task Scheduler registration")?;
    let _ = Command::new("schtasks.exe")
        .args(["/Run", "/TN", TASK_NAME])
        .output();
    Ok("Windows resident sync agent (starts at sign-in, 30-second incremental loop)".to_string())
}

#[cfg(target_os = "windows")]
fn uninstall_windows() -> Result<()> {
    let _ = Command::new("schtasks.exe")
        .args(["/End", "/TN", TASK_NAME])
        .output();
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
const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

#[cfg(target_os = "macos")]
fn proxy_environment() -> Vec<(String, String)> {
    PROXY_ENV_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| ((*key).to_string(), value))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn environment_variables_xml(values: &[(String, String)]) -> String {
    if values.is_empty() {
        return String::new();
    }
    let entries = values
        .iter()
        .map(|(key, value)| {
            format!(
                "<key>{}</key><string>{}</string>",
                xml_escape(key),
                xml_escape(value)
            )
        })
        .collect::<String>();
    format!("<key>EnvironmentVariables</key><dict>{entries}</dict>\n")
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
    let runner = write_unix_runner()?;
    let path = launch_agent_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let environment = environment_variables_xml(&proxy_environment());
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.atingaii.usagemesh</string>
<key>ProgramArguments</key><array><string>{}</string><string>--run</string></array>
{}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
</dict></plist>
"#,
        xml_escape(&runner.to_string_lossy()),
        environment
    );
    fs::write(&path, plist)?;
    let domain = format!("gui/{}", mac_uid()?);
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, path.to_string_lossy().as_ref()])
        .output();
    let mut bootstrap = Command::new("launchctl");
    bootstrap.args(["bootstrap", &domain, path.to_string_lossy().as_ref()]);
    run_ok(bootstrap, "macOS launchd resident-agent registration")?;
    Ok("macOS launchd resident sync agent (RunAtLoad + KeepAlive, 30-second incremental loop)".to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::environment_variables_xml;

    #[test]
    fn launch_agent_proxy_environment_is_escaped() {
        let values = vec![
            (
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:10808".to_string(),
            ),
            ("NO_PROXY".to_string(), "localhost&internal".to_string()),
        ];
        let xml = environment_variables_xml(&values);
        assert!(xml.contains("<key>EnvironmentVariables</key><dict>"));
        assert!(xml.contains("<key>HTTPS_PROXY</key><string>http://127.0.0.1:10808</string>"));
        assert!(xml.contains("<key>NO_PROXY</key><string>localhost&amp;internal</string>"));
    }
}

#[cfg(target_os = "macos")]
fn uninstall_macos() -> Result<()> {
    let path = launch_agent_path()?;
    let domain = format!("gui/{}", mac_uid()?);
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, path.to_string_lossy().as_ref()])
        .output();
    let _ = fs::remove_file(path);
    if let Ok(path) = unix_runner_path() {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = unix_pid_path() {
        let _ = fs::remove_file(path);
    }
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
fn try_enable_linger() {
    let Ok(output) = Command::new("id").arg("-un").output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let user = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if user.is_empty() {
        return;
    }
    let _ = Command::new("loginctl")
        .args(["enable-linger", &user])
        .output();
}

#[cfg(target_os = "linux")]
fn try_install_systemd() -> Result<String> {
    let runner = write_unix_runner()?;
    let dir = systemd_dir()?;
    fs::create_dir_all(&dir)?;

    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "usagemesh.timer"])
        .output();
    let _ = fs::remove_file(dir.join("usagemesh.timer"));

    let service = format!(
        "[Unit]\nDescription=UsageMesh resident sync agent\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={} --run\nRestart=always\nRestartSec=5s\nNice=10\nIOSchedulingClass=idle\n\n[Install]\nWantedBy=default.target\n",
        systemd_exec_path(&runner)
    );
    fs::write(dir.join("usagemesh.service"), service)?;

    let mut reload = Command::new("systemctl");
    reload.args(["--user", "daemon-reload"]);
    run_ok(reload, "systemd user daemon reload")?;

    try_enable_linger();

    let mut enable = Command::new("systemctl");
    enable.args(["--user", "enable", "--now", "usagemesh.service"]);
    run_ok(enable, "systemd resident-agent registration")?;
    Ok("systemd --user resident sync agent (Restart=always, 30-second incremental loop)".to_string())
}

#[cfg(target_os = "linux")]
fn install_cron() -> Result<String> {
    if Command::new("crontab").arg("-l").output().is_err() {
        bail!("neither a usable systemd --user session nor crontab is available; run usagemesh sync manually")
    }
    let runner = write_unix_runner()?;
    let existing = Command::new("crontab")
        .arg("-l")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| {
            !line.contains("# usagemesh-resident-agent")
                && !line.contains("# usagemesh-usage-sync")
        })
        .map(str::to_string)
        .collect();
    let quoted = shell_single_quote(&runner.to_string_lossy());
    lines.push(format!(
        "@reboot {quoted} --ensure # usagemesh-resident-agent"
    ));
    lines.push(format!(
        "* * * * * {quoted} --ensure # usagemesh-resident-agent"
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
    let _ = Command::new(&runner).arg("--ensure").output();
    Ok("cron-supervised resident sync agent (boot start + one-minute watchdog)".to_string())
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
                return install_cron().with_context(|| {
                    format!(
                        "systemd resident agent unavailable ({systemd_error}); cron fallback also failed"
                    )
                });
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
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "usagemesh.service"])
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
            .filter(|line| {
                !line.contains("# usagemesh-resident-agent")
                    && !line.contains("# usagemesh-usage-sync")
            })
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
    if let Ok(path) = unix_runner_path() {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = unix_pid_path() {
        if let Ok(pid) = fs::read_to_string(&path) {
            let pid = pid.trim().to_string();
            if !pid.is_empty() {
                let _ = Command::new("kill").arg(&pid).output();
            }
        }
        let _ = fs::remove_file(path);
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

    #[test]
    fn resident_scheduler_revision_is_newer_than_tick_scheduler() {
        assert!(revision() >= 5);
    }
}
