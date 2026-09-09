use super::store::{digest, Paths};
use crate::{model::Metrics, pricing::PriceBook};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokscale_core::{parse_local_clients, LocalParseOptions, ScannerSettings};

pub fn scan(paths: &Paths) -> Result<Value> {
    let since = (chrono::Local::now() - chrono::Duration::days(89))
        .format("%Y-%m-%d")
        .to_string();
    let parsed = parse_local_clients(LocalParseOptions {
        home_dir: Some(paths.home.to_string_lossy().into()),
        use_env_roots: !paths.isolated,
        clients: None,
        since: Some(since.clone()),
        until: None,
        year: None,
        scanner_settings: ScannerSettings::default(),
    })
    .map_err(|e| anyhow::anyhow!(e))?;
    let evidence = if paths.isolated {
        crate::evidence::EvidenceBundle::default()
    } else {
        crate::evidence::scan(false)
    };
    let prices = PriceBook::load();
    let month = chrono::Local::now().format("%Y-%m").to_string();
    let mut daily: BTreeMap<String, f64> = BTreeMap::new();
    let mut sessions: BTreeMap<String, Value> = BTreeMap::new();
    let mut requests = Vec::new();
    for m in &parsed.messages {
        let (_, route) = crate::collector::route_for_message(&evidence, m, &m.client, &m.model_id);
        let project = m.workspace_key.as_deref().unwrap_or("unknown");
        let project_id = digest(project.as_bytes());
        let sid = digest(
            format!(
                "{}:{}:{}",
                m.client,
                project,
                if m.session_id.is_empty() {
                    format!("unknown:{}:{}", m.date, m.timestamp)
                } else {
                    m.session_id.clone()
                }
            )
            .as_bytes(),
        );
        let timestamp = if m.timestamp.unsigned_abs() < 100_000_000_000 {
            m.timestamp.saturating_mul(1000)
        } else {
            m.timestamp
        };
        let mut metrics = Metrics {
            input: m.input.max(0),
            output: m.output.max(0),
            cache_read: m.cache_read.max(0),
            cache_write: m.cache_write.max(0),
            reasoning: m.reasoning.max(0),
            messages: m.message_count.max(0),
            cost_usd: 0.,
        };
        let quote = prices.quote_on_date(&m.model_id, &m.date, Some("standard"), &metrics);
        metrics.cost_usd = quote.cost_usd;
        let label = m
            .workspace_label
            .as_deref()
            .unwrap_or(if project == "unknown" {
                "未识别项目"
            } else {
                project
            });
        let item=sessions.entry(sid.clone()).or_insert_with(||json!({"id":sid,"client":m.client,"sessionKnown":!m.session_id.is_empty(),"projectId":project_id,"project":label,"startedAt":timestamp,"lastAt":timestamp,"tokens":0i64,"cost":0.,"monthCost":0.,"requests":0i64,"lowerBound":false}));
        item["startedAt"] = json!(item["startedAt"].as_i64().unwrap().min(timestamp));
        item["lastAt"] = json!(item["lastAt"].as_i64().unwrap().max(timestamp));
        item["tokens"] = json!(item["tokens"]
            .as_i64()
            .unwrap()
            .saturating_add(metrics.total_tokens()));
        item["cost"] = json!(item["cost"].as_f64().unwrap() + metrics.cost_usd);
        item["requests"] = json!(item["requests"].as_i64().unwrap() + i64::from(metrics.messages));
        item["lowerBound"] = json!(item["lowerBound"] == true || quote.lower_bound);
        if m.date.starts_with(&month) {
            item["monthCost"] = json!(item["monthCost"].as_f64().unwrap() + metrics.cost_usd);
        }
        *daily.entry(m.date.clone()).or_default() += metrics.cost_usd;
        requests.push(json!({"sessionId":sid,"projectId":project_id,"at":timestamp,"date":m.date,"client":m.client,"model":m.model_id,"provider":m.provider_id,"routeType":route.route_type,"billingChannel":route.billing_channel,"tokens":metrics.total_tokens(),"cost":metrics.cost_usd,"requests":metrics.messages,"durationMs":m.duration_ms.filter(|v|*v>=0),"lowerBound":quote.lower_bound}));
    }
    requests.sort_by_key(|r| r["at"].as_i64());
    let total = requests.len();
    if total > 20000 {
        requests.drain(0..total - 20000);
    }
    let mut sessions: Vec<_> = sessions.into_values().collect();
    sessions.sort_by_key(|r| std::cmp::Reverse(r["lastAt"].as_i64()));
    Ok(
        json!({"updatedAt":chrono::Utc::now().to_rfc3339(),"since":since,"sessions":sessions,"daily":daily,"requests":requests,"sourceRows":total,"retainedRows":total.min(20000),"note":"本机最近 90 个自然日；项目与会话来自 Tokscale 源记录。费用为兼容价卡估算，未解析字段保持未知，不能与供应商账单等同。最多保留最近 20000 条请求，会话汇总覆盖本次全部扫描记录。"}),
    )
}
pub fn validate_project(meta: &super::store::ProjectMeta) -> Result<()> {
    if meta.alias.len() > 120
        || meta.tags.len() > 12
        || meta.tags.iter().any(|s| s.len() > 60)
        || !meta.budget.is_finite()
        || meta.budget < 0.
    {
        anyhow::bail!("项目别名、标签或预算无效")
    };
    Ok(())
}
pub fn validate_events(input: &Value) -> Result<Vec<Value>> {
    let rows = input.as_array().context("需要 JSON 数组")?;
    if rows.len() > 10000 {
        anyhow::bail!("单次最多导入 10000 条事件")
    }
    rows.iter().map(|v|{let id=v["id"].as_str().filter(|s|!s.is_empty()&&s.len()<=128).context("每条事件需要唯一 id")?;let channel=v["channel"].as_str().filter(|s|!s.is_empty()&&s.len()<=100).context("需要 channel")?;let status=v["status"].as_u64().filter(|s|(100..600).contains(s)).context("status 必须为 HTTP 状态码")?;let latency=v["latencyMs"].as_f64().filter(|x|x.is_finite()&&*x>=0.&&*x<=3_600_000.).context("latencyMs 无效")?;let at=v["at"].as_str().context("需要时间 at")?;chrono::DateTime::parse_from_rfc3339(at)?;Ok(json!({"id":id,"channel":channel,"status":status,"latencyMs":latency,"at":at,"retry":v["retry"].as_bool(),"kind":"imported"}))}).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_events_are_validated_and_private_payloads_discarded() {
        let rows=validate_events(&json!([{"id":"a","channel":"b","status":429,"latencyMs":123,"at":"2026-09-07T00:00:00Z","prompt":"secret","authorization":"secret"}])).unwrap();
        assert!(!rows[0].to_string().contains("secret"));
        assert!(rows[0]["retry"].is_null());
        assert!(validate_events(
            &json!([{"id":"a","channel":"b","status":0,"latencyMs":123,"at":"bad"}])
        )
        .is_err());
    }
    #[test]
    fn empty_fixture_does_not_scan_real_home() {
        let d = tempfile::tempdir().unwrap();
        let paths = Paths::new(Some(d.path().into()), None).unwrap();
        let v = scan(&paths).unwrap();
        assert_eq!(v["sourceRows"], 0);
    }
}
