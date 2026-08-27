use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

#[cfg(target_os = "windows")]
const TASK_NAME: &str = "UsageMeshUsageSync";

fn executable() -> Result<PathBuf> {
    std::env::current_exe().context("cannot locate usagemesh executable")
}

pub fn install(interval_minutes: u32) -> Result<String> {
    #[cfg(target_os = "windows")]
    {
        return install_windows(interval_minutes);
    }
    #[cfg(target_os = "macos")]
    {
        return install_macos(interval_minutes);
    }
    #[cfg(target_os = "linux")]
    {
        return install_linux(interval_minutes);
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
fn windows_task_action(exe: &Path) -> String {
    // `/TR` is one argument to schtasks. Quote the executable itself so installs
    // under a username/path containing spaces remain valid.
    format!("\"{}\" sync --quiet", exe.display())
}

#[cfg(target_os = "windows")]
fn install_windows(interval_minutes: u32) -> Result<String> {
    let exe = executable()?;
    let task = windows_task_action(&exe);
    let interval = interval_minutes.clamp(5, 1440).to_string();
    let mut cmd = Command::new("schtasks.exe");
    cmd.args([
        "/Create", "/F", "/SC", "MINUTE", "/MO", &interval, "/TN", TASK_NAME, "/TR", &task,
    ]);
    run_ok(cmd, "Windows Task Scheduler registration")?;

    // Trigger once after registration. This is best-effort because Windows can
    // transiently report the task as not ready immediately after creation.
    let mut run = Command::new("schtasks.exe");
    run.args(["/Run", "/TN", TASK_NAME]);
    let _ = run.output();
    Ok(format!(
        "Windows Task Scheduler every {} minutes",
        interval_minutes.clamp(5, 1440)
    ))
}

#[cfg(target_os = "windows")]
fn uninstall_windows() -> Result<()> {
    let mut cmd = Command::new("schtasks.exe");
    cmd.args(["/Delete", "/F", "/TN", TASK_NAME]);
    let _ = cmd.output();
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
fn install_macos(interval_minutes: u32) -> Result<String> {
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
<key>StartInterval</key><integer>{}</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
</dict></plist>
"#,
        xml_escape(&exe.to_string_lossy()),
        interval_minutes.clamp(5, 1440) * 60
    );
    fs::write(&path, plist)?;
    let domain = format!("gui/{}", mac_uid()?);
    let mut bootout = Command::new("launchctl");
    bootout.args(["bootout", &domain, path.to_string_lossy().as_ref()]);
    let _ = bootout.output();
    let mut bootstrap = Command::new("launchctl");
    bootstrap.args(["bootstrap", &domain, path.to_string_lossy().as_ref()]);
    run_ok(bootstrap, "macOS launchd registration")?;
    Ok(format!(
        "macOS launchd every {} minutes",
        interval_minutes.clamp(5, 1440)
    ))
}

#[cfg(target_os = "macos")]
fn uninstall_macos() -> Result<()> {
    let path = launch_agent_path()?;
    let domain = format!("gui/{}", mac_uid()?);
    let mut cmd = Command::new("launchctl");
    cmd.args(["bootout", &domain, path.to_string_lossy().as_ref()]);
    let _ = cmd.output();
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
    // systemd treats '%' as a specifier even inside quotes, so double it.
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "linux")]
fn try_install_systemd(interval_minutes: u32) -> Result<String> {
    let exe = executable()?;
    let dir = systemd_dir()?;
    fs::create_dir_all(&dir)?;
    let service = format!(
        "[Unit]\nDescription=UsageMesh usage snapshot\n\n[Service]\nType=oneshot\nExecStart={} sync --quiet\nNice=10\nIOSchedulingClass=idle\n",
        systemd_exec_path(&exe)
    );
    let timer = format!(
        "[Unit]\nDescription=Periodic UsageMesh usage snapshot\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec={}min\nRandomizedDelaySec=45\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n",
        interval_minutes.clamp(5, 1440)
    );
    fs::write(dir.join("usagemesh.service"), service)?;
    fs::write(dir.join("usagemesh.timer"), timer)?;

    let mut reload = Command::new("systemctl");
    reload.args(["--user", "daemon-reload"]);
    run_ok(reload, "systemd user daemon reload")?;
    let mut enable = Command::new("systemctl");
    enable.args(["--user", "enable", "--now", "usagemesh.timer"]);
    run_ok(enable, "systemd user timer registration")?;
    Ok(format!(
        "systemd user timer every {} minutes",
        interval_minutes.clamp(5, 1440)
    ))
}

#[cfg(target_os = "linux")]
fn cron_cadence(interval_minutes: u32) -> (&'static str, u32) {
    match interval_minutes {
        5..=59 => ("minutes", interval_minutes),
        60 => ("hour", 1),
        value if value >= 120 && value % 60 == 0 && value / 60 <= 23 => ("hours", value / 60),
        1440 => ("day", 1),
        _ => ("minutes", 15),
    }
}

#[cfg(target_os = "linux")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "linux")]
fn install_cron(interval_minutes: u32) -> Result<String> {
    if Command::new("crontab").arg("-l").output().is_err() {
        bail!("neither a usable systemd --user session nor the `crontab` command is available; run `usagemesh sync` manually or install a user cron implementation")
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

    let (kind, amount) = cron_cadence(interval_minutes);
    let (expression, actual_description) = match kind {
        "minutes" => (
            format!("*/{amount} * * * *"),
            format!("every {amount} minutes"),
        ),
        "hour" => ("0 * * * *".to_string(), "every hour".to_string()),
        "hours" => (
            format!("0 */{amount} * * *"),
            format!("every {amount} hours"),
        ),
        "day" => ("0 0 * * *".to_string(), "daily".to_string()),
        _ => unreachable!(),
    };
    lines.push(format!(
        "{expression} {} sync --quiet {marker}",
        shell_single_quote(&exe.to_string_lossy())
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
    Ok(format!("cron {actual_description}"))
}

#[cfg(target_os = "linux")]
fn install_linux(interval_minutes: u32) -> Result<String> {
    let systemd_present = Command::new("systemctl").arg("--version").output().is_ok();
    if systemd_present {
        match try_install_systemd(interval_minutes) {
            Ok(description) => return Ok(description),
            Err(systemd_error) => {
                if let Ok(dir) = systemd_dir() {
                    let _ = fs::remove_file(dir.join("usagemesh.timer"));
                    let _ = fs::remove_file(dir.join("usagemesh.service"));
                }
                return install_cron(interval_minutes).with_context(|| {
                    format!(
                        "systemd user timer unavailable ({systemd_error}); cron fallback also failed"
                    )
                });
            }
        }
    }
    install_cron(interval_minutes)
}

#[cfg(target_os = "linux")]
fn uninstall_linux() -> Result<()> {
    let mut disable = Command::new("systemctl");
    disable.args(["--user", "disable", "--now", "usagemesh.timer"]);
    let _ = disable.output();
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

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn cron_fallback_uses_safe_supported_cadences() {
        assert_eq!(cron_cadence(15), ("minutes", 15));
        assert_eq!(cron_cadence(60), ("hour", 1));
        assert_eq!(cron_cadence(120), ("hours", 2));
        assert_eq!(cron_cadence(1440), ("day", 1));
        assert_eq!(cron_cadence(90), ("minutes", 15));
    }

    #[test]
    fn cron_shell_quote_handles_spaces_and_apostrophes() {
        assert_eq!(shell_single_quote("/home/a b/tm"), "'/home/a b/tm'");
        assert_eq!(shell_single_quote("/home/o'b/tm"), "'/home/o'\"'\"'b/tm'");
    }

    #[test]
    fn systemd_path_escapes_percent_and_spaces() {
        let rendered = systemd_exec_path(Path::new("/home/a b/100%/usagemesh"));
        assert_eq!(rendered, "\"/home/a b/100%%/usagemesh\"");
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    #[test]
    fn task_action_quotes_executable_with_spaces() {
        let action = windows_task_action(Path::new(r"C:\Users\Test User\UsageMesh\usagemesh.exe"));
        assert_eq!(
            action,
            r#""C:\Users\Test User\UsageMesh\usagemesh.exe" sync --quiet"#
        );
    }
}
