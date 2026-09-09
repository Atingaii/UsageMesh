use super::store::{Preferences, ProjectMeta};
use serde_json::{json, Value};
use std::{collections::BTreeMap, process::Command};

pub fn conditions(
    activity: &Value,
    quotas: &[Value],
    prefs: &Preferences,
    projects: &BTreeMap<String, ProjectMeta>,
) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let month = chrono::Local::now().format("%Y-%m").to_string();
    let mut cost = 0.;
    if let Some(daily) = activity["daily"].as_object() {
        for (day, v) in daily {
            if day.starts_with(&month) {
                cost += v.as_f64().unwrap_or(0.)
            }
        }
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let mut baseline = 0.;
        for n in 1..=7 {
            baseline += daily
                .get(
                    &(chrono::Local::now() - chrono::Duration::days(n))
                        .format("%Y-%m-%d")
                        .to_string(),
                )
                .and_then(Value::as_f64)
                .unwrap_or(0.)
        }
        baseline /= 7.;
        let current = daily.get(&today).and_then(Value::as_f64).unwrap_or(0.);
        if baseline >= 1. && current > baseline * prefs.spike_factor {
            result.push((
                "spike".into(),
                "今日费用超过过去 7 天日均阈值，请核对项目与模型。".into(),
            ));
        }
    }
    if prefs.monthly_budget > 0. && cost >= prefs.monthly_budget {
        result.push((
            "budget".into(),
            format!(
                "本月本机估算 ${cost:.2} 已达到预算 ${:.2}。",
                prefs.monthly_budget
            ),
        ));
    }
    for q in quotas {
        if q["status"] == "stale" {
            continue;
        }
        let stamp = q["updatedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        if !stamp.is_some_and(|t| {
            (-2..=15).contains(&chrono::Utc::now().signed_duration_since(t).num_minutes())
        }) {
            continue;
        };
        if q["source"]
            .as_str()
            .is_some_and(|s| s.contains("estimate") || s == "codexbar:local")
        {
            continue;
        };
        if let Some(windows) = q["windows"].as_array() {
            for w in windows {
                let reset = w["resetsAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
                if reset.is_some_and(|t| t < chrono::Utc::now()) {
                    continue;
                };
                if w["usedPercent"]
                    .as_f64()
                    .is_some_and(|n| n >= prefs.quota_threshold)
                {
                    result.push((
                        format!(
                            "quota:{}:{}:{}:{}:{}",
                            q["provider"], q["accountKey"], q["limitId"], w["name"], w["resetsAt"]
                        ),
                        format!(
                            "{} 的 {} 窗口用量达到 {}%。",
                            q["limitName"]
                                .as_str()
                                .or_else(|| q["limitId"].as_str())
                                .or_else(|| q["provider"].as_str())
                                .unwrap_or("供应商"),
                            w["name"].as_str().unwrap_or("额度"),
                            w["usedPercent"]
                        ),
                    ));
                }
            }
        }
    }
    for (id, meta) in projects {
        if meta.budget <= 0. {
            continue;
        };
        let total = activity["sessions"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter(|s| s["projectId"] == *id)
                    .map(|s| s["monthCost"].as_f64().unwrap_or(0.))
                    .sum::<f64>()
            })
            .unwrap_or(0.);
        if total >= meta.budget {
            result.push((
                format!("project:{id}"),
                format!("项目 {} 的本月估算 ${total:.2} 已达到预算。", meta.alias),
            ));
        }
    }
    result
}
pub fn notify(message: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        Command::new("osascript").args(["-e","on run argv\ndisplay notification (item 1 of argv) with title \"UsageMesh\"\nend run",message]).status().is_ok_and(|s|s.success())
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("notify-send")
            .args(["--app-name=UsageMesh", "UsageMesh", message])
            .status()
            .is_ok_and(|s| s.success())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(4000,'UsageMesh',$env:USAGEMESH_NOTICE,[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 5; $n.Dispose()"] ).env("USAGEMESH_NOTICE",message).status().is_ok_and(|s|s.success())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = message;
        false
    }
}
pub fn evaluate(
    activity: &Value,
    quotas: &[Value],
    prefs: &Preferences,
    projects: &BTreeMap<String, ProjectMeta>,
    active: &mut BTreeMap<String, i64>,
    history: &mut Vec<Value>,
) {
    let conditions = conditions(activity, quotas, prefs, projects);
    let now = chrono::Utc::now().timestamp();
    let recovered: Vec<_> = active
        .keys()
        .filter(|key| !conditions.iter().any(|(id, _)| id == *key))
        .cloned()
        .collect();
    for id in recovered {
        active.remove(&id);
        let message = "此前阈值条件已解除或来源已失效，请查看最新快照；这不代表额度已恢复。";
        history.push(json!({"id":id,"at":chrono::Utc::now().to_rfc3339(),"message":message,"state":"changed","notified":false}));
    }
    for (id, message) in conditions {
        if active
            .get(&id)
            .is_some_and(|at| now - at < i64::from(prefs.cooldown_minutes) * 60)
        {
            continue;
        };
        let sent = prefs.notifications && notify(&message);
        active.insert(id.clone(), now);
        history.push(json!({"id":id,"at":chrono::Utc::now().to_rfc3339(),"message":message,"state":"active","notified":sent}));
    }
    if history.len() > 300 {
        history.drain(0..history.len() - 300);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_or_future_quota_never_alerts() {
        let prefs = Preferences::default();
        for age in [20, -20] {
            let q = json!({"provider":"codex","source":"local-cli-telemetry","updatedAt":(chrono::Utc::now()-chrono::Duration::minutes(age)).to_rfc3339(),"windows":[{"name":"primary","usedPercent":99}]});
            assert!(conditions(&json!({}), &[q], &prefs, &BTreeMap::new()).is_empty());
        }
    }
    #[test]
    fn official_buckets_and_resets_have_distinct_alert_keys() {
        let make = |bucket: &str, minutes: i64| json!({"provider":"codex","accountKey":"account","limitId":bucket,"source":"codex-app-server","status":"observed","updatedAt":chrono::Utc::now().to_rfc3339(),"windows":[{"name":"primary","usedPercent":99,"resetsAt":(chrono::Utc::now()+chrono::Duration::minutes(minutes)).to_rfc3339()}]});
        let mut stale = make("old", 60);
        stale["status"] = json!("stale");
        let result = conditions(
            &json!({}),
            &[
                make("codex", 60),
                make("spark", 60),
                make("codex", 120),
                stale,
            ],
            &Preferences::default(),
            &BTreeMap::new(),
        );
        assert_eq!(result.len(), 3);
        let keys: std::collections::BTreeSet<_> = result.iter().map(|v| &v.0).collect();
        assert_eq!(keys.len(), 3);
    }
    #[test]
    fn cooldown_prevents_duplicate_alerts_and_loss_is_not_recovery() {
        let prefs = Preferences::default();
        let q = json!({"provider":"codex","source":"local-cli-telemetry","updatedAt":chrono::Utc::now().to_rfc3339(),"windows":[{"name":"primary","usedPercent":99}]});
        let mut active = BTreeMap::new();
        let mut history = vec![];
        for _ in 0..2 {
            evaluate(
                &json!({}),
                std::slice::from_ref(&q),
                &prefs,
                &BTreeMap::new(),
                &mut active,
                &mut history,
            );
        }
        assert_eq!(history.len(), 1);
        evaluate(
            &json!({}),
            &[],
            &prefs,
            &BTreeMap::new(),
            &mut active,
            &mut history,
        );
        assert_eq!(history[1]["state"], "changed");
        assert_eq!(history[1]["notified"], false);
    }
}
