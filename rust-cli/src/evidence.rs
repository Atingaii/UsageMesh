use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use walkdir::WalkDir;

use crate::provider::{route_hint_from_base_url, RouteHint};

/// Route evidence is intentionally separate from accounting. Tokscale remains
/// the source of truth for token/client/model totals; this scanner only recovers
/// explicit route metadata that Tokscale's lightweight ParsedMessage may no
/// longer distinguish from model-family inference.
#[derive(Debug, Clone, Default)]
pub struct SessionEvidence {
    pub explicit_provider: Option<String>,
    pub route_hint: Option<RouteHint>,
}

#[derive(Debug, Clone, Default)]
pub struct EvidenceBundle {
    pub sessions: HashMap<(String, String), SessionEvidence>,
    pub provider_hints: HashMap<String, RouteHint>,
}

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
            .checked_sub(Duration::from_secs(5 * 24 * 3600))
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
