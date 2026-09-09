use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use super::store::Paths;

const TOTAL_TIMEOUT: Duration = Duration::from_secs(25);
const INIT_TIMEOUT: Duration = Duration::from_secs(5);
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(5);
const LIMITS_TIMEOUT: Duration = Duration::from_secs(8);
const USAGE_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

pub struct OfficialSnapshot {
    pub account_key: String,
    pub account_label: String,
    pub quotas: Vec<Value>,
    pub usage: Value,
}

#[derive(Clone)]
struct AccountIdentity {
    key: String,
    label: String,
    plan_type: Option<String>,
    stable_id: Option<String>,
}

enum ReaderEvent {
    Message(Value),
    Failure(&'static str),
    Eof,
}

struct AppServer {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<ReaderEvent>,
    reader: Option<JoinHandle<()>>,
}

impl AppServer {
    fn spawn(paths: &Paths) -> Result<Self> {
        let mut command = Command::new("codex");
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if paths.isolated {
            command.env("CODEX_HOME", &paths.codex);
        }
        Self::spawn_command(command)
    }

    fn spawn_command(mut command: Command) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = command.spawn().context("未找到可用的 Codex App Server")?;
        let stdin = child.stdin.take().context("Codex App Server 输入不可用")?;
        let stdout = child.stdout.take().context("Codex App Server 输出不可用")?;
        let (sender, events) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut total = 0usize;
            loop {
                let line = match read_bounded_line(&mut reader, MAX_LINE_BYTES) {
                    Ok(Some(line)) => line,
                    Ok(None) => {
                        let _ = sender.send(ReaderEvent::Eof);
                        return;
                    }
                    Err(()) => {
                        let _ = sender.send(ReaderEvent::Failure(
                            "Codex App Server 单行输出超过安全上限",
                        ));
                        return;
                    }
                };
                total = match total.checked_add(line.len()) {
                    Some(value) if value <= MAX_OUTPUT_BYTES => value,
                    _ => {
                        let _ = sender
                            .send(ReaderEvent::Failure("Codex App Server 总输出超过安全上限"));
                        return;
                    }
                };
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                if line
                    .iter()
                    .copied()
                    .find(|byte| !byte.is_ascii_whitespace())
                    != Some(b'{')
                {
                    continue;
                }
                let Ok(message) = serde_json::from_slice(&line) else {
                    let _ = sender.send(ReaderEvent::Failure(
                        "Codex App Server 返回了无法识别的数据",
                    ));
                    return;
                };
                if sender.send(ReaderEvent::Message(message)).is_err() {
                    return;
                }
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            events,
            reader: Some(reader),
        })
    }

    fn send(&mut self, message: &Value) -> Result<()> {
        let stdin = self.stdin.as_mut().context("Codex App Server 连接已关闭")?;
        serde_json::to_writer(&mut *stdin, message).context("无法发送 Codex App Server 请求")?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .context("无法发送 Codex App Server 请求")
    }

    fn request(
        &mut self,
        id: i64,
        method: &str,
        params: Option<Value>,
        deadline: Instant,
    ) -> Result<Value> {
        let mut request = Map::new();
        request.insert("method".into(), Value::String(method.into()));
        request.insert("id".into(), json!(id));
        if let Some(params) = params {
            request.insert("params".into(), params);
        }
        self.send(&Value::Object(request))?;
        wait_for_response(&self.events, id, deadline)
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.stdin.take();
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Dropping a JoinHandle detaches it. Do not join here: a misbehaving
        // descendant may inherit stdout and keep the reader blocked after the
        // direct child exits. Unix kills the whole process group above; Windows
        // asks taskkill to terminate the tree.
        self.reader.take();
    }
}

pub fn fetch(paths: &Paths) -> Result<OfficialSnapshot> {
    let overall = Instant::now() + TOTAL_TIMEOUT;
    let mut server = AppServer::spawn(paths)?;

    let initialized = server.request(
        1,
        "initialize",
        Some(json!({
            "clientInfo": {
                "name": "usagemesh",
                "title": "UsageMesh",
                "version": env!("CARGO_PKG_VERSION")
            }
        })),
        step_deadline(overall, INIT_TIMEOUT)?,
    )?;
    response_result(&initialized, "Codex App Server 初始化失败")?;
    server.send(&json!({"method":"initialized","params":{}}))?;

    let first_account = server.request(
        2,
        "account/read",
        Some(json!({"refreshToken":false})),
        step_deadline(overall, ACCOUNT_TIMEOUT)?,
    )?;
    let first_account = parse_account(response_result(
        &first_account,
        "无法读取 Codex ChatGPT 账号",
    )?)?;

    let limits = server.request(
        3,
        "account/rateLimits/read",
        None,
        step_deadline(overall, LIMITS_TIMEOUT)?,
    )?;
    let limits = response_result(&limits, "无法读取 ChatGPT 订阅额度")?.clone();

    let usage_deadline = step_deadline(overall, USAGE_TIMEOUT)?;
    let usage_result = server
        .request(4, "account/usage/read", None, usage_deadline)
        .ok()
        .and_then(|response| response_result(&response, "").ok().cloned());

    let final_account = server.request(
        5,
        "account/read",
        Some(json!({"refreshToken":false})),
        step_deadline(overall, ACCOUNT_TIMEOUT)?,
    )?;
    let final_account = parse_account(response_result(
        &final_account,
        "无法复核 Codex ChatGPT 账号",
    )?)?;
    if first_account.key != final_account.key {
        bail!("读取期间 ChatGPT 账号发生变化，请重试")
    }

    let limits_account_id = limits_account_id(&limits)?;
    for account in [&first_account, &final_account] {
        if account
            .stable_id
            .as_deref()
            .zip(limits_account_id.as_deref())
            .is_some_and(|(left, right)| left != right)
        {
            bail!("额度与 ChatGPT 账号不匹配，请重试")
        }
    }
    let account_key = limits_account_id
        .as_deref()
        .map(|value| hash_account_identifier("id", value))
        .unwrap_or_else(|| final_account.key.clone());
    let mut final_account = final_account;
    final_account.key = account_key.clone();

    let updated_at = chrono::Utc::now().to_rfc3339();
    let quotas = parse_quotas(&limits, &final_account, &updated_at)?;
    let usage = match usage_result {
        Some(result) => parse_usage(&result, &final_account.key, &updated_at),
        None => unavailable_usage(&final_account.key, &updated_at),
    };
    Ok(OfficialSnapshot {
        account_key,
        account_label: final_account.label,
        quotas,
        usage,
    })
}

fn step_deadline(overall: Instant, allowance: Duration) -> Result<Instant> {
    let now = Instant::now();
    if now >= overall {
        bail!("读取 Codex 官方额度超时")
    }
    Ok(std::cmp::min(overall, now + allowance))
}

fn wait_for_response(events: &Receiver<ReaderEvent>, id: i64, deadline: Instant) -> Result<Value> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("Codex App Server 响应超时")?;
        match events.recv_timeout(remaining) {
            Ok(ReaderEvent::Message(message)) => {
                if message.get("method").is_none()
                    && message.get("id").and_then(Value::as_i64) == Some(id)
                {
                    return Ok(message);
                }
            }
            Ok(ReaderEvent::Failure(message)) => bail!(message),
            Ok(ReaderEvent::Eof) => bail!("Codex App Server 提前关闭"),
            Err(RecvTimeoutError::Timeout) => bail!("Codex App Server 响应超时"),
            Err(RecvTimeoutError::Disconnected) => bail!("Codex App Server 连接中断"),
        }
    }
}

fn response_result<'a>(response: &'a Value, message: &'static str) -> Result<&'a Value> {
    if response.get("error").is_some_and(|value| !value.is_null()) {
        bail!(if message.is_empty() {
            "Codex App Server 请求失败"
        } else {
            message
        })
    }
    response.get("result").context(if message.is_empty() {
        "Codex App Server 响应缺少结果"
    } else {
        message
    })
}

fn parse_account(result: &Value) -> Result<AccountIdentity> {
    let account = result
        .get("account")
        .and_then(Value::as_object)
        .context("Codex 当前未登录 ChatGPT 账号")?;
    account
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| matches!(*value, "chatgpt" | "chatgptAuthTokens"))
        .context("Codex 当前不是 ChatGPT 订阅账号")?;
    let identifier = ["accountId", "chatgptAccountId", "id", "email"]
        .iter()
        .find_map(|key| {
            account
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 1024)
                .map(|value| (*key, value))
        })
        .context("ChatGPT 账号缺少可核验标识")?;
    let normalized_identifier = if identifier.0 == "email" {
        identifier.1.to_ascii_lowercase()
    } else {
        identifier.1.to_string()
    };
    let identifier_kind = if identifier.0 == "email" {
        "email"
    } else {
        "id"
    };
    let plan_type = safe_plan_type(account.get("planType").and_then(Value::as_str));
    let label = match plan_type.as_deref().and_then(plan_label) {
        Some(plan) => format!("ChatGPT · {plan}"),
        None => "ChatGPT".into(),
    };
    Ok(AccountIdentity {
        key: hash_account_identifier(identifier_kind, &normalized_identifier),
        label,
        plan_type,
        stable_id: (identifier_kind == "id").then_some(normalized_identifier),
    })
}

fn hash_account_identifier(kind: &str, identifier: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"usagemesh:codex-account:v1\0");
    digest.update(kind.as_bytes());
    digest.update(b"\0");
    digest.update(identifier.as_bytes());
    hex::encode(digest.finalize())
}

fn limits_account_id(result: &Value) -> Result<Option<String>> {
    let mut ids = Vec::new();
    let values = std::iter::once(result)
        .chain(result.get("rateLimits"))
        .chain(
            result
                .get("rateLimitsByLimitId")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|map| map.values()),
        );
    for value in values {
        if let Some(id) = ["accountId", "chatgptAccountId"]
            .iter()
            .find_map(|key| value.get(*key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 1024)
        {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    ids.dedup();
    if ids.len() > 1 {
        bail!("官方额度返回了不一致的账号标识")
    }
    Ok(ids.pop())
}

fn safe_plan_type(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .map(str::to_string)
}

fn plan_label(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "free" => Some("Free"),
        "plus" => Some("Plus"),
        "pro" => Some("Pro"),
        "team" => Some("Team"),
        "business" => Some("Business"),
        "enterprise" => Some("Enterprise"),
        "edu" => Some("Edu"),
        _ => None,
    }
}

fn parse_quotas(result: &Value, account: &AccountIdentity, updated_at: &str) -> Result<Vec<Value>> {
    let buckets: Vec<(String, &Value)> = if let Some(value) = result.get("rateLimitsByLimitId") {
        value
            .as_object()
            .map(|map| {
                let mut rows: Vec<_> = map.iter().map(|(id, value)| (id.clone(), value)).collect();
                rows.sort_by(|left, right| left.0.cmp(&right.0));
                rows
            })
            .unwrap_or_default()
    } else {
        result
            .get("rateLimits")
            .filter(|value| value.is_object())
            .map(|value| {
                let id = value
                    .get("limitId")
                    .and_then(Value::as_str)
                    .unwrap_or("codex")
                    .to_string();
                vec![(id, value)]
            })
            .unwrap_or_default()
    };

    let quotas: Vec<_> = buckets
        .into_iter()
        .filter_map(|(map_id, bucket)| parse_quota_bucket(&map_id, bucket, account, updated_at))
        .collect();
    if quotas.is_empty() {
        bail!("官方接口未返回可识别的 ChatGPT 额度窗口")
    }
    Ok(quotas)
}

fn parse_quota_bucket(
    map_id: &str,
    bucket: &Value,
    account: &AccountIdentity,
    updated_at: &str,
) -> Option<Value> {
    let limit_id = bucket
        .get("limitId")
        .and_then(Value::as_str)
        .unwrap_or(map_id)
        .trim();
    if limit_id.is_empty() || limit_id.len() > 128 {
        return None;
    }
    let windows: Vec<_> = ["primary", "secondary", "tertiary"]
        .iter()
        .filter_map(|name| parse_window(name, bucket.get(*name)?))
        .collect();
    if windows.is_empty() {
        return None;
    }
    let limit_name = bucket
        .get("limitName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 160);
    let plan_type = safe_plan_type(bucket.get("planType").and_then(Value::as_str))
        .or_else(|| account.plan_type.clone());
    Some(json!({
        "provider": "codex",
        "source": "codex-app-server",
        "accountKey": account.key,
        "account": account.label,
        "limitId": limit_id,
        "limitName": limit_name,
        "planType": plan_type,
        "updatedAt": updated_at,
        "status": "observed",
        "windows": windows,
        "note": "Codex App Server 返回的 ChatGPT 订阅额度快照；已用比例是当前窗口累计值，不代表 Token 数。"
    }))
}

fn parse_window(name: &str, window: &Value) -> Option<Value> {
    let used = window
        .get("usedPercent")
        .or_else(|| window.get("used_percent"))?
        .as_f64()
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))?;
    let duration = window
        .get("windowDurationMins")
        .or_else(|| window.get("windowMinutes"))
        .or_else(|| window.get("window_minutes"))
        .and_then(positive_integer);
    let resets_at = window
        .get("resetsAt")
        .or_else(|| window.get("resets_at"))
        .and_then(normalize_timestamp);
    Some(json!({
        "name": name,
        "usedPercent": used,
        "remainingPercent": 100.0 - used,
        "resetsAt": resets_at,
        "windowMinutes": duration
    }))
}

fn positive_integer(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_u64() {
        return (value > 0 && value <= 525_600).then_some(value);
    }
    let value = value.as_f64()?;
    (value.is_finite() && value > 0.0 && value <= 525_600.0 && value.fract() == 0.0)
        .then_some(value as u64)
}

fn normalize_timestamp(value: &Value) -> Option<String> {
    if let Some(raw) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(timestamp) = raw.parse::<i64>() {
            return timestamp_to_rfc3339(timestamp);
        }
        return chrono::DateTime::parse_from_rfc3339(raw)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&chrono::Utc).to_rfc3339());
    }
    let timestamp = value.as_i64().or_else(|| {
        let number = value.as_f64()?;
        (number.is_finite()
            && number >= i64::MIN as f64
            && number <= i64::MAX as f64
            && number.fract() == 0.0)
            .then_some(number as i64)
    })?;
    timestamp_to_rfc3339(timestamp)
}

fn timestamp_to_rfc3339(mut timestamp: i64) -> Option<String> {
    if timestamp.unsigned_abs() >= 100_000_000_000 {
        timestamp /= 1000;
    }
    chrono::DateTime::from_timestamp(timestamp, 0).map(|value| value.to_rfc3339())
}

fn parse_usage(result: &Value, account_key: &str, updated_at: &str) -> Value {
    let summary = result.get("summary").unwrap_or(&Value::Null);
    let summary = json!({
        "lifetimeTokens": nonnegative_integer(summary.get("lifetimeTokens")),
        "peakDailyTokens": nonnegative_integer(summary.get("peakDailyTokens")),
        "longestRunningTurnSec": nonnegative_integer(summary.get("longestRunningTurnSec")),
        "currentStreakDays": nonnegative_integer(summary.get("currentStreakDays")),
        "longestStreakDays": nonnegative_integer(summary.get("longestStreakDays"))
    });
    let daily = result
        .get("dailyUsageBuckets")
        .and_then(Value::as_array)
        .map(|rows| {
            let mut unique = BTreeMap::new();
            for row in rows {
                let Some(date) = row.get("startDate").and_then(Value::as_str) else {
                    continue;
                };
                if !strict_date(date) {
                    continue;
                }
                let Some(tokens) = nonnegative_integer(row.get("tokens")) else {
                    continue;
                };
                // A duplicate date is treated as duplicate source data, not
                // additive usage. The last documented bucket wins.
                unique.insert(date.to_string(), tokens);
            }
            unique
                .into_iter()
                .map(|(start_date, tokens)| json!({"startDate":start_date,"tokens":tokens}))
                .collect::<Vec<_>>()
        });
    json!({
        "accountKey": account_key,
        "updatedAt": updated_at,
        "summary": summary,
        "dailyUsageBuckets": daily,
        "status": "observed"
    })
}

fn unavailable_usage(account_key: &str, updated_at: &str) -> Value {
    json!({
        "accountKey": account_key,
        "updatedAt": updated_at,
        "summary": {
            "lifetimeTokens": null,
            "peakDailyTokens": null,
            "longestRunningTurnSec": null,
            "currentStreakDays": null,
            "longestStreakDays": null
        },
        "dailyUsageBuckets": null,
        "status": "unavailable",
        "error": "官方 Token 活动暂时不可用"
    })
}

fn nonnegative_integer(value: Option<&Value>) -> Option<u64> {
    value?.as_u64()
}

fn strict_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    max: usize,
) -> std::result::Result<Option<Vec<u8>>, ()> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| ())?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(length) > max {
            return Err(());
        }
        line.extend_from_slice(&available[..length]);
        reader.consume(length);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Cursor};

    fn account() -> AccountIdentity {
        parse_account(
            &json!({"account":{"type":"chatgpt","email":"USER@example.com","planType":"pro"}}),
        )
        .unwrap()
    }

    #[test]
    fn account_key_is_private_and_stable() {
        let first = account();
        let second = parse_account(&json!({"account":{"type":"chatgptAuthTokens","accountId":"  ","email":"user@example.com","planType":"pro"}})).unwrap();
        assert_eq!(first.key, second.key);
        assert_eq!(first.label, "ChatGPT · Pro");
        assert!(!first.key.contains("example"));
        assert!(parse_account(&json!({"account":{"type":"apiKey","id":"a"}})).is_err());
        assert!(parse_account(&json!({"account":{"type":"chatgpt"}})).is_err());
    }

    #[test]
    fn multi_bucket_view_is_authoritative_and_preserves_limit_ids() {
        let result = json!({
            "rateLimits": {"limitId":"legacy","primary":{"usedPercent":99}},
            "rateLimitsByLimitId": {
                "codex": {"limitId":"codex","primary":{"usedPercent":30,"windowDurationMins":10080,"resetsAt":1789445113}},
                "codex_spark": {"limitName":"Spark","primary":{"usedPercent":5,"windowDurationMins":300,"resetsAt":"2026-09-09T12:00:00Z"}}
            }
        });
        let rows = parse_quotas(&result, &account(), "2026-09-09T00:00:00Z").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["limitId"], "codex");
        assert_eq!(rows[0]["windows"][0]["usedPercent"], 30.0);
        assert_eq!(rows[0]["windows"][0]["windowMinutes"], 10080);
        assert_eq!(rows[1]["limitId"], "codex_spark");
        assert!(rows.iter().all(|row| row["limitId"] != "legacy"));
    }

    #[test]
    fn empty_multi_bucket_never_falls_back_to_legacy() {
        let result = json!({
            "rateLimits": {"limitId":"legacy","primary":{"usedPercent":99}},
            "rateLimitsByLimitId": {}
        });
        assert!(parse_quotas(&result, &account(), "2026-09-09T00:00:00Z").is_err());
    }

    #[test]
    fn legacy_bucket_and_timestamp_variants_are_normalized() {
        let result = json!({
            "rateLimits": {
                "limitId":"codex",
                "primary":{"usedPercent":25.5,"windowDurationMins":300,"resetsAt":"1789445113000"},
                "secondary":{"usedPercent":101,"windowDurationMins":0,"resetsAt":"invalid"}
            }
        });
        let rows = parse_quotas(&result, &account(), "2026-09-09T00:00:00Z").unwrap();
        assert_eq!(rows[0]["windows"].as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["windows"][0]["remainingPercent"], 74.5);
        assert!(rows[0]["windows"][0]["resetsAt"]
            .as_str()
            .unwrap()
            .starts_with("2026-"));
    }

    #[test]
    fn usage_keeps_only_documented_valid_fields() {
        let usage = parse_usage(
            &json!({
                "summary":{"lifetimeTokens":123,"peakDailyTokens":null,"secret":"discard"},
                "dailyUsageBuckets":[
                    {"startDate":"2026-09-09","tokens":30},
                    {"startDate":"2026-09-08","tokens":10,"extra":"discard"},
                    {"startDate":"bad","tokens":20},
                    {"startDate":"2026-09-09","tokens":40},
                    {"startDate":"2026-9-10","tokens":50}
                ]
            }),
            "account-key",
            "2026-09-09T00:00:00Z",
        );
        assert_eq!(usage["summary"]["lifetimeTokens"], 123);
        assert!(usage["summary"].get("secret").is_none());
        assert_eq!(usage["dailyUsageBuckets"].as_array().unwrap().len(), 2);
        assert_eq!(usage["dailyUsageBuckets"][0]["startDate"], "2026-09-08");
        assert_eq!(usage["dailyUsageBuckets"][1]["tokens"], 40);
        assert!(usage["dailyUsageBuckets"][0].get("extra").is_none());
    }

    fn helper_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("fake_app_server_helper")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env("USAGEMESH_FAKE_APP_SERVER", mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn fake_app_server_helper() {
        let Ok(mode) = std::env::var("USAGEMESH_FAKE_APP_SERVER") else {
            return;
        };
        let input = std::io::stdin();
        let mut output = std::io::stdout().lock();
        // libtest may have printed a test-name prefix without a newline.
        writeln!(output).unwrap();
        output.flush().unwrap();
        for line in input.lock().lines().map_while(std::io::Result::ok) {
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = request.get("id").and_then(Value::as_i64) else {
                continue;
            };
            if mode == "exit" {
                return;
            }
            if mode == "timeout" {
                std::thread::sleep(Duration::from_secs(60));
                return;
            }
            if request.get("method").and_then(Value::as_str) == Some("initialize") {
                writeln!(
                    output,
                    "{}",
                    json!({"method":"account/rateLimits/updated","params":{}})
                )
                .unwrap();
            }
            let result = match request.get("method").and_then(Value::as_str) {
                Some("initialize") => json!({"serverInfo":{"name":"fake"}}),
                Some("account/read") => json!({
                    "account":{"type":"chatgpt","id":"account-1","planType":"pro"},
                    "requiresOpenaiAuth":true
                }),
                Some("account/rateLimits/read") => json!({
                    "accountId":"account-1",
                    "rateLimitsByLimitId":{
                        "codex":{"limitId":"codex","primary":{"usedPercent":30,"windowDurationMins":10080,"resetsAt":1789445113}}
                    }
                }),
                Some("account/usage/read") => json!({
                    "summary":{"lifetimeTokens":100},
                    "dailyUsageBuckets":[{"startDate":"2026-09-09","tokens":10}]
                }),
                _ => json!({}),
            };
            writeln!(output, "{}", json!({"id":id,"result":result})).unwrap();
            output.flush().unwrap();
        }
    }

    #[test]
    fn simulated_stdio_process_handles_success_and_notifications() {
        let mut server = AppServer::spawn_command(helper_command("success")).unwrap();
        let deadline = || Instant::now() + Duration::from_secs(3);
        let initialized = server
            .request(1, "initialize", Some(json!({})), deadline())
            .unwrap();
        assert!(response_result(&initialized, "初始化失败").is_ok());
        server
            .send(&json!({"method":"initialized","params":{}}))
            .unwrap();
        let account_response = server
            .request(
                2,
                "account/read",
                Some(json!({"refreshToken":false})),
                deadline(),
            )
            .unwrap();
        let account =
            parse_account(response_result(&account_response, "账号失败").unwrap()).unwrap();
        let limits_response = server
            .request(3, "account/rateLimits/read", None, deadline())
            .unwrap();
        let limits = response_result(&limits_response, "额度失败").unwrap();
        assert_eq!(
            limits_account_id(limits).unwrap().as_deref(),
            Some("account-1")
        );
        assert_eq!(
            parse_quotas(limits, &account, "2026-09-09T00:00:00Z").unwrap()[0]["limitId"],
            "codex"
        );
    }

    #[test]
    fn simulated_stdio_exit_and_timeout_are_bounded() {
        let mut exited = AppServer::spawn_command(helper_command("exit")).unwrap();
        let error = exited
            .request(
                1,
                "initialize",
                Some(json!({})),
                Instant::now() + Duration::from_secs(3),
            )
            .unwrap_err();
        assert!(error.to_string().contains("关闭") || error.to_string().contains("中断"));
        drop(exited);

        let started = Instant::now();
        let mut timed_out = AppServer::spawn_command(helper_command("timeout")).unwrap();
        let error = timed_out
            .request(
                1,
                "initialize",
                Some(json!({})),
                Instant::now() + Duration::from_millis(30),
            )
            .unwrap_err();
        assert!(error.to_string().contains("超时"));
        drop(timed_out);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    #[ignore = "requires an installed, logged-in Codex App Server"]
    fn installed_app_server_smoke_test() {
        let paths = Paths::new(None, None).unwrap();
        let snapshot = fetch(&paths).unwrap();
        assert_eq!(snapshot.account_key.len(), 64);
        assert!(snapshot.account_label.starts_with("ChatGPT"));
        assert!(!snapshot.quotas.is_empty());
        assert!(snapshot
            .quotas
            .iter()
            .all(|quota| quota["source"] == "codex-app-server"));
    }

    #[test]
    fn response_wait_ignores_notifications_and_times_out() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(ReaderEvent::Message(
                json!({"method":"account/updated","params":{}}),
            ))
            .unwrap();
        sender
            .send(ReaderEvent::Message(json!({"id":7,"result":{"ok":true}})))
            .unwrap();
        let response =
            wait_for_response(&receiver, 7, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(response["result"]["ok"], true);

        let (_sender, receiver) = mpsc::channel();
        let error =
            wait_for_response(&receiver, 8, Instant::now() + Duration::from_millis(1)).unwrap_err();
        assert!(error.to_string().contains("超时"));
    }

    #[test]
    fn bounded_reader_rejects_oversized_stdio_lines() {
        let mut valid = Cursor::new(b"{\"id\":1}\nnext\n".to_vec());
        assert_eq!(
            read_bounded_line(&mut valid, 32).unwrap().unwrap(),
            b"{\"id\":1}\n"
        );
        assert_eq!(
            read_bounded_line(&mut valid, 32).unwrap().unwrap(),
            b"next\n"
        );

        let mut oversized = Cursor::new(vec![b'x'; 33]);
        assert!(read_bounded_line(&mut oversized, 32).is_err());
    }
}
