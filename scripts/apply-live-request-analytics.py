from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)

# ---- model.rs: request-level encrypted metadata ----
p = Path('rust-cli/src/model.rs')
s = p.read_text()
s = s.replace('pub const CURRENT_LEDGER_SCHEMA_VERSION: u32 = 4;', 'pub const CURRENT_LEDGER_SCHEMA_VERSION: u32 = 5;')
ledger_anchor = '''#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {'''
request_struct = '''#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetail {
    /// Exact source event time normalized to Unix milliseconds.
    pub timestamp_ms: i64,
    pub client: String,
    pub provider: String,
    pub upstream_vendor: String,
    pub route_provider: String,
    pub route_type: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub cost_lower_bound: bool,
    #[serde(flatten)]
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {'''
s = replace_once(s, ledger_anchor, request_struct, 'request detail struct')
s = replace_once(s, '    pub rows: Vec<UsageRow>,\n    pub totals: Metrics,', '    pub rows: Vec<UsageRow>,\n    #[serde(default)]\n    pub requests: Vec<RequestDetail>,\n    pub totals: Metrics,', 'ledger requests field')
p.write_text(s)

# ---- codex_tier.rs: exact Codex timestamp + tier + reasoning effort ----
p = Path('rust-cli/src/codex_tier.rs')
s = p.read_text()
s = replace_once(s, '''pub struct EnhancedCodexRow {
    pub date: String,
    pub model: String,
    pub provider: String,
    pub tier: String,
    pub metrics: Metrics,
    pub cache_write_known: bool,
}''', '''pub struct EnhancedCodexRow {
    pub date: String,
    pub timestamp_ms: i64,
    pub model: String,
    pub provider: String,
    pub tier: String,
    pub reasoning_effort: Option<String>,
    pub metrics: Metrics,
    pub cache_write_known: bool,
}''', 'EnhancedCodexRow')
service_anchor = '''fn timestamp_ms(value: Option<&Value>) -> Option<i64> {'''
effort_fn = '''fn extract_reasoning_effort(payload: &Value) -> Option<String> {
    let candidates = [
        payload.get("effort"),
        payload.get("reasoning_effort"),
        payload.get("reasoningEffort"),
        payload.pointer("/reasoning/effort"),
        payload.pointer("/reasoning/config/effort"),
        payload.pointer("/thread_settings/reasoning_effort"),
        payload.pointer("/thread_settings/reasoningEffort"),
    ];
    candidates.into_iter().flatten().find_map(|value| {
        value
            .as_str()
            .map(|text| text.trim().to_ascii_lowercase())
            .filter(|text| !text.is_empty())
    })
}

fn timestamp_ms(value: Option<&Value>) -> Option<i64> {'''
s = replace_once(s, service_anchor, effort_fn, 'reasoning effort parser')
s = replace_once(s, '''struct RequestRecord {
    dedupe: String,
    date: String,
    model: String,
    provider: String,
    tier: String,
    usage: RawUsage,
}''', '''struct RequestRecord {
    dedupe: String,
    date: String,
    timestamp_ms: i64,
    model: String,
    provider: String,
    tier: String,
    reasoning_effort: Option<String>,
    usage: RawUsage,
}''', 'RequestRecord fields')
s = replace_once(s, '    let mut current_tier = "standard".to_string();\n    let mut records = Vec::new();', '    let mut current_tier = "standard".to_string();\n    let mut current_reasoning_effort: Option<String> = None;\n    let mut records = Vec::new();', 'current effort state')
s = replace_once(s, '''        if let Some(tier) = extract_service_tier(payload) {
            current_tier = tier;
        }

        match string_at(&row, "type").unwrap_or_default() {''', '''        if let Some(tier) = extract_service_tier(payload) {
            current_tier = tier;
        }
        if let Some(effort) = extract_reasoning_effort(payload) {
            current_reasoning_effort = Some(effort);
        }

        match string_at(&row, "type").unwrap_or_default() {''', 'effort state update')
s = replace_once(s, '''                records.push(RequestRecord {
                    dedupe: usage_dedupe_key(&session_id, &usage, &total),
                    date: bucket_timezone.day_key(milliseconds),
                    model: current_model.clone(),
                    provider: provider.clone(),
                    tier: current_tier.clone(),
                    usage,
                });''', '''                records.push(RequestRecord {
                    dedupe: usage_dedupe_key(&session_id, &usage, &total),
                    date: bucket_timezone.day_key(milliseconds),
                    timestamp_ms: milliseconds,
                    model: current_model.clone(),
                    provider: provider.clone(),
                    tier: current_tier.clone(),
                    reasoning_effort: current_reasoning_effort.clone(),
                    usage,
                });''', 'codex request creation')
s = replace_once(s, '''                rows.push(EnhancedCodexRow {
                    date: request.date,
                    model: request.model,
                    provider: request.provider,
                    tier: request.tier,
                    metrics,
                    cache_write_known: request.usage.cache_write.is_some(),
                });''', '''                rows.push(EnhancedCodexRow {
                    date: request.date,
                    timestamp_ms: request.timestamp_ms,
                    model: request.model,
                    provider: request.provider,
                    tier: request.tier,
                    reasoning_effort: request.reasoning_effort,
                    metrics,
                    cache_write_known: request.usage.cache_write.is_some(),
                });''', 'enhanced request output')
p.write_text(s)

# ---- collector.rs: retain a bounded, request-granular live feed ----
p = Path('rust-cli/src/collector.rs')
s = p.read_text()
s = s.replace('use crate::model::{DeviceInfo, Ledger, Metrics, PricingInfo, UsageRow};', 'use crate::model::{DeviceInfo, Ledger, Metrics, PricingInfo, RequestDetail, UsageRow};')
row_acc = '''#[derive(Default)]
struct RowAccumulator {
    metrics: Metrics,
    cost_lower_bound: bool,
}
'''
helpers = row_acc + '''
const MAX_REQUEST_DETAILS: usize = 1000;

fn normalized_timestamp_ms(timestamp: i64) -> i64 {
    if timestamp.abs() < 100_000_000_000 {
        timestamp.saturating_mul(1000)
    } else {
        timestamp
    }
}

fn trim_request_details(requests: &mut Vec<RequestDetail>) {
    requests.sort_by(|a, b| {
        a.timestamp_ms
            .cmp(&b.timestamp_ms)
            .then_with(|| a.client.cmp(&b.client))
            .then_with(|| a.model.cmp(&b.model))
    });
    requests.dedup_by(|a, b| {
        a.timestamp_ms == b.timestamp_ms
            && a.client == b.client
            && a.model == b.model
            && a.tier == b.tier
            && a.metrics == b.metrics
    });
    if requests.len() > MAX_REQUEST_DETAILS {
        requests.drain(0..requests.len() - MAX_REQUEST_DETAILS);
    }
}
'''
s = replace_once(s, row_acc, helpers, 'collector helpers')
s = replace_once(s, '    let mut grouped: BTreeMap<RowKey, RowAccumulator> = BTreeMap::new();', '    let mut grouped: BTreeMap<RowKey, RowAccumulator> = BTreeMap::new();\n    let mut request_details: Vec<RequestDetail> = Vec::new();', 'request details vector')
canonical_anchor = '''        let (raw_provider, identity) = route_for_message(&route_evidence, message, &client, &model);
        let (metrics, cost_lower_bound) = priced_metrics_from_message(message, &model, &price_book);
        add_grouped(
            &mut grouped,
            RowKey {
                date: message.date.clone(),
                client,
                provider: raw_provider,
                upstream_vendor: identity.upstream_vendor,
                route_provider: identity.route_provider,
                route_type: identity.route_type,
                model,
                tier: None,
            },
            metrics,
            cost_lower_bound,
        );'''
canonical_new = '''        let (raw_provider, identity) = route_for_message(&route_evidence, message, &client, &model);
        let (metrics, cost_lower_bound) = priced_metrics_from_message(message, &model, &price_book);
        request_details.push(RequestDetail {
            timestamp_ms: normalized_timestamp_ms(message.timestamp),
            client: client.clone(),
            provider: raw_provider.clone(),
            upstream_vendor: identity.upstream_vendor.clone(),
            route_provider: identity.route_provider.clone(),
            route_type: identity.route_type.clone(),
            model: model.clone(),
            tier: None,
            reasoning_effort: None,
            agent: message.agent.clone(),
            duration_ms: message.duration_ms.filter(|value| *value >= 0),
            cost_lower_bound,
            metrics: metrics.clone(),
        });
        add_grouped(
            &mut grouped,
            RowKey {
                date: message.date.clone(),
                client,
                provider: raw_provider,
                upstream_vendor: identity.upstream_vendor,
                route_provider: identity.route_provider,
                route_type: identity.route_type,
                model,
                tier: None,
            },
            metrics,
            cost_lower_bound,
        );'''
s = replace_once(s, canonical_anchor, canonical_new, 'canonical request details')
enhanced_anchor = '''        let mut metrics = enhanced.metrics;
        let quote = price_book.quote(&model, Some(&enhanced.tier), &metrics);
        metrics.cost_usd = quote.cost_usd;
        // If Codex did not record cache-write separately, the normalized fresh
        // input can contain some cache creation. CC Switch charges GPT-5.6 cache
        // creation at 1.25x input, so the result is explicitly marked as a lower
        // bound rather than pretending to be exact.
        let missing_cache_write_evidence = !enhanced.cache_write_known && metrics.input > 0;
        add_grouped(
            &mut grouped,
            RowKey {
                date: enhanced.date,
                client: "codex".to_string(),
                provider: raw_provider,
                upstream_vendor: identity.upstream_vendor,
                route_provider: identity.route_provider,
                route_type: identity.route_type,
                model,
                tier: Some(enhanced.tier),
            },
            metrics,
            quote.lower_bound || missing_cache_write_evidence,
        );'''
enhanced_new = '''        let mut metrics = enhanced.metrics;
        let quote = price_book.quote(&model, Some(&enhanced.tier), &metrics);
        metrics.cost_usd = quote.cost_usd;
        // If Codex did not record cache-write separately, the normalized fresh
        // input can contain some cache creation. CC Switch charges GPT-5.6 cache
        // creation at 1.25x input, so the result is explicitly marked as a lower
        // bound rather than pretending to be exact.
        let missing_cache_write_evidence = !enhanced.cache_write_known && metrics.input > 0;
        let cost_lower_bound = quote.lower_bound || missing_cache_write_evidence;
        request_details.push(RequestDetail {
            timestamp_ms: enhanced.timestamp_ms,
            client: "codex".to_string(),
            provider: raw_provider.clone(),
            upstream_vendor: identity.upstream_vendor.clone(),
            route_provider: identity.route_provider.clone(),
            route_type: identity.route_type.clone(),
            model: model.clone(),
            tier: Some(enhanced.tier.clone()),
            reasoning_effort: enhanced.reasoning_effort.clone(),
            agent: None,
            duration_ms: None,
            cost_lower_bound,
            metrics: metrics.clone(),
        });
        add_grouped(
            &mut grouped,
            RowKey {
                date: enhanced.date,
                client: "codex".to_string(),
                provider: raw_provider,
                upstream_vendor: identity.upstream_vendor,
                route_provider: identity.route_provider,
                route_type: identity.route_type,
                model,
                tier: Some(enhanced.tier),
            },
            metrics,
            cost_lower_bound,
        );'''
s = replace_once(s, enhanced_anchor, enhanced_new, 'enhanced request details')
s = replace_once(s, '''    Ok(Ledger {
        schema_version: 4,
        generated_at: chrono::Utc::now().to_rfc3339(),
        device,
        rows,
        totals,''', '''    trim_request_details(&mut request_details);
    Ok(Ledger {
        schema_version: 5,
        generated_at: chrono::Utc::now().to_rfc3339(),
        device,
        rows,
        requests: request_details,
        totals,''', 'ledger creation requests')
merge_anchor = '''pub fn merge_incremental(mut previous: Ledger, partial: Ledger, since: &str) -> Ledger {
    previous.rows.retain(|row| row.date.as_str() < since);
    previous.rows.extend(partial.rows);'''
merge_new = '''pub fn merge_incremental(mut previous: Ledger, partial: Ledger, since: &str) -> Ledger {
    previous.rows.retain(|row| row.date.as_str() < since);
    previous.rows.extend(partial.rows);
    if let Some(cutoff) = partial.requests.iter().map(|row| row.timestamp_ms).min() {
        previous.requests.retain(|row| row.timestamp_ms < cutoff);
    }
    previous.requests.extend(partial.requests);'''
s = replace_once(s, merge_anchor, merge_new, 'incremental request merge')
s = replace_once(s, '''    previous.totals = Metrics::default();
    for row in &previous.rows {
        previous.totals.add(&row.metrics);
    }
    previous
}''', '''    previous.totals = Metrics::default();
    for row in &previous.rows {
        previous.totals.add(&row.metrics);
    }
    trim_request_details(&mut previous.requests);
    previous
}''', 'trim merged requests')
s = replace_once(s, '''        && left.rows == right.rows
        && left.totals == right.totals''', '''        && left.rows == right.rows
        && left.requests == right.requests
        && left.totals == right.totals''', 'same accounting request identity')
s = s.replace('            rows: Vec::new(),\n            totals: Metrics::default(),', '            rows: Vec::new(),\n            requests: Vec::new(),\n            totals: Metrics::default(),')
p.write_text(s)

# ---- config.rs: additive 30-second cadence, backward compatible with v2 configs ----
p = Path('rust-cli/src/config.rs')
s = p.read_text()
s = replace_once(s, '    pub interval_minutes: u32,', '    #[serde(default = "default_interval_seconds")]\n    pub interval_seconds: u32,\n    #[serde(default)]\n    pub scheduler_revision: u32,', 'config cadence fields')
s = replace_once(s, '''struct JoinCode {
    version: u32,
    repo: String,
    dashboard_key: String,
    interval_minutes: u32,
}''', '''struct JoinCode {
    version: u32,
    repo: String,
    dashboard_key: String,
    #[serde(default)]
    interval_seconds: Option<u32>,
    #[serde(default)]
    interval_minutes: Option<u32>,
}''', 'join cadence compatibility')
insert = '''pub fn ledger_cache_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("ledger-cache.json"))
}
'''
insert_new = insert + '''
const fn default_interval_seconds() -> u32 {
    30
}

fn normalize_interval_seconds(_: u32) -> u32 {
    30
}
'''
s = replace_once(s, insert, insert_new, 'default 30s')
s = replace_once(s, '''pub fn new_config(
    repo: &str,
    token: String,
    device_name: Option<String>,
    interval_minutes: u32,
) -> Result<Config> {''', '''pub fn new_config(
    repo: &str,
    token: String,
    device_name: Option<String>,
) -> Result<Config> {''', 'new_config signature')
s = replace_once(s, '        interval_minutes: interval_minutes.clamp(1, 1440),', '        interval_seconds: default_interval_seconds(),\n        scheduler_revision: 0,', 'new config cadence')
s = replace_once(s, '''        interval_minutes: join.interval_minutes.clamp(1, 1440),''', '''        interval_seconds: normalize_interval_seconds(
            join.interval_seconds
                .or_else(|| join.interval_minutes.map(|minutes| minutes.saturating_mul(60)))
                .unwrap_or(default_interval_seconds()),
        ),
        scheduler_revision: 0,''', 'join config cadence')
s = replace_once(s, '''        interval_minutes: config.interval_minutes,
    })?))''', '''        interval_seconds: Some(config.interval_seconds),
        interval_minutes: None,
    })?))''', 'join code cadence')
s = s.replace('new_config("owner/repo", "t".into(), Some("My PC".into()), 15)', 'new_config("owner/repo", "t".into(), Some("My PC".into()))')
s = s.replace('new_config("owner/repo", "t".into(), Some("x".into()), 15)', 'new_config("owner/repo", "t".into(), Some("x".into()))')
s = s.replace('new_config("Atingaii/UsageMesh", "t".into(), Some("x".into()), 15)', 'new_config("Atingaii/UsageMesh", "t".into(), Some("x".into()))')
s = s.replace('new_config("owner/repo", "t".into(), Some("server".into()), 15)', 'new_config("owner/repo", "t".into(), Some("server".into()))')
p.write_text(s)

# ---- scheduler.rs: native 30s cadence everywhere; cron/Windows emulate sub-minute safely ----
Path('rust-cli/src/scheduler.rs').write_text(r'''use std::fs;
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
    { return install_windows(); }
    #[cfg(target_os = "macos")]
    { return install_macos(); }
    #[cfg(target_os = "linux")]
    { return install_linux(); }
    #[allow(unreachable_code)]
    bail!("automatic scheduling is not supported on this platform")
}

pub fn uninstall() -> Result<()> {
    #[cfg(target_os = "windows")]
    { return uninstall_windows(); }
    #[cfg(target_os = "macos")]
    { return uninstall_macos(); }
    #[cfg(target_os = "linux")]
    { return uninstall_linux(); }
    #[allow(unreachable_code)]
    Ok(())
}

pub fn is_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("schtasks.exe")
            .args(["/Query", "/TN", TASK_NAME])
            .output().map(|output| output.status.success()).unwrap_or(false);
    }
    #[cfg(target_os = "macos")]
    { return launch_agent_path().map(|path| path.is_file()).unwrap_or(false); }
    #[cfg(target_os = "linux")]
    {
        if systemd_dir().map(|dir| dir.join("usagemesh.timer").is_file()).unwrap_or(false) {
            return true;
        }
        return Command::new("crontab").arg("-l").output().ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).contains("# usagemesh-usage-sync"))
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

fn run_ok(mut command: Command, description: &str) -> Result<()> {
    let output = command.output().with_context(|| format!("failed to run {description}"))?;
    if output.status.success() { return Ok(()); }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    bail!("{description} failed: {detail}")
}

#[cfg(target_os = "windows")]
fn ps_quote(value: &str) -> String { value.replace('\'', "''") }

#[cfg(target_os = "windows")]
fn windows_runner_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("sync-30s.ps1"))
}

#[cfg(target_os = "windows")]
fn install_windows() -> Result<String> {
    let exe = executable()?;
    let runner = windows_runner_path()?;
    if let Some(parent) = runner.parent() { fs::create_dir_all(parent)?; }
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
    cmd.args(["/Create", "/F", "/SC", "MINUTE", "/MO", "1", "/TN", TASK_NAME, "/TR", &action]);
    run_ok(cmd, "Windows Task Scheduler registration")?;
    let _ = Command::new("schtasks.exe").args(["/Run", "/TN", TASK_NAME]).output();
    Ok("Windows Task Scheduler every 30 seconds (two guarded syncs per minute)".to_string())
}

#[cfg(target_os = "windows")]
fn uninstall_windows() -> Result<()> {
    let _ = Command::new("schtasks.exe").args(["/Delete", "/F", "/TN", TASK_NAME]).output();
    if let Ok(path) = windows_runner_path() { let _ = fs::remove_file(path); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Result<PathBuf> {
    Ok(dirs::home_dir().context("cannot determine home directory")?
        .join("Library/LaunchAgents/io.atingaii.usagemesh.plist"))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn mac_uid() -> Result<String> {
    let output = Command::new("id").arg("-u").output()?;
    if !output.status.success() { bail!("cannot determine macOS uid"); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn install_macos() -> Result<String> {
    let exe = executable()?;
    let path = launch_agent_path()?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    let plist = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.atingaii.usagemesh</string>
<key>ProgramArguments</key><array><string>{}</string><string>sync</string><string>--quiet</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
</dict></plist>
"#, xml_escape(&exe.to_string_lossy()));
    fs::write(&path, plist)?;
    let domain = format!("gui/{}", mac_uid()?);
    let _ = Command::new("launchctl").args(["bootout", &domain, path.to_string_lossy().as_ref()]).output();
    let mut bootstrap = Command::new("launchctl");
    bootstrap.args(["bootstrap", &domain, path.to_string_lossy().as_ref()]);
    run_ok(bootstrap, "macOS launchd registration")?;
    Ok("macOS launchd every 30 seconds".to_string())
}

#[cfg(target_os = "macos")]
fn uninstall_macos() -> Result<()> {
    let path = launch_agent_path()?;
    let domain = format!("gui/{}", mac_uid()?);
    let _ = Command::new("launchctl").args(["bootout", &domain, path.to_string_lossy().as_ref()]).output();
    let _ = fs::remove_file(path);
    Ok(())
}

#[cfg(target_os = "linux")]
fn systemd_dir() -> Result<PathBuf> {
    Ok(dirs::config_dir().context("cannot determine config directory")?.join("systemd/user"))
}

#[cfg(target_os = "linux")]
fn systemd_exec_path(path: &Path) -> String {
    let escaped = path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%");
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
    let mut reload = Command::new("systemctl"); reload.args(["--user", "daemon-reload"]); run_ok(reload, "systemd user daemon reload")?;
    let mut enable = Command::new("systemctl"); enable.args(["--user", "enable", "--now", "usagemesh.timer"]); run_ok(enable, "systemd user timer registration")?;
    Ok("systemd user timer every 30 seconds".to_string())
}

#[cfg(target_os = "linux")]
fn shell_single_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }

#[cfg(target_os = "linux")]
fn install_cron() -> Result<String> {
    if Command::new("crontab").arg("-l").output().is_err() {
        bail!("neither a usable systemd --user session nor crontab is available; run usagemesh sync manually")
    }
    let exe = executable()?;
    let existing = Command::new("crontab").arg("-l").output().ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string()).unwrap_or_default();
    let marker = "# usagemesh-usage-sync";
    let mut lines: Vec<String> = existing.lines().filter(|line| !line.contains(marker)).map(str::to_string).collect();
    let quoted = shell_single_quote(&exe.to_string_lossy());
    lines.push(format!("* * * * * {quoted} sync --quiet {marker}:00"));
    lines.push(format!("* * * * * sleep 30; {quoted} sync --quiet {marker}:30"));
    let mut child = Command::new("crontab").arg("-").stdin(std::process::Stdio::piped()).spawn().context("failed to start crontab")?;
    use std::io::Write;
    child.stdin.as_mut().context("crontab stdin unavailable")?.write_all(format!("{}\n", lines.join("\n")).as_bytes())?;
    if !child.wait()?.success() { bail!("crontab registration failed"); }
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
    let _ = Command::new("systemctl").args(["--user", "disable", "--now", "usagemesh.timer"]).output();
    if let Ok(dir) = systemd_dir() {
        let _ = fs::remove_file(dir.join("usagemesh.timer"));
        let _ = fs::remove_file(dir.join("usagemesh.service"));
    }
    let existing = Command::new("crontab").arg("-l").output().ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string()).unwrap_or_default();
    if !existing.is_empty() {
        let cleaned = existing.lines().filter(|line| !line.contains("# usagemesh-usage-sync")).collect::<Vec<_>>().join("\n");
        if let Ok(mut child) = Command::new("crontab").arg("-").stdin(std::process::Stdio::piped()).spawn() {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(format!("{cleaned}\n").as_bytes()); }
            let _ = child.wait();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cadence_is_thirty_seconds() { assert_eq!(SYNC_INTERVAL_SECONDS, 30); }
}
''')

# ---- main.rs: fixed 30s scheduler migration + overlap guard ----
p = Path('rust-cli/src/main.rs')
s = p.read_text()
s = s.replace('use std::fs;\nuse std::process::Command;', 'use std::fs;\nuse std::io::ErrorKind;\nuse std::path::PathBuf;\nuse std::process::Command;\nuse std::time::{Duration as StdDuration, SystemTime};')
# remove setup interval option
s = re.sub(r'''        /// Snapshot cadence in minutes\. No process stays resident between runs\.\n        #\[arg\(long, default_value_t = 1\)\]\n        interval: u32,\n''', '', s, count=1)
# add lock helper before run_sync
anchor = '''fn run_sync(full: bool, quiet: bool) -> Result<()> {'''
lock_code = r'''struct SyncLock {
    path: PathBuf,
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_sync_lock() -> Result<Option<SyncLock>> {
    let path = config::config_dir()?.join("sync.lock");
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    for attempt in 0..2 {
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
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

fn run_sync(full: bool, quiet: bool) -> Result<()> {'''
s = replace_once(s, anchor, lock_code, 'sync lock helper')
old_migration = re.search(r'''    // v2\.0\.3 standardizes the live refresh cadence at one minute\..*?\n    let previous = config::read_cached_ledger\(\)\?;''', s, flags=re.S)
if not old_migration:
    raise SystemExit('one-minute migration block not found')
new_migration = '''    // v2.1 standardizes near-real-time synchronization at 30 seconds. Existing
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
                if !quiet { println!("Automatic sync cadence migrated: {description}"); }
            }
            Err(error) => {
                if !quiet { eprintln!("Could not migrate the existing scheduler to 30 seconds: {error:#}"); }
            }
        }
    }
    if save_config {
        config::save(&config).context("failed to persist the 30-second sync cadence")?;
    }

    let _sync_lock = match acquire_sync_lock()? {
        Some(lock) => lock,
        None => {
            if !quiet { println!("Another UsageMesh sync is still running; skipping this tick."); }
            return Ok(());
        }
    };

    let previous = config::read_cached_ledger()?;'''
s = s[:old_migration.start()] + new_migration + s[old_migration.end():]
# setup signature and call
s = s.replace('    interval: u32,\n    dashboard_password: Option<String>,', '    dashboard_password: Option<String>,')
s = s.replace('    let config = config::new_config(&repo, token, device, interval)?;', '    let config = config::new_config(&repo, token, device)?;')
s = s.replace('            interval,\n            dashboard_password,', '            dashboard_password,')
s = s.replace('            interval,\n            dashboard_password,\n            no_schedule,', '            dashboard_password,\n            no_schedule,')
# finish onboarding installs and records revision
old = '''    if !no_schedule {
        match scheduler::install(config.interval_minutes) {
            Ok(description) => println!("Automatic sync: {description}"),
            Err(error) => {'''
new = '''    if !no_schedule {
        match scheduler::install(config.interval_seconds) {
            Ok(description) => {
                println!("Automatic sync: {description}");
                let mut persisted = config.clone();
                persisted.scheduler_revision = scheduler::revision();
                let _ = config::save(&persisted);
            }
            Err(error) => {'''
s = replace_once(s, old, new, 'onboarding scheduler')
s = s.replace('    println!("Interval: {} minutes", config.interval_minutes);', '    println!("Sync interval: {} seconds", config.interval_seconds);')
p.write_text(s)

# ---- web UI: request feed + 10-second browser polling ----
p = Path('web-ui/src/app.tsx')
s = p.read_text()
usage_end = '''interface DeviceInfo {'''
request_iface = '''interface RequestRecord {
  id: string;
  timestampMs: number;
  date: string;
  device: string;
  deviceId: string;
  platform: string;
  architecture: string;
  tool: string;
  model: string;
  vendor: string;
  routeProvider: string;
  routeType: string;
  rawProvider: string;
  tier: string;
  reasoningEffort: string;
  agent: string;
  durationMs: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requestCount: number;
  cost: number;
  costLowerBound: boolean;
}

interface DeviceInfo {'''
s = replace_once(s, usage_end, request_iface, 'request UI interface')
s = replace_once(s, '''interface DashboardDataset {
  repo: string;
  records: UsageRecord[];
  pricing: PricingStatus;
  lastSync: string;
}''', '''interface DashboardDataset {
  repo: string;
  records: UsageRecord[];
  requests: RequestRecord[];
  pricing: PricingStatus;
  lastSync: string;
}''', 'dataset requests')
# Pricing map revalidation throttle for live polling
s = replace_once(s, '''  const cached = readCache();
  const now = Date.now();
  try {
    // Revalidate on every unlock/refresh so newly-added LiteLLM models become''', '''  const cached = readCache();
  const now = Date.now();
  if (cached && now - cached.fetchedAt < 6 * 60 * 60 * 1000) {
    return { map: cached.map, fetchedAt: cached.fetchedAt, source: 'LiteLLM cache' };
  }
  try {
    // Revalidate periodically so newly-added LiteLLM models become''', 'pricing TTL')
# Ledger request interface and field
ledger_row_anchor = '''interface Ledger {
  schemaVersion?: number;'''
ledger_request = '''interface LedgerRequest {
  timestampMs?: number;
  client?: string;
  provider?: string;
  upstreamVendor?: string;
  routeProvider?: string;
  routeType?: string;
  model?: string;
  tier?: string | null;
  reasoningEffort?: string | null;
  agent?: string | null;
  durationMs?: number | null;
  costLowerBound?: boolean;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  messages?: number;
  costUsd?: number;
}

interface Ledger {
  schemaVersion?: number;'''
s = replace_once(s, ledger_row_anchor, ledger_request, 'ledger request interface')
s = replace_once(s, '  rows?: LedgerRow[];\n}', '  rows?: LedgerRow[];\n  requests?: LedgerRequest[];\n}', 'ledger request field')
# request conversion after toRecord
needle = '''async function loadDashboardWithKey(repo: string, key: string): Promise<DashboardDataset> {'''
converter = r'''function toRequestRecord(ledger: Ledger, row: LedgerRequest, index: number): RequestRecord {
  const deviceId = String(ledger.device?.id || ledger.device?.name || 'unknown-device');
  const deviceName = String(ledger.device?.name || ledger.device?.id || 'Unknown Device');
  const platform = String(ledger.device?.platform || 'unknown');
  const arch = String(ledger.device?.arch || '');
  const timestampMs = Number(row.timestampMs || 0);
  const input = Number(row.input || 0), output = Number(row.output || 0);
  const cacheRead = Number(row.cacheRead || 0), cacheWrite = Number(row.cacheWrite || 0);
  const reasoning = Number(row.reasoning || 0);
  const route = routeLabel(row as LedgerRow);
  return {
    id: `${deviceId}:${timestampMs}:${row.client || ''}:${row.model || ''}:${index}`,
    timestampMs,
    date: timestampMs > 0 ? new Date(timestampMs).toISOString().slice(0, 10) : '',
    device: deviceName,
    deviceId,
    platform: platformLabel(platform),
    architecture: archLabel(platform, arch),
    tool: String(row.client || 'Unknown'),
    model: String(row.model || 'Unknown'),
    vendor: String(row.upstreamVendor || 'Unknown'),
    routeProvider: route,
    routeType: String(row.routeType || 'unknown'),
    rawProvider: String(row.provider || 'unknown'),
    tier: tierLabel(row.tier),
    reasoningEffort: String(row.reasoningEffort || ''),
    agent: String(row.agent || ''),
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + cacheRead + cacheWrite + output + reasoning,
    requestCount: Math.max(1, Number(row.messages || 1)),
    cost: Number(row.costUsd || 0),
    costLowerBound: Boolean(row.costLowerBound),
  };
}

async function loadDashboardWithKey(repo: string, key: string): Promise<DashboardDataset> {'''
s = replace_once(s, needle, converter, 'request conversion')
s = replace_once(s, '''  const records = ledgers.flatMap(ledger => (ledger.rows || []).map((row, index) => toRecord(ledger, row, index)));
  const pricing = await applyDynamicPricing(records);
  const lastSync = ledgers.map(ledger => String(ledger.generatedAt || '')).filter(Boolean).sort().at(-1) || '';
  return { repo, records, pricing, lastSync };''', '''  const records = ledgers.flatMap(ledger => (ledger.rows || []).map((row, index) => toRecord(ledger, row, index)));
  const requests = ledgers
    .flatMap(ledger => (ledger.requests || []).map((row, index) => toRequestRecord(ledger, row, index)))
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 5000);
  const pricing = await applyDynamicPricing(records);
  const lastSync = ledgers.map(ledger => String(ledger.generatedAt || '')).filter(Boolean).sort().at(-1) || '';
  return { repo, records, requests, pricing, lastSync };''', 'load request feed')
# Props and UsageAnalysis signature
s = replace_once(s, 'interface Props { isDarkMode: boolean; records: UsageRecord[]; }', 'interface Props { isDarkMode: boolean; records: UsageRecord[]; requests: RequestRecord[]; }', 'analysis props')
s = replace_once(s, 'const UsageAnalysisView: React.FC<Props> = ({ isDarkMode, records }) => {', 'const UsageAnalysisView: React.FC<Props> = ({ isDarkMode, records, requests }) => {', 'analysis request arg')
# request search computations before return
request_compute_anchor = '''  const stats=[
    ['缓存命中率',`${summary.cacheHitRate.toFixed(1)}%`,'输入侧缓存读取占比'],
    ['平均 Tokens / 请求',Math.round(summary.avgTokensPerRequest).toLocaleString(),`平均费用 $${summary.avgCostPerRequest.toFixed(3)}`],
    ['输出 / 输入侧',`${summary.outputInputRatio.toFixed(1)}%`,`新增输入占比 ${summary.freshInputShare.toFixed(1)}%`],
    ['等价费用 / 1M Tokens',`$${summary.equivalentCostPerMillion.toFixed(2)}`,'用于结构效率比较，不代表账单'],
  ];

  return <div className="space-y-4 transition-colors">'''
request_compute_new = '''  const stats=[
    ['缓存命中率',`${summary.cacheHitRate.toFixed(1)}%`,'输入侧缓存读取占比'],
    ['平均 Tokens / 请求',Math.round(summary.avgTokensPerRequest).toLocaleString(),`平均费用 $${summary.avgCostPerRequest.toFixed(3)}`],
    ['输出 / 输入侧',`${summary.outputInputRatio.toFixed(1)}%`,`新增输入占比 ${summary.freshInputShare.toFixed(1)}%`],
    ['等价费用 / 1M Tokens',`$${summary.equivalentCostPerMillion.toFixed(2)}`,'用于结构效率比较，不代表账单'],
  ];
  const [requestSearch, setRequestSearch] = useState('');
  const liveRequests = useMemo(() => {
    const q = requestSearch.trim().toLowerCase();
    return requests
      .filter(r => !q || [r.device,r.tool,r.model,r.routeProvider,r.tier,r.reasoningEffort,r.agent].some(v => String(v).toLowerCase().includes(q)))
      .sort((a,b) => b.timestampMs - a.timestampMs)
      .slice(0, 300);
  }, [requests, requestSearch]);
  const requestTime = (ms:number) => ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
  const durationText = (ms:number|null) => ms == null || ms < 0 ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms/1000).toFixed(ms < 10000 ? 2 : 1)} s`;

  return <div className="space-y-4 transition-colors">'''
s = replace_once(s, request_compute_anchor, request_compute_new, 'request computations')
# insert request table after summary section before structure contribution
structure_anchor = '''    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3.5"><div><h3 className="text-sm font-semibold text-[var(--text-primary)]">结构贡献</h3>'''
request_section = r'''    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3.5">
        <div><div className="flex items-center gap-2"><Clock className="h-4 w-4 text-emerald-500"/><h3 className="text-sm font-semibold text-[var(--text-primary)]">实时请求明细</h3><span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"/>LIVE</span></div><p className="mt-0.5 text-xs text-[var(--text-muted)]">设备约每 30 秒采集并上传；页面每 10 秒检查新快照。仅展示用量元数据，不上传 Prompt、回复或源代码。</p></div>
        <div className="relative"><input value={requestSearch} onChange={e=>setRequestSearch(e.target.value)} placeholder="搜索设备、模型、速率、思考强度..." className="w-64 rounded-lg border border-[var(--border-color)] bg-[var(--bg-main)] py-1.5 pl-8 pr-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]"/><Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-[var(--text-muted)]"/></div>
      </div>
      <div className="max-h-[620px] overflow-auto"><table className="w-full min-w-[1500px] whitespace-nowrap text-left text-xs"><thead className="sticky top-0 z-10 border-b border-[var(--border-color)] bg-[var(--bg-main)] text-[10px] font-mono text-[var(--text-muted)]"><tr><th className="p-3">具体时间</th><th className="p-3">设备</th><th className="p-3">客户端</th><th className="p-3">模型</th><th className="p-3">路由</th><th className="p-3">速率</th><th className="p-3">思考强度</th><th className="p-3 text-right">输入</th><th className="p-3 text-right">Cache Read</th><th className="p-3 text-right">Cache Write</th><th className="p-3 text-right">输出</th><th className="p-3 text-right">Reasoning</th><th className="p-3 text-right">总 Tokens</th><th className="p-3 text-right">耗时</th><th className="p-3 text-right">费用</th></tr></thead><tbody className="divide-y divide-[var(--border-subtle)] font-mono">{liveRequests.map(r=><tr key={r.id} className="hover:bg-[var(--bg-card-hover)]"><td className="p-3 text-[var(--text-secondary)]">{requestTime(r.timestampMs)}</td><td className="p-3 font-medium text-[var(--text-primary)]">{r.device}</td><td className="p-3 text-[var(--text-primary)]">{r.tool}</td><td className="p-3 font-semibold text-[var(--accent-blue)]">{r.model}</td><td className="p-3 text-[var(--text-secondary)]">{r.routeProvider}</td><td className="p-3"><span className={`rounded px-1.5 py-0.5 text-[10px] ${/fast|priority/i.test(r.tier)?'bg-blue-500/15 text-blue-600 dark:text-blue-400 font-bold':'bg-[var(--bg-main)] text-[var(--text-secondary)] border border-[var(--border-color)]'}`}>{r.tier}</span></td><td className="p-3"><span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-600 dark:text-purple-400">{r.reasoningEffort || '—'}</span></td><td className="p-3 text-right">{r.inputTokens.toLocaleString()}</td><td className="p-3 text-right text-indigo-500">{r.cacheReadTokens.toLocaleString()}</td><td className="p-3 text-right text-slate-500">{r.cacheWriteTokens.toLocaleString()}</td><td className="p-3 text-right text-amber-500">{r.outputTokens.toLocaleString()}</td><td className="p-3 text-right text-purple-500">{r.reasoningTokens.toLocaleString()}</td><td className="p-3 text-right font-bold text-[var(--text-primary)]">{r.totalTokens.toLocaleString()}</td><td className="p-3 text-right text-[var(--text-secondary)]">{durationText(r.durationMs)}</td><td className="p-3 text-right font-bold text-emerald-600">{r.costLowerBound?'≥':''}${r.cost.toFixed(4)}</td></tr>)}{!liveRequests.length&&<tr><td colSpan={15} className="py-12 text-center text-[var(--text-muted)]">暂无请求级明细。升级设备端到支持请求明细的版本后，新快照会自动出现。</td></tr>}</tbody></table></div>
      <div className="border-t border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-2.5 text-[10px] text-[var(--text-muted)]">显示最近 {liveRequests.length} 条匹配记录；每台设备账本滚动保留最近 1000 条请求级用量记录。</div>
    </section>

    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3.5"><div><h3 className="text-sm font-semibold text-[var(--text-primary)]">结构贡献</h3>'''
s = replace_once(s, structure_anchor, request_section, 'request details section')
# request filter helper + app filteredRequests
range_anchor = '''function inTimeRange(row: UsageRecord, filters: FilterState) {'''
request_range = '''function inRequestTimeRange(row: RequestRecord, filters: FilterState) {
  const date = row.date.slice(0,10);
  const today = ymd(new Date());
  if (filters.timeRange === 'today') return date === today;
  if (filters.timeRange === '7d') return date >= startDaysAgo(6) && date <= today;
  if (filters.timeRange === '30d') return date >= startDaysAgo(29) && date <= today;
  if (filters.timeRange === 'month') return date.startsWith(today.slice(0,7));
  if (filters.timeRange === 'custom') {
    if (filters.customStartDate && date < filters.customStartDate) return false;
    if (filters.customEndDate && date > filters.customEndDate) return false;
  }
  return true;
}

function inTimeRange(row: UsageRecord, filters: FilterState) {'''
s = replace_once(s, range_anchor, request_range, 'request time filter')
filtered_anchor = '''  const deviceRows = useMemo(() => devices(filtered), [filtered]);'''
filtered_request = '''  const filteredRequests = useMemo(() => {
    const rows = dataset?.requests || [];
    return rows.filter(row => inRequestTimeRange(row, filters)
      && (filters.device==='all' || row.device===filters.device)
      && (filters.tool==='all' || row.tool===filters.tool)
      && (filters.model==='all' || row.model===filters.model)
      && (filters.vendor==='all' || row.vendor===filters.vendor)
      && (filters.routeProvider==='all' || row.routeProvider===filters.routeProvider)
      && (filters.routeType==='all' || row.routeType===filters.routeType)
      && (filters.rawProvider==='all' || row.rawProvider===filters.rawProvider)
      && (filters.tier==='all' || row.tier===filters.tier));
  }, [dataset, filters]);

  const deviceRows = useMemo(() => devices(filtered), [filtered]);'''
s = replace_once(s, filtered_anchor, filtered_request, 'filtered requests')
# auto poll after theme/sidebar effects
poll_anchor = '''  useEffect(() => { localStorage.setItem('usagemesh:sidebar', isSidebarCollapsed ? 'collapsed' : 'expanded'); }, [isSidebarCollapsed]);
  useEffect(() => {'''
poll_new = '''  useEffect(() => { localStorage.setItem('usagemesh:sidebar', isSidebarCollapsed ? 'collapsed' : 'expanded'); }, [isSidebarCollapsed]);
  useEffect(() => {
    if (!workspaceKeyValue) return;
    let cancelled = false;
    let busy = false;
    const timer = window.setInterval(async () => {
      if (cancelled || busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const next = await loadDashboardWithKey(repoFromLocation(), workspaceKeyValue);
        if (!cancelled) { setDataset(next); setSyncStatus('synced'); }
      } catch {
        // Keep the last good snapshot; transient raw.githubusercontent failures
        // should not blank a live dashboard.
      } finally { busy = false; }
    }, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workspaceKeyValue]);
  useEffect(() => {'''
s = replace_once(s, poll_anchor, poll_new, 'dashboard live poll')
s = replace_once(s, '<UsageAnalysisView isDarkMode={isDarkMode} records={filtered} />', '<UsageAnalysisView isDarkMode={isDarkMode} records={filtered} requests={filteredRequests} />', 'analysis feed prop')
p.write_text(s)

# ---- versions + docs ----
p = Path('rust-cli/Cargo.toml')
s = p.read_text().replace('version = "2.0.3"', 'version = "2.1.0"', 1)
p.write_text(s)
p = Path('Cargo.lock')
s = p.read_text().replace('name = "usagemesh"\nversion = "2.0.3"', 'name = "usagemesh"\nversion = "2.1.0"', 1)
p.write_text(s)
p = Path('web-ui/package.json')
s = p.read_text().replace('"version": "2.0.0"', '"version": "2.1.0"', 1)
p.write_text(s)

p = Path('README.md')
s = p.read_text()
s = s.replace('installs the native scheduler at a **one-minute cadence** unless you pass `--no-schedule`.', 'installs the native scheduler at a **30-second cadence** unless you pass `--no-schedule`.')
s = s.replace('UsageMesh now standardizes scheduled refreshes at **once per minute**; existing scheduled installations migrate to that cadence automatically, while `--no-schedule` installations remain unscheduled.', 'UsageMesh now standardizes scheduled refreshes at **every 30 seconds**; existing scheduled installations migrate automatically, while `--no-schedule` installations remain unscheduled. Overlap protection prevents a slow scan from piling up concurrent sync processes.')
s = s.replace('**Analysis** is a diagnostic workbench rather than a duplicate overview. It focuses on cache efficiency, average request size/cost, top-contributor concentration, configurable contribution dimensions, a device × model matrix, and high-consumption device/model/client/tier combinations.', '**Analysis** is a diagnostic workbench rather than a duplicate overview. It includes a near-real-time request feed with exact request time, model, speed/tier, reasoning effort when available, token buckets, duration when the source records it, and per-request estimated cost, plus cache efficiency, concentration, contribution dimensions, a device × model matrix, and high-consumption combinations.')
p.write_text(s)

p = Path('README.zh-CN.md')
s = p.read_text()
s = s.replace('默认 **每 1 分钟同步一次**。', '默认 **每 30 秒同步一次**。')
s = s.replace('UsageMesh 现在统一为 **每 1 分钟同步一次**；已有定时安装会自动迁移到 1 分钟周期，而使用 `--no-schedule` 的设备仍保持不创建定时任务。', 'UsageMesh 现在统一为 **每 30 秒同步一次**；已有定时安装会自动迁移到 30 秒周期，而使用 `--no-schedule` 的设备仍保持不创建定时任务。若一次扫描超过 30 秒，进程锁会跳过重叠 tick，不会堆积多个扫描进程。')
s = s.replace('**分析工作台**不再重复概览数字，而是提供缓存命中率、平均 Tokens/请求、平均费用、TOP3 集中度、模型/设备/客户端/模式/路由贡献、设备 × 模型矩阵和高消耗组合，用来定位“哪里消耗最多”和“为什么”。', '**分析工作台**不再重复概览数字，而是新增近实时“请求明细”：展示每条可解析请求的具体时间、设备、客户端、模型、路由、速率/Tier、思考强度（来源有记录时）、输入/缓存/输出/Reasoning Tokens、耗时（来源有记录时）以及请求级费用估算；同时保留缓存命中率、TOP3 集中度、贡献分析、设备 × 模型矩阵和高消耗组合。')
p.write_text(s)
