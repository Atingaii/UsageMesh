//! Observed quota history. Percentages are snapshots, never additive usage.
use super::store::{digest, load, private_write, Paths};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs::File};

const MAX_CYCLES: usize = 400;
const MAX_SAMPLES: usize = 256;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: String,
    pub used_percent: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycle {
    pub id: String,
    pub account_key: String,
    pub account: String,
    pub limit_id: String,
    pub limit_name: String,
    pub window_name: String,
    pub window_minutes: i64,
    pub resets_at: String,
    pub nominal_start_at: String,
    pub first_observed_at: String,
    pub last_observed_at: String,
    pub first_used_percent: f64,
    pub last_used_percent: f64,
    pub samples: Vec<Sample>,
    pub closed_at: Option<String>,
    pub closure_reason: Option<String>,
    pub segment: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct History {
    pub version: u32,
    pub cycles: Vec<Cycle>,
    pub latest: Vec<Value>,
    pub official_usage: Value,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
}
impl Default for History {
    fn default() -> Self {
        Self {
            version: 1,
            cycles: vec![],
            latest: vec![],
            official_usage: Value::Null,
            last_success_at: None,
            last_attempt_at: None,
        }
    }
}
fn stamp(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|v| v.with_timezone(&Utc))
}
fn has_nonzero_observation(cycle: &Cycle) -> bool {
    cycle.first_used_percent > 0.0
        || cycle.last_used_percent > 0.0
        || cycle.samples.iter().any(|sample| sample.used_percent > 0.0)
}
fn merge_usage(previous: &Value, incoming: Value) -> Value {
    if incoming["status"] != "unavailable" {
        return incoming;
    }
    let same_account = incoming["accountKey"]
        .as_str()
        .zip(previous["accountKey"].as_str())
        .is_some_and(|(incoming, previous)| !incoming.is_empty() && incoming == previous);
    let has_cached_observation = matches!(previous["status"].as_str(), Some("observed" | "stale"));
    if same_account && has_cached_observation {
        let mut preserved = previous.clone();
        preserved["status"] = json!("stale");
        preserved["error"] = json!("官方 Token 活动暂时不可用，显示上次成功快照");
        return preserved;
    }
    incoming
}
impl History {
    pub fn read(paths: &Paths) -> Result<Self> {
        let h: Self = load(&paths.data.join("quota-history.json"))?;
        anyhow::ensure!(h.version == 1, "额度历史版本不支持，已保留原文件");
        Ok(h)
    }
    pub fn save(&self, paths: &Paths) -> Result<()> {
        private_write(
            &paths.data.join("quota-history.json"),
            &serde_json::to_vec(self)?,
        )
    }
    pub fn public_history(&self) -> Value {
        let mut cycles = self.cycles.clone();
        cycles.sort_by_key(|c| std::cmp::Reverse(stamp(&c.last_observed_at)));
        cycles.truncate(200);
        json!({"version":1,"cycles":cycles})
    }
    pub fn export(&self) -> Value {
        let mut v = self.public_history();
        v["latest"] = json!(self.latest);
        v["officialUsage"] = self.official_usage.clone();
        v
    }
    pub fn record(&mut self, quotas: Vec<Value>, usage: Value, now: DateTime<Utc>) {
        // A zero-usage rolling window has no stable boundary: some App Server
        // buckets advertise `resetsAt = observedAt + windowDuration` until their
        // first use. Keep those moving values in `latest`, not historical cycles.
        // This also removes zero-only cycles created by older versions while
        // preserving every cycle that ever had a non-zero observation.
        self.cycles.retain(has_nonzero_observation);
        for q in &quotas {
            let (Some(account), Some(limit), Some(observed), Some(windows)) = (
                q["accountKey"].as_str(),
                q["limitId"].as_str(),
                q["updatedAt"].as_str().and_then(stamp),
                q["windows"].as_array(),
            ) else {
                continue;
            };
            if account.is_empty()
                || q["source"] != "codex-app-server"
                || observed > now + Duration::minutes(2)
            {
                continue;
            }
            for w in windows {
                let (Some(name), Some(minutes), Some(reset), Some(used)) = (
                    w["name"].as_str(),
                    w["windowMinutes"].as_i64(),
                    w["resetsAt"].as_str().and_then(stamp),
                    w["usedPercent"].as_f64(),
                ) else {
                    continue;
                };
                if !(1..=525600).contains(&minutes)
                    || !used.is_finite()
                    || !(0.0..=100.0).contains(&used)
                    || reset <= observed
                {
                    continue;
                }
                let Some(start) = reset.checked_sub_signed(Duration::minutes(minutes)) else {
                    continue;
                };
                // An old server value or a reset far outside its advertised window is not a new cycle.
                if start > observed + Duration::minutes(2) {
                    continue;
                }
                let recent = self
                    .cycles
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| {
                        c.account_key == account && c.limit_id == limit && c.window_name == name
                    })
                    .max_by_key(|(_, c)| stamp(&c.last_observed_at))
                    .map(|(i, _)| i);
                if recent.is_some_and(|i| {
                    stamp(&self.cycles[i].last_observed_at).is_some_and(|t| observed <= t)
                }) {
                    continue;
                }
                if used == 0.0 {
                    if let Some(i) = recent {
                        let c = &mut self.cycles[i];
                        if c.closed_at.is_none()
                            && (stamp(&c.resets_at) != Some(reset) || c.last_used_percent > 0.0)
                        {
                            let same_end = stamp(&c.resets_at) == Some(reset);
                            c.closed_at = Some(observed.to_rfc3339());
                            c.closure_reason = Some(
                                if same_end {
                                    "reset-adjustment"
                                } else {
                                    "window-changed"
                                }
                                .into(),
                            );
                        }
                    }
                    continue;
                }
                let mut segment = 0;
                let mut existing = None;
                if let Some(i) = recent {
                    let c = &mut self.cycles[i];
                    if stamp(&c.last_observed_at).is_some_and(|t| observed <= t) {
                        continue;
                    }
                    if stamp(&c.resets_at) == Some(reset)
                        && c.window_minutes == minutes
                        && c.closed_at.is_none()
                        && used >= c.last_used_percent
                    {
                        existing = Some(i);
                    } else {
                        let same_end = stamp(&c.resets_at) == Some(reset);
                        if same_end {
                            segment = c.segment.saturating_add(1);
                        }
                        if c.closed_at.is_none() {
                            c.closed_at = Some(observed.to_rfc3339());
                            c.closure_reason = Some(
                                if same_end {
                                    "reset-adjustment"
                                } else {
                                    "window-changed"
                                }
                                .into(),
                            );
                        }
                    }
                }
                let at = observed.to_rfc3339();
                if let Some(i) = existing {
                    let c = &mut self.cycles[i];
                    c.last_observed_at = at.clone();
                    c.last_used_percent = used;
                    c.samples.push(Sample {
                        at,
                        used_percent: used,
                    });
                    if c.samples.len() > MAX_SAMPLES {
                        // Thin the interior evenly, retaining the first and latest observed point.
                        let last = c.samples.len() - 1;
                        c.samples = c
                            .samples
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| *i == 0 || *i == last || i % 2 == 0)
                            .map(|(_, s)| s.clone())
                            .collect();
                    }
                } else {
                    let id = digest(
                        format!(
                            "{account}:{limit}:{name}:{}:{minutes}:{segment}",
                            reset.timestamp()
                        )
                        .as_bytes(),
                    );
                    self.cycles.push(Cycle {
                        id,
                        account_key: account.into(),
                        account: q["account"].as_str().unwrap_or("ChatGPT").into(),
                        limit_id: limit.into(),
                        limit_name: q["limitName"].as_str().unwrap_or(limit).into(),
                        window_name: name.into(),
                        window_minutes: minutes,
                        resets_at: reset.to_rfc3339(),
                        nominal_start_at: start.to_rfc3339(),
                        first_observed_at: at.clone(),
                        last_observed_at: at.clone(),
                        first_used_percent: used,
                        last_used_percent: used,
                        samples: vec![Sample {
                            at,
                            used_percent: used,
                        }],
                        closed_at: None,
                        closure_reason: None,
                        segment,
                    });
                }
            }
        }
        self.cycles
            .retain(|c| stamp(&c.last_observed_at).is_some_and(|t| t >= now - Duration::days(90)));
        self.cycles
            .sort_by_key(|c| std::cmp::Reverse(stamp(&c.last_observed_at)));
        self.cycles.truncate(MAX_CYCLES);
        self.latest = quotas;
        self.official_usage = merge_usage(&self.official_usage, usage);
        let now = now.to_rfc3339();
        self.last_success_at = Some(now.clone());
        self.last_attempt_at = Some(now);
    }
}
/// OS-managed advisory lock is released even if a process crashes. Used by serve and sync.
pub fn lock(paths: &Paths) -> Result<File> {
    std::fs::create_dir_all(&paths.data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&paths.data, std::fs::Permissions::from_mode(0o700))?;
    }
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(paths.data.join("quota-history.lock"))?;
    file.try_lock()
        .context("另一个 UsageMesh 进程正在读取额度，请稍后刷新")?;
    Ok(file)
}
pub fn details(c: &Cycle, activity: &Value) -> Result<Value> {
    let rows = activity["requests"]
        .as_array()
        .context("请先扫描本机，再查看同期明细")?;
    let mut from = stamp(&c.nominal_start_at).context("周期起点无效")?;
    if c.segment > 0 {
        from = from.max(stamp(&c.first_observed_at).context("观测时间无效")?);
    }
    let mut to = stamp(&c.resets_at).context("周期终点无效")?;
    if let Some(closed) = c.closed_at.as_deref().and_then(stamp) {
        to = to.min(closed);
    }
    let mut tokens = 0i64;
    let mut requests = 0i64;
    let mut count = 0;
    let mut models: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    for r in rows {
        let Some(at) = r["at"].as_i64() else { continue };
        if at < from.timestamp_millis()
            || at >= to.timestamp_millis()
            || !r["client"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("codex"))
            || r["billingChannel"] != "official-subscription"
            || r["routeType"] != "official"
        {
            continue;
        }
        let t = r["tokens"].as_i64().unwrap_or(0).max(0);
        let n = r["requests"].as_i64().unwrap_or(0).max(0);
        tokens = tokens.saturating_add(t);
        requests = requests.saturating_add(n);
        count += 1;
        let m = models
            .entry(r["model"].as_str().unwrap_or("未知模型").into())
            .or_default();
        m.0 = m.0.saturating_add(t);
        m.1 = m.1.saturating_add(n);
    }
    let models:Vec<_>=models.into_iter().map(|(model,(tokens,requests))|json!({"model":model,"tokens":tokens,"requests":requests})).collect();
    Ok(
        json!({"cycle":c,"local":{"tokens":tokens,"requests":requests,"rows":count,"models":models,"from":from.to_rfc3339(),"to":to.to_rfc3339(),"retainedRows":activity["retainedRows"],"sourceRows":activity["sourceRows"],"truncated":activity["sourceRows"].as_u64().unwrap_or(0)>rows.len() as u64,"scope":"local-official-subscription-unattributed","note":"同期本机官方订阅记录，未核实归属此账号或额度类别；起点按窗口长度推算。仅统计已采集且有渠道证据的记录，缺失不等于零。跨设备聚合请查看云端周期用量。"}}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn now() -> DateTime<Utc> {
        stamp("2026-09-09T10:00:00Z").unwrap()
    }
    fn q(account: &str, limit: &str, used: f64, offset: i64, reset: i64) -> Value {
        json!({"provider":"codex","source":"codex-app-server","accountKey":account,"account":"ChatGPT · Pro","limitId":limit,"updatedAt":(now()+Duration::minutes(offset)).to_rfc3339(),"windows":[{"name":"primary","windowMinutes":300,"resetsAt":(now()+Duration::minutes(reset)).to_rfc3339(),"usedPercent":used}]})
    }
    #[test]
    fn snapshots_do_not_add_and_accounts_buckets_are_isolated() {
        let mut h = History::default();
        for i in 0..3 {
            h.record(
                vec![
                    q("a", "codex", 30., i, 120),
                    q("a", "spark", 5., i, 120),
                    q("b", "codex", 80., i, 120),
                ],
                Value::Null,
                now() + Duration::minutes(i),
            );
        }
        assert_eq!(h.cycles.len(), 3);
        let c = h
            .cycles
            .iter()
            .find(|c| c.account_key == "a" && c.limit_id == "codex")
            .unwrap();
        assert_eq!(c.last_used_percent, 30.);
        assert_eq!(c.samples.len(), 3);
    }
    #[test]
    fn rollover_and_downward_adjustment_create_separate_segments() {
        let mut h = History::default();
        h.record(vec![q("a", "codex", 80., 0, 120)], Value::Null, now());
        h.record(
            vec![q("a", "codex", 10., 1, 120)],
            Value::Null,
            now() + Duration::minutes(1),
        );
        assert_eq!(h.cycles.len(), 2);
        assert_eq!(h.cycles[0].segment, 1);
        assert_eq!(
            h.cycles[1].closure_reason.as_deref(),
            Some("reset-adjustment")
        );
        h.record(
            vec![q("a", "codex", 2., 121, 420)],
            Value::Null,
            now() + Duration::minutes(121),
        );
        assert_eq!(h.cycles.len(), 3);
        assert_eq!(h.cycles[0].last_used_percent, 2.);
    }
    #[test]
    fn idle_sliding_windows_only_replace_latest_and_preserve_real_history() {
        let mut h = History::default();
        h.record(vec![q("a", "spark", 0., 0, 120)], Value::Null, now());
        h.record(
            vec![q("a", "spark", 0., 1, 121)],
            Value::Null,
            now() + Duration::minutes(1),
        );
        assert!(h.cycles.is_empty());
        assert_eq!(h.latest[0]["windows"][0]["usedPercent"], 0.0);
        assert_eq!(
            stamp(h.latest[0]["updatedAt"].as_str().unwrap()),
            Some(now() + Duration::minutes(1))
        );

        h.record(
            vec![q("a", "spark", 8., 2, 122)],
            Value::Null,
            now() + Duration::minutes(2),
        );
        assert_eq!(h.cycles.len(), 1);
        assert_eq!(h.cycles[0].last_used_percent, 8.0);
        h.record(
            vec![q("a", "spark", 0., 1, 122)],
            Value::Null,
            now() + Duration::minutes(3),
        );
        assert!(h.cycles[0].closed_at.is_none());

        for i in 123..130 {
            h.record(
                vec![q("a", "spark", 0., i, i + 300)],
                Value::Null,
                now() + Duration::minutes(i),
            );
        }
        assert_eq!(h.cycles.len(), 1);
        assert_eq!(h.cycles[0].last_used_percent, 8.0);
        assert_eq!(
            h.cycles[0].closure_reason.as_deref(),
            Some("window-changed")
        );
        assert!(h.cycles[0].closed_at.is_some());
        assert_eq!(h.latest[0]["windows"][0]["usedPercent"], 0.0);
    }
    #[test]
    fn unavailable_usage_preserves_only_the_same_accounts_successful_cache() {
        let observed = json!({
            "accountKey":"a",
            "updatedAt":"2026-09-09T09:00:00Z",
            "summary":{"lifetimeTokens":100},
            "dailyUsageBuckets":[{"startDate":"2026-09-09","tokens":10}],
            "status":"observed"
        });
        let unavailable_a = json!({
            "accountKey":"a",
            "updatedAt":"2026-09-09T10:01:00Z",
            "summary":{"lifetimeTokens":null},
            "dailyUsageBuckets":null,
            "status":"unavailable",
            "error":"upstream detail must not escape"
        });
        let mut history = History::default();
        history.record(vec![q("a", "codex", 30., 0, 120)], observed, now());
        history.record(
            vec![q("a", "codex", 31., 1, 120)],
            unavailable_a,
            now() + Duration::minutes(1),
        );
        assert_eq!(history.official_usage["status"], "stale");
        assert_eq!(history.official_usage["summary"]["lifetimeTokens"], 100);
        assert_eq!(history.official_usage["dailyUsageBuckets"][0]["tokens"], 10);
        assert_eq!(history.official_usage["updatedAt"], "2026-09-09T09:00:00Z");
        assert_eq!(
            history.official_usage["error"],
            "官方 Token 活动暂时不可用，显示上次成功快照"
        );
        assert!(!history
            .official_usage
            .to_string()
            .contains("upstream detail"));

        let unavailable_b = json!({
            "accountKey":"b",
            "updatedAt":"2026-09-09T10:02:00Z",
            "summary":{"lifetimeTokens":null},
            "dailyUsageBuckets":null,
            "status":"unavailable",
            "error":"官方 Token 活动暂时不可用"
        });
        history.record(
            vec![q("b", "codex", 20., 2, 120)],
            unavailable_b,
            now() + Duration::minutes(2),
        );
        assert_eq!(history.official_usage["accountKey"], "b");
        assert_eq!(history.official_usage["status"], "unavailable");
        assert!(history.official_usage["dailyUsageBuckets"].is_null());
    }
    #[test]
    fn repeated_and_out_of_order_samples_are_ignored() {
        let mut h = History::default();
        for i in [2, 2, 1] {
            h.record(
                vec![q("a", "codex", 30., i, 120)],
                Value::Null,
                now() + Duration::minutes(2),
            );
        }
        assert_eq!(h.cycles[0].samples.len(), 1);
    }
    #[test]
    fn long_histories_keep_endpoints_and_ignore_invalid_windows() {
        let mut h = History::default();
        for i in 0..600 {
            let at = now() + Duration::seconds(i);
            let mut sample = q("a", "codex", 30., 0, 120);
            sample["updatedAt"] = json!(at.to_rfc3339());
            h.record(vec![sample], Value::Null, at);
        }
        assert_eq!(h.cycles.len(), 1);
        assert!(h.cycles[0].samples.len() <= MAX_SAMPLES);
        assert_eq!(stamp(&h.cycles[0].samples[0].at), Some(now()));
        assert_eq!(
            stamp(&h.cycles[0].samples.last().unwrap().at),
            Some(now() + Duration::seconds(599))
        );
        for duration in [0, 525601] {
            let mut invalid = q("b", "codex", 30., 0, 120);
            invalid["windows"][0]["windowMinutes"] = json!(duration);
            h.record(vec![invalid], Value::Null, now());
        }
        assert_eq!(h.cycles.len(), 1);
        h.record(vec![], Value::Null, now() + Duration::days(91));
        assert!(h.cycles.is_empty());
    }
    #[test]
    fn history_survives_restart_and_writer_lock_is_exclusive() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(Some(temp.path().into()), None).unwrap();
        let mut h = History::default();
        h.record(vec![q("a", "codex", 30., 0, 120)], Value::Null, now());
        let lock1 = lock(&paths).unwrap();
        assert!(lock(&paths).is_err());
        h.save(&paths).unwrap();
        drop(lock1);
        let _lock2 = lock(&paths).unwrap();
        assert_eq!(
            History::read(&paths).unwrap().cycles[0].last_used_percent,
            30.
        );
    }
    #[test]
    fn legacy_history_defaults_attempt_and_success_records_it() {
        let mut legacy: History = serde_json::from_value(json!({
            "version": 1,
            "cycles": [],
            "latest": [],
            "officialUsage": null,
            "lastSuccessAt": null
        }))
        .unwrap();
        assert_eq!(legacy.last_attempt_at, None);

        legacy.record(vec![], Value::Null, now());
        assert_eq!(legacy.last_attempt_at, legacy.last_success_at);
        assert_eq!(
            legacy.last_attempt_at.as_deref(),
            Some("2026-09-09T10:00:00+00:00")
        );
    }
    #[test]
    fn local_details_exclude_relays_api_and_end_boundary() {
        let mut h = History::default();
        h.record(vec![q("a", "codex", 30., 0, 120)], Value::Null, now());
        let c = &h.cycles[0];
        let make = |channel: &str, at: i64| json!({"at":at,"client":"codex","billingChannel":channel,"routeType":"official","tokens":10,"requests":1,"model":"model"});
        let data = json!({"requests":[make("official-subscription",now().timestamp_millis()),make("official-api",now().timestamp_millis()),make("official-subscription",stamp(&c.resets_at).unwrap().timestamp_millis())],"sourceRows":5,"retainedRows":3});
        let v = details(c, &data).unwrap();
        assert_eq!(v["local"]["tokens"], 10);
        assert_eq!(v["local"]["truncated"], true);
    }
}
