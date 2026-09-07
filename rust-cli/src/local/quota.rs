use super::store::Paths;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
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
        if let Ok(file) = File::open(path) {
            for line in BufReader::new(file.take(32 * 1024 * 1024))
                .split(b'\n')
                .map_while(|r| r.ok())
            {
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
    ["primary","secondary","tertiary"].iter().filter_map(|k|{let w=&v[*k];let used=w["used_percent"].as_f64().or_else(||w["usedPercent"].as_f64()).filter(|p|p.is_finite()&&(0.0..=100.).contains(p))?;let reset=w["resets_at"].as_i64().and_then(|n|chrono::DateTime::from_timestamp(n,0)).map(|t|t.to_rfc3339()).or_else(||w["resetsAt"].as_str().map(String::from));Some(json!({"name":k,"usedPercent":used,"remainingPercent":100.-used,"resetsAt":reset,"windowMinutes":w.get("window_minutes").or_else(||w.get("windowMinutes"))}))}).collect()
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
    fn percent_is_not_a_fraction() {
        let w = parse_windows(&json!({"primary":{"usedPercent":0.5}}));
        assert_eq!(w[0]["remainingPercent"], 99.5);
        assert!(parse_windows(&json!({"primary":{"usedPercent":101}})).is_empty());
    }
}
