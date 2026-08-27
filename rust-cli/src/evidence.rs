use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, NaiveDateTime};
use serde_json::Value;
use tokscale_core::ClientId;
use walkdir::WalkDir;

use crate::provider::{route_hint_from_base_url, RouteHint};

/// Route evidence is intentionally separate from accounting. Tokscale remains
/// the source of truth for token/client/model totals; this scanner only recovers
/// explicit route metadata and request configuration that Tokscale's normalized
/// message model does not preserve yet.
#[derive(Debug, Clone, Default)]
pub struct SessionEvidence {
    pub explicit_provider: Option<String>,
    pub route_hint: Option<RouteHint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffortPoint {
    pub timestamp_ms: Option<i64>,
    pub effort: String,
}

#[derive(Debug, Clone, Default)]
pub struct EvidenceBundle {
    pub sessions: HashMap<(String, String), SessionEvidence>,
    pub provider_hints: HashMap<String, RouteHint>,
    /// Request/session reasoning configuration recovered from local source logs.
    /// Keys are (client, session id). Values stay local until the selected label
    /// is copied into the encrypted request ledger.
    pub reasoning_efforts: HashMap<(String, String), Vec<EffortPoint>>,
}

const MAX_EVIDENCE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EVIDENCE_FILES_PER_CLIENT: usize = 2500;
const MAX_EVIDENCE_LINE_BYTES: usize = 2 * 1024 * 1024;
const EFFORT_LOOKBACK_MS: i64 = 12 * 60 * 60 * 1000;
const EFFORT_NEARBY_MS: i64 = 5 * 60 * 1000;

fn home() -> Option<PathBuf> {
    dirs::home_dir()
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
            .checked_sub(Duration::from_secs(3 * 24 * 3600))
            .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn jsonl_files(root: &Path, incremental: bool) -> impl Iterator<Item = PathBuf> + '_ {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(move |path| {
            path.extension().and_then(|value| value.to_str()) == Some("jsonl")
                && recent_enough(path, incremental)
        })
}

fn get_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
}

fn codex_provider_hints(home: &Path) -> HashMap<String, RouteHint> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let Ok(text) = std::fs::read_to_string(codex_home.join("config.toml")) else {
        return HashMap::new();
    };
    let Ok(value) = text.parse::<toml::Value>() else {
        return HashMap::new();
    };
    let Some(table) = value.get("model_providers").and_then(toml::Value::as_table) else {
        return HashMap::new();
    };

    table
        .iter()
        .filter_map(|(id, config)| {
            let base_url = config
                .get("base_url")
                .and_then(toml::Value::as_str)
                .or_else(|| config.get("baseUrl").and_then(toml::Value::as_str))?;
            Some((
                id.to_ascii_lowercase(),
                route_hint_from_base_url(id, base_url),
            ))
        })
        .collect()
}

fn scan_codex_file(path: &Path, bundle: &mut EvidenceBundle) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_string);
    let mut provider = None;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("session_meta") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = value.get("payload").unwrap_or(&value);
        if let Some(id) = get_string(payload, &["id"]) {
            session_id = Some(id.to_string());
        }
        if let Some(route) = get_string(payload, &["model_provider", "modelProvider"]) {
            provider = Some(route.to_string());
        }
    }

    if let Some(id) = session_id {
        let route_hint = provider
            .as_ref()
            .and_then(|provider| bundle.provider_hints.get(&provider.to_ascii_lowercase()))
            .cloned();
        bundle.sessions.insert(
            ("codex".into(), id),
            SessionEvidence {
                explicit_provider: provider,
                route_hint,
            },
        );
    }
}

fn scan_claude_file(path: &Path, bundle: &mut EvidenceBundle) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let fallback_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let mut ids = HashSet::new();
    if !fallback_id.is_empty() {
        ids.insert(fallback_id);
    }
    let mut providers = HashSet::new();

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("provider") && !line.contains("sessionId") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = get_string(&value, &["sessionId", "session_id"]) {
            ids.insert(id.to_string());
        }
        if let Some(route) = get_string(&value, &["providerId", "provider_id", "provider"]) {
            providers.insert(route.to_string());
        }
        if let Some(message) = value.get("message") {
            if let Some(route) = get_string(message, &["providerId", "provider_id", "provider"]) {
                providers.insert(route.to_string());
            }
        }
    }

    let provider = if providers.len() == 1 {
        providers.into_iter().next()
    } else {
        None
    };
    for id in ids {
        bundle.sessions.insert(
            ("claude".into(), id),
            SessionEvidence {
                explicit_provider: provider.clone(),
                route_hint: None,
            },
        );
    }
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn normalize_effort_label(raw: &str) -> Option<String> {
    let cleaned = raw.trim().to_ascii_lowercase().replace('_', "-").replace(' ', "-");
    let label = match cleaned.as_str() {
        "minimal" | "min" | "lowest" => "minimal",
        "low" | "lite" => "low",
        "medium" | "med" | "balanced" | "normal" => "medium",
        "high" => "high",
        "xhigh" | "extra-high" | "very-high" | "max" | "maximum" => "xhigh",
        "auto" | "adaptive" | "dynamic" => "auto",
        "off" | "none" | "disabled" | "false" => "off",
        "on" | "enabled" | "true" => "enabled",
        other
            if !other.is_empty()
                && other.len() <= 32
                && other
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | ':')) =>
        {
            other
        }
        _ => return None,
    };
    Some(label.to_string())
}

fn effort_from_value(key: &str, value: &Value) -> Option<String> {
    let key = normalized_key(key);
    let is_budget = key.contains("budget");
    match value {
        Value::String(text) => normalize_effort_label(text),
        Value::Number(number) if is_budget => {
            let value = number.as_i64()?;
            if value <= 0 {
                Some("off".to_string())
            } else {
                Some(format!("budget:{value}"))
            }
        }
        Value::Number(number) => number.as_i64().map(|value| format!("level:{value}")),
        Value::Bool(true) => Some("enabled".to_string()),
        Value::Bool(false) => Some("off".to_string()),
        _ => None,
    }
}

fn shallow_reasoning_effort(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    for (key, child) in object {
        let normalized = normalized_key(key);
        if matches!(
            normalized.as_str(),
            "reasoningeffort"
                | "reasoninglevel"
                | "reasoningmode"
                | "reasoningbudget"
                | "thinkingeffort"
                | "thinkinglevel"
                | "thinkingmode"
                | "thinkingbudget"
                | "thinkingbudgettokens"
        ) {
            if let Some(effort) = effort_from_value(&normalized, child) {
                return Some(effort);
            }
        }
        if matches!(normalized.as_str(), "reasoning" | "thinking") {
            if let Some(effort) = effort_from_value(&normalized, child) {
                return Some(effort);
            }
            if let Some(nested) = child.as_object() {
                for (nested_key, nested_value) in nested {
                    let nested_key_normalized = normalized_key(nested_key);
                    if matches!(
                        nested_key_normalized.as_str(),
                        "effort" | "level" | "mode" | "budget" | "budgettokens" | "thinkingbudget"
                    ) {
                        if let Some(effort) = effort_from_value(&nested_key_normalized, nested_value) {
                            return Some(effort);
                        }
                    }
                }
            }
        }
    }
    None
}

fn recursive_reasoning_effort(value: &Value, depth: usize) -> Option<String> {
    if depth > 10 {
        return None;
    }
    if let Some(effort) = shallow_reasoning_effort(value) {
        return Some(effort);
    }
    match value {
        Value::Object(object) => object
            .values()
            .find_map(|child| recursive_reasoning_effort(child, depth + 1)),
        Value::Array(items) => items
            .iter()
            .find_map(|child| recursive_reasoning_effort(child, depth + 1)),
        _ => None,
    }
}

fn collect_session_ids(value: &Value, ids: &mut HashSet<String>, depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let normalized = normalized_key(key);
                if matches!(
                    normalized.as_str(),
                    "sessionid" | "conversationid" | "threadid" | "chatid" | "turnid"
                ) {
                    if let Some(id) = child.as_str().filter(|value| !value.trim().is_empty()) {
                        ids.insert(id.trim().to_string());
                    }
                }
                if matches!(child, Value::Object(_) | Value::Array(_)) {
                    collect_session_ids(child, ids, depth + 1);
                }
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_session_ids(child, ids, depth + 1);
            }
        }
        _ => {}
    }
}

fn parse_timestamp_string(text: &str) -> Option<i64> {
    if let Ok(value) = text.trim().parse::<i64>() {
        return Some(normalized_timestamp_ms(value));
    }
    if let Ok(value) = DateTime::parse_from_rfc3339(text.trim()) {
        return Some(value.timestamp_millis());
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y/%m/%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if let Ok(value) = NaiveDateTime::parse_from_str(text.trim(), format) {
            return Some(value.and_utc().timestamp_millis());
        }
    }
    None
}

fn normalized_timestamp_ms(timestamp: i64) -> i64 {
    if timestamp.abs() < 100_000_000_000 {
        timestamp.saturating_mul(1000)
    } else {
        timestamp
    }
}

fn recursive_timestamp(value: &Value, depth: usize) -> Option<i64> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let normalized = normalized_key(key);
                if matches!(
                    normalized.as_str(),
                    "timestamp" | "timestampms" | "createdat" | "starttime" | "eventtime"
                ) {
                    if let Some(number) = child.as_i64() {
                        return Some(normalized_timestamp_ms(number));
                    }
                    if let Some(text) = child.as_str() {
                        if let Some(timestamp) = parse_timestamp_string(text) {
                            return Some(timestamp);
                        }
                    }
                }
            }
            object
                .values()
                .find_map(|child| recursive_timestamp(child, depth + 1))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| recursive_timestamp(child, depth + 1)),
        _ => None,
    }
}

fn fallback_ids(path: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
        if !stem.is_empty() && !matches!(stem, "wire" | "events" | "updates" | "ui_messages") {
            ids.insert(stem.to_string());
        }
    }
    if let Some(parent) = path.parent().and_then(Path::file_name).and_then(|value| value.to_str()) {
        if !parent.is_empty() {
            ids.insert(parent.to_string());
        }
    }
    ids
}

fn register_effort(client: &str, path: &Path, value: &Value, bundle: &mut EvidenceBundle) {
    let Some(effort) = recursive_reasoning_effort(value, 0) else {
        return;
    };
    let mut ids = fallback_ids(path);
    collect_session_ids(value, &mut ids, 0);
    if ids.is_empty() {
        return;
    }
    let timestamp_ms = recursive_timestamp(value, 0);
    for id in ids {
        let points = bundle
            .reasoning_efforts
            .entry((client.to_string(), id))
            .or_default();
        let point = EffortPoint {
            timestamp_ms,
            effort: effort.clone(),
        };
        if !points.contains(&point) {
            points.push(point);
        }
    }
}

fn parse_json_candidate(line: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        return Some(value);
    }
    let start = line.find('{')?;
    let end = line.rfind('}')?;
    (end > start)
        .then(|| serde_json::from_str::<Value>(&line[start..=end]).ok())
        .flatten()
}

fn scan_effort_file(client: &str, path: &Path, bundle: &mut EvidenceBundle) {
    let Ok(metadata) = path.metadata() else {
        return;
    };
    if metadata.len() == 0 || metadata.len() > MAX_EVIDENCE_FILE_BYTES {
        return;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if extension == "json" {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                register_effort(client, path, &value, bundle);
            }
        }
        return;
    }

    let Ok(file) = File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.len() > MAX_EVIDENCE_LINE_BYTES {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if !lower.contains("reasoning") && !lower.contains("thinking") {
            continue;
        }
        if let Some(value) = parse_json_candidate(&line) {
            register_effort(client, path, &value, bundle);
        }
    }
}

fn is_text_evidence_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "json" | "jsonl" | "ndjson" | "log"
    )
}

fn scan_client_effort_sources(home: &Path, incremental: bool, bundle: &mut EvidenceBundle) {
    let home_text = home.to_string_lossy();
    for client in ClientId::iter() {
        let client_id = client.as_str();
        let resolved = PathBuf::from(client.data().resolve_path(&home_text));
        if !resolved.exists() {
            continue;
        }
        if resolved.is_file() {
            if is_text_evidence_file(&resolved) && recent_enough(&resolved, incremental) {
                scan_effort_file(client_id, &resolved, bundle);
            }
            continue;
        }

        let mut seen = 0usize;
        for entry in WalkDir::new(&resolved)
            .follow_links(false)
            .max_depth(10)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            if seen >= MAX_EVIDENCE_FILES_PER_CLIENT {
                break;
            }
            let path = entry.path();
            if !is_text_evidence_file(path) || !recent_enough(path, incremental) {
                continue;
            }
            seen += 1;
            scan_effort_file(client_id, path, bundle);
        }
    }

    for points in bundle.reasoning_efforts.values_mut() {
        points.sort_by_key(|point| point.timestamp_ms.unwrap_or(i64::MIN));
    }
}

pub fn scan(incremental: bool) -> EvidenceBundle {
    let mut bundle = EvidenceBundle::default();
    let Some(home) = home() else {
        return bundle;
    };
    bundle.provider_hints = codex_provider_hints(&home);

    for root in [
        home.join(".codex/sessions"),
        home.join(".codex/archived_sessions"),
    ] {
        if root.exists() {
            for path in jsonl_files(&root, incremental) {
                scan_codex_file(&path, &mut bundle);
            }
        }
    }

    let claude_root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
        .join("projects");
    if claude_root.exists() {
        for path in jsonl_files(&claude_root, incremental) {
            scan_claude_file(&path, &mut bundle);
        }
    }

    scan_client_effort_sources(&home, incremental, &mut bundle);
    bundle
}

pub fn for_message<'a>(
    bundle: &'a EvidenceBundle,
    client: &str,
    session_id: &str,
) -> Option<&'a SessionEvidence> {
    bundle
        .sessions
        .get(&(client.to_string(), session_id.to_string()))
}

/// Return only explicit reasoning/thinking configuration observed in a source
/// log. The selector prefers the most recent setting at-or-before the usage
/// event, then a very-near event, then a single unambiguous session label. It
/// deliberately never infers effort from model name or token count.
pub fn reasoning_effort_for_message(
    bundle: &EvidenceBundle,
    client: &str,
    session_id: &str,
    timestamp: i64,
) -> Option<String> {
    let points = bundle
        .reasoning_efforts
        .get(&(client.to_string(), session_id.to_string()))?;
    if points.is_empty() {
        return None;
    }
    let timestamp_ms = normalized_timestamp_ms(timestamp);

    let prior = points
        .iter()
        .filter_map(|point| {
            let point_timestamp = point.timestamp_ms?;
            let delta = timestamp_ms.saturating_sub(point_timestamp);
            (delta >= 0 && delta <= EFFORT_LOOKBACK_MS).then_some((point_timestamp, point))
        })
        .max_by_key(|(point_timestamp, _)| *point_timestamp)
        .map(|(_, point)| point.effort.clone());
    if prior.is_some() {
        return prior;
    }

    if let Some(point) = points
        .iter()
        .filter_map(|point| {
            let point_timestamp = point.timestamp_ms?;
            let delta = timestamp_ms.abs_diff(point_timestamp) as i64;
            (delta <= EFFORT_NEARBY_MS).then_some((delta, point))
        })
        .min_by_key(|(delta, _)| *delta)
        .map(|(_, point)| point)
    {
        return Some(point.effort.clone());
    }

    let unique: HashSet<_> = points.iter().map(|point| point.effort.as_str()).collect();
    (unique.len() == 1).then(|| unique.into_iter().next().unwrap().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_extractor_reads_common_shapes_without_guessing_content() {
        let value: Value = serde_json::json!({
            "sessionId": "s-1",
            "providerData": { "reasoning": { "effort": "high" } },
            "timestamp": 1780000000100i64
        });
        assert_eq!(recursive_reasoning_effort(&value, 0).as_deref(), Some("high"));
        assert_eq!(recursive_timestamp(&value, 0), Some(1780000000100));
    }

    #[test]
    fn thinking_budget_is_preserved_as_explicit_budget() {
        let value: Value = serde_json::json!({ "thinkingBudget": 8192 });
        assert_eq!(recursive_reasoning_effort(&value, 0).as_deref(), Some("budget:8192"));
    }

    #[test]
    fn request_selector_prefers_latest_prior_effort() {
        let mut bundle = EvidenceBundle::default();
        bundle.reasoning_efforts.insert(
            ("codebuddy".to_string(), "s-1".to_string()),
            vec![
                EffortPoint { timestamp_ms: Some(1_000_000_000_000), effort: "low".to_string() },
                EffortPoint { timestamp_ms: Some(1_000_000_010_000), effort: "high".to_string() },
            ],
        );
        assert_eq!(
            reasoning_effort_for_message(&bundle, "codebuddy", "s-1", 1_000_000_011_000).as_deref(),
            Some("high")
        );
    }
}