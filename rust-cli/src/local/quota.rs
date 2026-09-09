use super::store::Paths;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use walkdir::WalkDir;

pub fn codex(paths: &Paths) -> Value {
    let mut files: Vec<_> = [
        paths.codex.join("sessions"),
        paths.codex.join("archived_sessions"),
    ]
    .into_iter()
    .flat_map(|root| {
        WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "jsonl")
            })
            .map(|e| e.into_path())
    })
    .collect();
    files.sort_by_key(|p| std::cmp::Reverse(p.metadata().ok().and_then(|m| m.modified().ok())));
    files.truncate(120);
    let mut latest = 0;
    let mut windows = Vec::new();
    let mut observed = String::new();
    for path in files {
        if let Ok(mut file) = File::open(path) {
            const TAIL_BYTES: u64 = 8 * 1024 * 1024;
            let start = file
                .metadata()
                .map(|m| m.len().saturating_sub(TAIL_BYTES))
                .unwrap_or(0);
            if file.seek(SeekFrom::Start(start)).is_err() {
                continue;
            }
            let mut reader = BufReader::new(file.take(TAIL_BYTES));
            if start > 0 {
                let mut partial = Vec::new();
                let _ = reader.read_until(b'\n', &mut partial);
            }
            for line in reader.split(b'\n').map_while(|r| r.ok()) {
                if line.len() > 2_000_000 {
                    continue;
                };
                let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if v["type"] != "event_msg" || v["payload"]["type"] != "token_count" {
                    continue;
                };
                let Some(limits) = v["payload"].get("rate_limits").filter(|v| v.is_object()) else {
                    continue;
                };
                let Some(stamp) = v["timestamp"].as_str() else {
                    continue;
                };
                let Ok(date) = chrono::DateTime::parse_from_rfc3339(stamp) else {
                    continue;
                };
                if date.timestamp_millis() < latest {
                    continue;
                };
                let parsed = parse_windows(limits);
                if parsed.is_empty() {
                    continue;
                };
                latest = date.timestamp_millis();
                observed = stamp.to_string();
                windows = parsed;
            }
        }
    }
    json!({"provider":"codex","source":"local-cli-telemetry","account":"本机最近记录，账号身份未核实","updatedAt":observed,"windows":windows,"status":if latest==0{"unavailable"}else{"observed"},"note":"CLI 记录的供应商额度快照，不是用 Token 推算。旧记录或过期窗口不能当作当前剩余额度。"})
}
fn parse_windows(v: &Value) -> Vec<Value> {
    ["primary", "secondary", "tertiary"].iter().filter_map(|k| {
        let w = &v[*k];
        let used = w["used_percent"].as_f64().or_else(|| w["usedPercent"].as_f64()).filter(|p| p.is_finite() && (0.0..=100.0).contains(p))?;
        let value = w.get("resets_at").or_else(||w.get("resetsAt"));
        let reset = value.and_then(|r| r.as_i64().and_then(|n|chrono::DateTime::from_timestamp(n,0)).map(|t|t.to_rfc3339()).or_else(||r.as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).map(|t|t.to_rfc3339())));
        let minutes = w.get("window_minutes").or_else(||w.get("windowMinutes")).or_else(||w.get("windowDurationMins")).and_then(Value::as_i64).filter(|n|(1..=525600).contains(n));
        Some(json!({"name":k,"usedPercent":used,"remainingPercent":100.0-used,"resetsAt":reset,"windowMinutes":minutes}))
    }).collect()
}
pub fn command_json(mut command: Command) -> Result<Value> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .context("未找到 CodexBar CLI；安装后重启 UsageMesh，或使用 Codex 本机额度记录")?;
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(4 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    let success = loop {
        if let Some(status) = child.try_wait()? {
            break status.success();
        };
        if start.elapsed() > Duration::from_secs(25) {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("额度读取超时（25 秒），请检查 CodexBar 登录状态")
        };
        std::thread::sleep(Duration::from_millis(50));
    };
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("读取额度失败"))??;
    if !success {
        anyhow::bail!("CodexBar 未成功读取额度，请在其本地界面检查账号授权")
    }
    serde_json::from_slice(&bytes).context("CodexBar 返回格式无法识别")
}
pub fn fetch_codexbar(provider: &str) -> Result<Value> {
    if !matches!(provider, "codex" | "claude" | "gemini") {
        anyhow::bail!("此连接器支持 Codex、Claude、Gemini")
    };
    let mut cmd = Command::new("codexbar");
    cmd.args(["usage", "--provider", provider, "--format", "json"]);
    let raw = command_json(cmd)?;
    let row = raw
        .as_array()
        .and_then(|a| a.iter().find(|r| r["provider"] == provider))
        .context("未返回此供应商额度")?;
    if row.get("error").is_some_and(|e| !e.is_null()) {
        anyhow::bail!("供应商额度读取失败，请在 CodexBar 中检查授权")
    }
    let usage = &row["usage"];
    let windows = parse_windows(usage);
    if windows.is_empty() {
        anyhow::bail!("来源未返回可识别的额度窗口")
    }
    Ok(
        json!({"provider":provider,"source":format!("codexbar:{}",row["source"].as_str().unwrap_or("unknown")),"account":"CodexBar 当前授权账号","updatedAt":usage["updatedAt"],"windows":windows,"status":"observed","note":"来源保留 CodexBar 的 source；若为 local/estimate，属于本地估计，不代表官方剩余额度。"}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_official_window_fields_and_large_log_tail() {
        let w = parse_windows(
            &json!({"primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1789445113}}),
        );
        assert_eq!(w[0]["windowMinutes"], 10080);
        assert!(w[0]["resetsAt"].as_str().unwrap().contains("2026-09-15"));
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(Some(dir.path().into()), None).unwrap();
        std::fs::create_dir_all(paths.codex.join("sessions")).unwrap();
        let mut file = File::create(paths.codex.join("sessions/large.jsonl")).unwrap();
        use std::io::Write;
        file.set_len(33 * 1024 * 1024).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        writeln!(file,"\n{}",json!({"timestamp":"2026-09-09T12:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42,"window_minutes":300}}}})).unwrap();
        assert_eq!(codex(&paths)["windows"][0]["usedPercent"], 42.);
    }
    #[test]
    fn percent_is_not_a_fraction() {
        let w = parse_windows(&json!({"primary":{"usedPercent":0.5}}));
        assert_eq!(w[0]["remainingPercent"], 99.5);
        assert!(parse_windows(&json!({"primary":{"usedPercent":101}})).is_empty());
    }
}
