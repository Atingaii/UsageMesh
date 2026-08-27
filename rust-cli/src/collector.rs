use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

use anyhow::{Context, Result};
use tokscale_core::{
    canonical_model_id, parse_local_clients, ClientId, LocalParseOptions, ParsedMessage,
    ScannerSettings,
};

use crate::codex_tier;
use crate::evidence::{self, EvidenceBundle};
use crate::model::{DeviceInfo, Ledger, Metrics, PricingInfo, UsageRow};
use crate::pricing::PriceBook;
use crate::provider;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct RowKey {
    date: String,
    client: String,
    provider: String,
    upstream_vendor: String,
    route_provider: String,
    route_type: String,
    model: String,
    tier: Option<String>,
}

#[derive(Default)]
struct RowAccumulator {
    metrics: Metrics,
    cost_lower_bound: bool,
}

fn normalize_text(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn load_scanner_settings() -> ScannerSettings {
    let Some(config_dir) = dirs::config_dir() else {
        return ScannerSettings::default();
    };
    let Ok(data) = std::fs::read(config_dir.join("tokscale/settings.json")) else {
        return ScannerSettings::default();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&data) else {
        return ScannerSettings::default();
    };
    value
        .get("scanner")
        .cloned()
        .and_then(|scanner| serde_json::from_value(scanner).ok())
        .unwrap_or_default()
}

fn parser_provider_is_explicit(client: &str, raw_provider: &str) -> bool {
    !raw_provider.trim().is_empty()
        && raw_provider != "unknown"
        && matches!(client, "opencode" | "micode")
}

fn token_metrics_from_message(message: &ParsedMessage) -> Metrics {
    Metrics {
        input: message.input.max(0),
        output: message.output.max(0),
        cache_read: message.cache_read.max(0),
        cache_write: message.cache_write.max(0),
        reasoning: message.reasoning.max(0),
        messages: message.message_count.max(0),
        cost_usd: 0.0,
    }
}

fn priced_metrics_from_message(
    message: &ParsedMessage,
    model: &str,
    price_book: &PriceBook,
) -> (Metrics, bool) {
    let mut metrics = token_metrics_from_message(message);
    let quote = price_book.quote(model, Some("standard"), &metrics);
    metrics.cost_usd = quote.cost_usd;
    // A canonical Codex fallback does not carry request-level service tier. The
    // standard-card number remains useful, but it is a lower bound because some
    // requests may have used Fast/Priority. Exact tier rows replace it whenever
    // their daily token total reconciles with Tokscale.
    let tier_unknown = message.client == "codex";
    (metrics, quote.lower_bound || tier_unknown)
}

fn add_grouped(
    grouped: &mut BTreeMap<RowKey, RowAccumulator>,
    key: RowKey,
    metrics: Metrics,
    cost_lower_bound: bool,
) {
    let entry = grouped.entry(key).or_default();
    entry.metrics.add(&metrics);
    entry.cost_lower_bound |= cost_lower_bound;
}

fn route_for_message(
    evidence: &EvidenceBundle,
    message: &ParsedMessage,
    client: &str,
    model: &str,
) -> (String, provider::ProviderIdentity) {
    let session_evidence = evidence::for_message(evidence, client, &message.session_id);
    let raw_provider = session_evidence
        .and_then(|item| item.explicit_provider.as_deref())
        .unwrap_or(message.provider_id.as_str());
    let explicit = session_evidence
        .and_then(|item| item.explicit_provider.as_ref())
        .is_some()
        || parser_provider_is_explicit(client, raw_provider);
    let identity = provider::classify(
        Some(raw_provider),
        model,
        explicit,
        session_evidence.and_then(|item| item.route_hint.as_ref()),
    );
    (normalize_text(raw_provider, "unknown"), identity)
}

fn canonical_codex_days(
    messages: &[ParsedMessage],
) -> HashMap<String, codex_tier::DayReconciliation> {
    let mut days: HashMap<String, codex_tier::DayReconciliation> = HashMap::new();
    for message in messages.iter().filter(|message| message.client == "codex") {
        let metrics = token_metrics_from_message(message);
        let day = days.entry(message.date.clone()).or_default();
        day.tokens = day.tokens.saturating_add(metrics.total_tokens());
        day.messages = day.messages.saturating_add(metrics.messages);
    }
    days
}

/// Tier attribution is allowed to replace canonical Codex grouping only when its
/// additive token total exactly matches Tokscale for the whole day. Request/message
/// counters intentionally do not gate replacement because the two mature parsers
/// expose different record granularities; requiring them to match was the v1.0
/// bug that silently discarded valid Fast/Priority evidence.
fn reconciled_codex_days(
    canonical: &HashMap<String, codex_tier::DayReconciliation>,
    enhanced: &codex_tier::EnhancementResult,
) -> HashSet<String> {
    enhanced
        .by_date
        .iter()
        .filter_map(|(date, candidate)| {
            let upstream = canonical.get(date)?;
            (candidate.tokens == upstream.tokens).then(|| date.clone())
        })
        .collect()
}

pub fn supported_clients() -> Vec<String> {
    let mut clients: Vec<String> = ClientId::iter()
        .map(|client| client.as_str().to_string())
        .collect();
    clients.sort();
    clients
}

pub fn collect(device: DeviceInfo, since: Option<String>) -> Result<Ledger> {
    let started = Instant::now();
    let incremental = since.is_some();
    let scanner_settings = load_scanner_settings();

    // Tokscale remains the sole canonical local accounting pass: discovery,
    // parsing, deduplication, token-bucket semantics and model attribution.
    let parsed = parse_local_clients(LocalParseOptions {
        home_dir: None,
        use_env_roots: true,
        clients: None,
        since: since.clone(),
        until: None,
        year: None,
        scanner_settings: scanner_settings.clone(),
    })
    .map_err(|error| anyhow::anyhow!(error))
    .context("Tokscale failed to scan local AI coding-tool sessions")?;

    let route_evidence = evidence::scan(incremental);
    let price_book = PriceBook::load();
    let canonical_codex = canonical_codex_days(&parsed.messages);
    let codex_enhancement =
        codex_tier::collect(since.as_deref(), &scanner_settings).unwrap_or_default();
    let accepted_codex_days = reconciled_codex_days(&canonical_codex, &codex_enhancement);

    let mut grouped: BTreeMap<RowKey, RowAccumulator> = BTreeMap::new();

    for message in &parsed.messages {
        if message.client == "codex" && accepted_codex_days.contains(&message.date) {
            continue;
        }
        let client = normalize_text(&message.client, "unknown");
        let model = canonical_model_id(&message.model_id);
        let (raw_provider, identity) = route_for_message(&route_evidence, message, &client, &model);
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
        );
    }

    for enhanced in codex_enhancement
        .rows
        .into_iter()
        .filter(|row| accepted_codex_days.contains(&row.date))
    {
        let model = canonical_model_id(&enhanced.model);
        let raw_provider = normalize_text(&enhanced.provider, "unknown");
        let route_hint = route_evidence
            .provider_hints
            .get(&raw_provider.to_ascii_lowercase());
        let identity = provider::classify(
            Some(&raw_provider),
            &model,
            raw_provider != "unknown",
            route_hint,
        );
        let mut metrics = enhanced.metrics;
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
        );
    }

    let mut rows = Vec::with_capacity(grouped.len());
    let mut totals = Metrics::default();
    for (key, value) in grouped {
        totals.add(&value.metrics);
        rows.push(UsageRow {
            date: key.date,
            client: key.client,
            provider: key.provider,
            upstream_vendor: key.upstream_vendor,
            route_provider: key.route_provider,
            route_type: key.route_type,
            model: key.model,
            tier: key.tier,
            cost_lower_bound: value.cost_lower_bound,
            metrics: value.metrics,
        });
    }

    Ok(Ledger {
        schema_version: 4,
        generated_at: chrono::Utc::now().to_rfc3339(),
        device,
        rows,
        totals,
        scan_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        pricing: price_book.metadata(),
    })
}

pub fn merge_incremental(mut previous: Ledger, partial: Ledger, since: &str) -> Ledger {
    previous.rows.retain(|row| row.date.as_str() < since);
    previous.rows.extend(partial.rows);
    previous.rows.sort_by(|left, right| {
        left.date
            .cmp(&right.date)
            .then_with(|| left.client.cmp(&right.client))
            .then_with(|| left.route_provider.cmp(&right.route_provider))
            .then_with(|| left.model.cmp(&right.model))
            .then_with(|| left.tier.cmp(&right.tier))
    });
    previous.schema_version = partial.schema_version;
    previous.generated_at = partial.generated_at;
    previous.device = partial.device;
    previous.scan_ms = partial.scan_ms;
    previous.pricing = partial.pricing;
    previous.totals = Metrics::default();
    for row in &previous.rows {
        previous.totals.add(&row.metrics);
    }
    previous
}

pub fn same_accounting(left: &Ledger, right: &Ledger) -> bool {
    left.schema_version == right.schema_version
        && left.device.id == right.device.id
        && left.rows == right.rows
        && left.totals == right.totals
        && left.pricing == right.pricing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_ledger(schema_version: u32, device_id: &str) -> Ledger {
        Ledger {
            schema_version,
            generated_at: "2026-08-26T00:00:00Z".to_string(),
            device: DeviceInfo {
                id: device_id.to_string(),
                name: "test-device".to_string(),
                platform: "linux".to_string(),
                arch: "x86_64".to_string(),
                hostname: "test-host".to_string(),
                app_version: "1.1.0".to_string(),
            },
            rows: Vec::new(),
            totals: Metrics::default(),
            scan_ms: 1,
            pricing: PricingInfo::default(),
        }
    }

    #[test]
    fn every_tokscale_client_is_exposed() {
        let clients = supported_clients();
        assert!(clients.contains(&"codex".to_string()));
        assert!(clients.contains(&"claude".to_string()));
        assert!(clients.contains(&"opencode".to_string()));
        assert!(clients.contains(&"gemini".to_string()));
        assert!(
            clients.len() >= 20,
            "expected broad Tokscale client coverage, got {}",
            clients.len()
        );
    }

    #[test]
    fn only_proven_schema_providers_are_marked_explicit() {
        assert!(parser_provider_is_explicit("opencode", "openrouter"));
        assert!(parser_provider_is_explicit("micode", "openai"));
        assert!(!parser_provider_is_explicit("kimi", "moonshot"));
        assert!(!parser_provider_is_explicit("gemini", "google"));
        assert!(!parser_provider_is_explicit("opencode", "unknown"));
    }

    #[test]
    fn codex_tier_gate_requires_exact_tokens_not_record_count() {
        let canonical = HashMap::from([(
            "2026-08-26".to_string(),
            codex_tier::DayReconciliation {
                tokens: 1000,
                messages: 3,
            },
        )]);
        let enhanced = codex_tier::EnhancementResult {
            rows: Vec::new(),
            by_date: HashMap::from([(
                "2026-08-26".to_string(),
                codex_tier::DayReconciliation {
                    tokens: 1000,
                    messages: 7,
                },
            )]),
        };
        assert!(reconciled_codex_days(&canonical, &enhanced).contains("2026-08-26"));
    }

    #[test]
    fn token_mismatch_rejects_codex_tier_replacement() {
        let canonical = HashMap::from([(
            "2026-08-26".to_string(),
            codex_tier::DayReconciliation {
                tokens: 1000,
                messages: 3,
            },
        )]);
        let enhanced = codex_tier::EnhancementResult {
            rows: Vec::new(),
            by_date: HashMap::from([(
                "2026-08-26".to_string(),
                codex_tier::DayReconciliation {
                    tokens: 999,
                    messages: 3,
                },
            )]),
        };
        assert!(reconciled_codex_days(&canonical, &enhanced).is_empty());
    }

    #[test]
    fn same_accounting_requires_schema_device_and_pricing_identity() {
        let left = empty_ledger(4, "a");
        let mut right = left.clone();
        right.generated_at = "later".to_string();
        right.scan_ms = 999;
        assert!(same_accounting(&left, &right));
        right.schema_version = 5;
        assert!(!same_accounting(&left, &right));
        right = left.clone();
        right.device.id = "b".to_string();
        assert!(!same_accounting(&left, &right));
        right = left.clone();
        right.pricing.policy = "other".to_string();
        assert!(!same_accounting(&left, &right));
    }
}
