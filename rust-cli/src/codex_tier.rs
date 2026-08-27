//! Codex service-tier evidence adapter.
//!
//! Canonical Codex token accounting remains Tokscale v4.14.0. This module is a
//! deliberately narrow parser adapted from the MIT-licensed request/tier logic
//! in `falyx6851-byte/codex-monitor` (2026). It contributes request-level tier
//! attribution and normalized token buckets only. Pricing is centralized in
//! `pricing.rs` and therefore happens before daily aggregation, which is required
//! for correct per-request long-context thresholds.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokscale_core::{BucketTimezone, ScannerSettings};
use walkdir::WalkDir;

use crate::model::Metrics;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RawUsage {
    input: i64,
    cached: i64,
    cache_write: Option<i64>,
    output: i64,
    reasoning: i64,
    total: i64,
}

impl RawUsage {
    fn normalized_metrics(&self) -> Metrics {
        let cached = self.cached.max(0).min(self.input.max(0));
        let uncached = self.input.max(0).saturating_sub(cached);
        let cache_write = self.cache_write.unwrap_or(0).max(0).min(uncached);
        let reasoning = self.reasoning.max(0).min(self.output.max(0));
        Metrics {
            input: uncached.saturating_sub(cache_write),
            cache_read: cached,
            cache_write,
            output: self.output.max(0).saturating_sub(reasoning),
            reasoning,
            messages: 1,
            cost_usd: 0.0,
        }
    }

    fn tuple(&self) -> String {
        format!(
            "{}/{}/{}/{}/{}/{}",
            self.input,
            self.cached,
            self.cache_write
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".to_string()),
            self.output,
            self.reasoning,
            self.total
        )
    }
}

#[derive(Debug, Clone)]
pub struct EnhancedCodexRow {
    pub date: String,
    pub timestamp_ms: i64,
    pub model: String,
    pub provider: String,
    pub tier: String,
    pub reasoning_effort: Option<String>,
    pub metrics: Metrics,
    pub cache_write_known: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DayReconciliation {
    pub tokens: i64,
    pub messages: i32,
}

#[derive(Debug, Clone, Default)]
pub struct EnhancementResult {
    /// Request-granular rows. Collector prices each row before its final grouping.
    pub rows: Vec<EnhancedCodexRow>,
    pub by_date: HashMap<String, DayReconciliation>,
}

fn number(value: Option<&Value>) -> i64 {
    value
        .and_then(|item| {
            item.as_i64()
                .or_else(|| item.as_u64().map(|value| value.min(i64::MAX as u64) as i64))
        })
        .unwrap_or(0)
        .max(0)
}

fn optional_number(value: Option<&Value>) -> Option<i64> {
    let item = value?;
    item.as_i64()
        .or_else(|| item.as_u64().map(|value| value.min(i64::MAX as u64) as i64))
        .map(|value| value.max(0))
}

fn normalize_usage(value: Option<&Value>) -> RawUsage {
    let Some(usage) = value.and_then(Value::as_object) else {
        return RawUsage::default();
    };
    let input_details = usage.get("input_tokens_details").and_then(Value::as_object);
    let output_details = usage
        .get("output_tokens_details")
        .and_then(Value::as_object);
    let input = number(usage.get("input_tokens"));
    let cached = number(
        usage
            .get("cached_input_tokens")
            .or_else(|| input_details.and_then(|details| details.get("cached_tokens")))
            .or_else(|| usage.get("cache_read_input_tokens")),
    );
    let cache_write = optional_number(
        usage
            .get("cache_write_input_tokens")
            .or_else(|| usage.get("cache_write_tokens"))
            .or_else(|| input_details.and_then(|details| details.get("cache_write_tokens"))),
    );
    let output = number(usage.get("output_tokens"));
    let reasoning = number(
        usage
            .get("reasoning_output_tokens")
            .or_else(|| output_details.and_then(|details| details.get("reasoning_tokens"))),
    );
    let total =
        optional_number(usage.get("total_tokens")).unwrap_or_else(|| input.saturating_add(output));
    RawUsage {
        input,
        cached,
        cache_write,
        output,
        reasoning,
        total,
    }
}

fn normalize_tier(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "priority" | "fast" => "fast".to_string(),
        "default" | "standard" | "" => "standard".to_string(),
        other => other.to_string(),
    }
}

fn extract_service_tier(payload: &Value) -> Option<String> {
    let candidates = [
        payload.pointer("/thread_settings/service_tier"),
        payload.pointer("/thread_settings/serviceTier"),
        payload.get("service_tier"),
        payload.get("serviceTier"),
        payload.pointer("/info/service_tier"),
        payload.pointer("/info/serviceTier"),
        payload.pointer("/request/service_tier"),
        payload.pointer("/request/serviceTier"),
        payload.pointer("/response/service_tier"),
        payload.pointer("/response/serviceTier"),
    ];
    candidates.into_iter().flatten().find_map(|value| {
        value
            .as_str()
            .map(normalize_tier)
            .filter(|tier| !tier.is_empty())
    })
}

fn extract_reasoning_effort(payload: &Value) -> Option<String> {
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

fn timestamp_ms(value: Option<&Value>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value?.as_str()?)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

fn usage_dedupe_key(session_id: &str, usage: &RawUsage, total: &RawUsage) -> String {
    format!(
        "{session_id}|last={}|total={}",
        usage.tuple(),
        total.tuple()
    )
}

fn short_file_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hex::encode(hasher.finalize())[..12].to_string()
}

#[derive(Debug)]
struct RequestRecord {
    dedupe: String,
    date: String,
    timestamp_ms: i64,
    model: String,
    provider: String,
    tier: String,
    reasoning_effort: Option<String>,
    usage: RawUsage,
}

fn parse_session_file(path: &Path, bucket_timezone: &BucketTimezone) -> Vec<RequestRecord> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut provider = String::new();
    let mut current_model = String::new();
    let mut current_tier = "standard".to_string();
    let mut current_reasoning_effort: Option<String> = None;
    let mut records = Vec::new();

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = row.get("payload").unwrap_or(&Value::Null);
        if let Some(tier) = extract_service_tier(payload) {
            current_tier = tier;
        }
        if let Some(effort) = extract_reasoning_effort(payload) {
            current_reasoning_effort = Some(effort);
        }

        match string_at(&row, "type").unwrap_or_default() {
            "session_meta" => {
                if let Some(id) = string_at(payload, "id") {
                    session_id = id.to_string();
                }
                if let Some(model_provider) = string_at(payload, "model_provider") {
                    provider = model_provider.to_string();
                }
            }
            "turn_context" => {
                if let Some(model) = string_at(payload, "model") {
                    current_model = model.to_string();
                }
            }
            "event_msg" if string_at(payload, "type") == Some("token_count") => {
                let Some(milliseconds) = timestamp_ms(row.get("timestamp")) else {
                    continue;
                };
                let info = payload.get("info").unwrap_or(&Value::Null);
                let usage = normalize_usage(info.get("last_token_usage"));
                if usage.total <= 0 || (usage.input == 0 && usage.cached == 0 && usage.output == 0)
                {
                    continue;
                }
                let total = normalize_usage(info.get("total_token_usage"));
                records.push(RequestRecord {
                    dedupe: usage_dedupe_key(&session_id, &usage, &total),
                    date: bucket_timezone.day_key(milliseconds),
                    timestamp_ms: milliseconds,
                    model: current_model.clone(),
                    provider: provider.clone(),
                    tier: current_tier.clone(),
                    reasoning_effort: current_reasoning_effort.clone(),
                    usage,
                });
            }
            _ => {}
        }
    }

    if session_id == "unknown" {
        let suffix = short_file_id(path);
        for record in &mut records {
            record.dedupe.push_str(&format!("|file={suffix}"));
        }
    }
    records
}

fn codex_roots() -> Vec<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
    base.map(|root| vec![root.join("sessions"), root.join("archived_sessions")])
        .unwrap_or_default()
}

fn recent_enough(path: &Path, incremental: bool) -> bool {
    if !incremental {
        return true;
    }
    let Ok(modified) = path.metadata().and_then(|metadata| metadata.modified()) else {
        return true;
    };
    modified
        >= SystemTime::now()
            .checked_sub(Duration::from_secs(5 * 24 * 3600))
            .unwrap_or(SystemTime::UNIX_EPOCH)
}

pub fn collect(
    since: Option<&str>,
    scanner_settings: &ScannerSettings,
) -> Result<EnhancementResult> {
    let incremental = since.is_some();
    let bucket_timezone = BucketTimezone::from_scanner_settings(scanner_settings);
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    let mut by_date: HashMap<String, DayReconciliation> = HashMap::new();

    for root in codex_roots() {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                || !recent_enough(path, incremental)
            {
                continue;
            }
            for request in parse_session_file(path, &bucket_timezone) {
                if since.is_some_and(|start| request.date.as_str() < start)
                    || !seen.insert(request.dedupe.clone())
                {
                    continue;
                }
                let metrics = request.usage.normalized_metrics();
                let day = by_date.entry(request.date.clone()).or_default();
                day.tokens = day.tokens.saturating_add(metrics.total_tokens());
                day.messages = day.messages.saturating_add(metrics.messages);
                rows.push(EnhancedCodexRow {
                    date: request.date,
                    timestamp_ms: request.timestamp_ms,
                    model: request.model,
                    provider: request.provider,
                    tier: request.tier,
                    reasoning_effort: request.reasoning_effort,
                    metrics,
                    cache_write_known: request.usage.cache_write.is_some(),
                });
            }
        }
    }

    Ok(EnhancementResult { rows, by_date })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_and_fast_normalize_to_fast() {
        assert_eq!(normalize_tier("priority"), "fast");
        assert_eq!(normalize_tier("FAST"), "fast");
        assert_eq!(normalize_tier("default"), "standard");
    }

    #[test]
    fn extracts_thread_settings_service_tier() {
        let payload = serde_json::json!({"thread_settings":{"service_tier":"priority"}});
        assert_eq!(extract_service_tier(&payload).as_deref(), Some("fast"));
    }

    #[test]
    fn cached_and_reasoning_buckets_are_not_double_counted() {
        let usage = RawUsage {
            input: 100_000,
            cached: 50_000,
            cache_write: Some(10_000),
            output: 20_000,
            reasoning: 5_000,
            total: 120_000,
        };
        let metrics = usage.normalized_metrics();
        assert_eq!(metrics.input, 40_000);
        assert_eq!(metrics.cache_read, 50_000);
        assert_eq!(metrics.cache_write, 10_000);
        assert_eq!(metrics.output, 15_000);
        assert_eq!(metrics.reasoning, 5_000);
        assert_eq!(metrics.total_tokens(), 120_000);
    }

    #[test]
    fn missing_cache_write_keeps_totals() {
        let usage = RawUsage {
            input: 100,
            cached: 60,
            cache_write: None,
            output: 10,
            reasoning: 2,
            total: 110,
        };
        let metrics = usage.normalized_metrics();
        assert_eq!(metrics.input, 40);
        assert_eq!(metrics.cache_write, 0);
        assert_eq!(metrics.total_tokens(), 110);
    }
}
