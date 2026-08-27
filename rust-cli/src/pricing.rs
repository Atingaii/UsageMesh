//! Mature-source pricing adapter.
//!
//! Token parsing and normalization remain owned by Tokscale. Cost arithmetic is
//! intentionally aligned with the mature CC Switch implementation: normalized
//! fresh input, cache read, cache creation and output are priced independently,
//! OpenAI-style cached input is not double-billed, and long-context multipliers
//! apply to all input-side buckets.
//!
//! General model prices are read from the same public models.dev catalog CC
//! Switch can sync from. GPT-5.6 is guarded by audited seed prices so API catalog
//! changes do not silently rewrite the API-equivalent accounting policy.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::model::{Metrics, PricingInfo};

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const PRICING_POLICY: &str = "api-equivalent-estimate-v2";
const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const GPT56_LONG_CONTEXT_THRESHOLD: i64 = 272_000;
const GPT56_LONG_INPUT_MULTIPLIER: f64 = 2.0;
const GPT56_LONG_OUTPUT_MULTIPLIER: f64 = 1.5;

#[derive(Debug, Clone, Default, Deserialize)]
struct ModelsDevCost {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ModelsDevModel {
    cost: Option<ModelsDevCost>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ModelsDevProvider {
    models: Option<HashMap<String, ModelsDevModel>>,
}

type ModelsDevResponse = HashMap<String, ModelsDevProvider>;

#[derive(Debug, Clone, Copy)]
struct EffectivePricing {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    long_context_threshold: Option<i64>,
    long_input_multiplier: f64,
    long_output_multiplier: f64,
}

impl EffectivePricing {
    fn from_models_dev(cost: &ModelsDevCost) -> Option<Self> {
        let input = cost.input.unwrap_or(0.0);
        let output = cost.output.unwrap_or(0.0);
        if input <= 0.0 && output <= 0.0 {
            return None;
        }
        Some(Self {
            input: input / 1_000_000.0,
            output: output / 1_000_000.0,
            cache_read: cost.cache_read.unwrap_or(0.0) / 1_000_000.0,
            cache_write: cost.cache_write.unwrap_or(0.0) / 1_000_000.0,
            long_context_threshold: None,
            long_input_multiplier: 1.0,
            long_output_multiplier: 1.0,
        })
    }
}

#[derive(Debug, Clone)]
pub struct PriceBook {
    catalog: HashMap<String, EffectivePricing>,
    catalog_state: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct PriceQuote {
    pub cost_usd: f64,
    pub lower_bound: bool,
}

fn cache_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("usagemesh/models-dev-pricing.json"))
}

fn cache_is_fresh(path: &PathBuf) -> bool {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age <= CACHE_MAX_AGE)
}

fn normalize_model_id(model_id: &str) -> String {
    let after_slash = model_id.rsplit('/').next().unwrap_or(model_id);
    let before_colon = after_slash.split(':').next().unwrap_or(after_slash);
    let mut normalized = before_colon.trim().replace('@', "-").to_ascii_lowercase();
    if normalized.ends_with("[1m]") {
        normalized.truncate(normalized.len() - 4);
        normalized = normalized.trim().to_string();
    }
    normalized
}

fn strip_date_suffix(value: &str) -> Option<String> {
    let (base, suffix) = value.rsplit_once('-')?;
    (suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_digit())).then(|| base.to_string())
}

fn provider_preference(model: &str, provider: &str) -> u8 {
    let canonical = if model.starts_with("gpt-")
        || model.starts_with("o1-")
        || model.starts_with("o3-")
        || model.starts_with("o4-")
    {
        Some("openai")
    } else if model.starts_with("claude-") {
        Some("anthropic")
    } else if model.starts_with("gemini-") {
        Some("google")
    } else if model.starts_with("grok-") {
        Some("xai")
    } else if model.starts_with("deepseek-") {
        Some("deepseek")
    } else if model.starts_with("qwen") {
        Some("alibaba")
    } else if model.starts_with("kimi-") {
        Some("moonshotai")
    } else if model.starts_with("mimo-") {
        Some("xiaomi")
    } else if model.starts_with("glm-") {
        Some("zai")
    } else {
        None
    };
    if canonical.is_some_and(|expected| provider.eq_ignore_ascii_case(expected)) {
        0
    } else {
        1
    }
}

fn parse_models_dev(bytes: &[u8]) -> Option<HashMap<String, EffectivePricing>> {
    let response: ModelsDevResponse = serde_json::from_slice(bytes).ok()?;
    let mut selected: HashMap<String, (u8, String, EffectivePricing)> = HashMap::new();
    let mut providers: Vec<_> = response.into_iter().collect();
    providers.sort_by(|a, b| a.0.cmp(&b.0));
    for (provider_id, provider) in providers {
        let mut models: Vec<_> = provider.models.unwrap_or_default().into_iter().collect();
        models.sort_by(|a, b| a.0.cmp(&b.0));
        for (model_id, model) in models {
            let Some(cost) = model.cost.as_ref() else {
                continue;
            };
            let Some(pricing) = EffectivePricing::from_models_dev(cost) else {
                continue;
            };
            let normalized = normalize_model_id(&model_id);
            if normalized.is_empty() {
                continue;
            }
            let preference = provider_preference(&normalized, &provider_id);
            let replace =
                selected
                    .get(&normalized)
                    .is_none_or(|(old_preference, old_provider, _)| {
                        preference < *old_preference
                            || (preference == *old_preference && provider_id < *old_provider)
                    });
            if replace {
                selected.insert(normalized, (preference, provider_id.clone(), pricing));
            }
        }
    }
    Some(
        selected
            .into_iter()
            .map(|(model, (_, _, pricing))| (model, pricing))
            .collect(),
    )
}

fn read_cache() -> Option<Vec<u8>> {
    fs::read(cache_path()?).ok()
}

fn write_cache(bytes: &[u8]) {
    let Some(path) = cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = fs::write(path, bytes);
}

fn fetch_models_dev() -> Option<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .ok()?;
    let response = client
        .get(MODELS_DEV_URL)
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    Some(response.bytes().ok()?.to_vec())
}

impl PriceBook {
    pub fn load() -> Self {
        if let Some(path) = cache_path() {
            if cache_is_fresh(&path) {
                if let Some(bytes) = read_cache() {
                    if let Some(catalog) = parse_models_dev(&bytes) {
                        return Self {
                            catalog,
                            catalog_state: "models.dev cache",
                        };
                    }
                }
            }
        }

        if let Some(bytes) = fetch_models_dev() {
            if let Some(catalog) = parse_models_dev(&bytes) {
                write_cache(&bytes);
                return Self {
                    catalog,
                    catalog_state: "models.dev live",
                };
            }
        }

        if let Some(bytes) = read_cache() {
            if let Some(catalog) = parse_models_dev(&bytes) {
                return Self {
                    catalog,
                    catalog_state: "models.dev stale cache",
                };
            }
        }

        Self {
            catalog: HashMap::new(),
            catalog_state: "guarded fallbacks only",
        }
    }

    pub fn metadata(&self) -> PricingInfo {
        PricingInfo {
            policy: PRICING_POLICY.to_string(),
            source: format!("CC Switch compatible · {}", self.catalog_state),
            source_url: MODELS_DEV_URL.to_string(),
            compatibility: "GPT-5.6 guarded base rates; speed tier is recorded separately and does not multiply USD cost"
                .to_string(),
        }
    }

    fn lookup(&self, model_id: &str) -> Option<EffectivePricing> {
        let normalized = normalize_model_id(model_id);
        if let Some(guarded) = guarded_pricing(&normalized) {
            return Some(guarded);
        }
        if let Some(pricing) = self.catalog.get(&normalized) {
            return Some(*pricing);
        }
        if let Some(base) = strip_date_suffix(&normalized) {
            if let Some(guarded) = guarded_pricing(&base) {
                return Some(guarded);
            }
            if let Some(pricing) = self.catalog.get(&base) {
                return Some(*pricing);
            }
        }
        None
    }

    pub fn quote(&self, model_id: &str, _tier: Option<&str>, metrics: &Metrics) -> PriceQuote {
        let Some(mut pricing) = self.lookup(model_id) else {
            return PriceQuote {
                cost_usd: 0.0,
                lower_bound: true,
            };
        };

        let total_input = metrics
            .input
            .max(0)
            .saturating_add(metrics.cache_read.max(0))
            .saturating_add(metrics.cache_write.max(0));
        let long_context = pricing
            .long_context_threshold
            .is_some_and(|threshold| total_input > threshold);
        let input_multiplier = if long_context {
            pricing.long_input_multiplier
        } else {
            1.0
        };
        let output_multiplier = if long_context {
            pricing.long_output_multiplier
        } else {
            1.0
        };

        let output_tokens = metrics
            .output
            .max(0)
            .saturating_add(metrics.reasoning.max(0));
        let cost = metrics.input.max(0) as f64 * pricing.input * input_multiplier
            + metrics.cache_read.max(0) as f64 * pricing.cache_read * input_multiplier
            + metrics.cache_write.max(0) as f64 * pricing.cache_write * input_multiplier
            + output_tokens as f64 * pricing.output * output_multiplier;

        let lower_bound = (metrics.input > 0 && pricing.input <= 0.0)
            || (output_tokens > 0 && pricing.output <= 0.0)
            || (metrics.cache_read > 0 && pricing.cache_read <= 0.0)
            || (metrics.cache_write > 0 && pricing.cache_write <= 0.0);
        PriceQuote {
            cost_usd: cost.max(0.0),
            lower_bound,
        }
    }
}

/// Guarded GPT-5.6 API-equivalent base prices. Values are USD/token;
/// base card per MTok: Sol 5 / 30 / 0.50 / 6.25, Terra 2 / 12 / 0.20 / 2.50,
/// Luna 0.20 / 1.20 / 0.02 / 0.25. Speed tier is tracked separately.
fn guarded_pricing(model_id: &str) -> Option<EffectivePricing> {
    let normalized = match model_id {
        "gpt-5.6" | "gpt-5.6-low" | "gpt-5.6-medium" | "gpt-5.6-high" | "gpt-5.6-xhigh"
        | "gpt-5.6-minimal" => "gpt-5.6-sol",
        other => other,
    };
    let (input, output, cache_read, cache_write) = match normalized {
        "gpt-5.6-sol" => (5e-6, 30e-6, 0.5e-6, 6.25e-6),
        "gpt-5.6-terra" => (2e-6, 12e-6, 0.2e-6, 2.5e-6),
        "gpt-5.6-luna" => (0.2e-6, 1.2e-6, 0.02e-6, 0.25e-6),
        _ => return None,
    };
    Some(EffectivePricing {
        input,
        output,
        cache_read,
        cache_write,
        long_context_threshold: Some(GPT56_LONG_CONTEXT_THRESHOLD),
        long_input_multiplier: GPT56_LONG_INPUT_MULTIPLIER,
        long_output_multiplier: GPT56_LONG_OUTPUT_MULTIPLIER,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(input: i64, cache_read: i64, cache_write: i64, output: i64) -> Metrics {
        Metrics {
            input,
            cache_read,
            cache_write,
            output,
            ..Default::default()
        }
    }

    #[test]
    fn gpt56_sol_uses_guarded_base_card() {
        let book = PriceBook {
            catalog: HashMap::new(),
            catalog_state: "test",
        };
        let quote = book.quote(
            "gpt-5.6-sol",
            Some("standard"),
            &metrics(100_000, 50_000, 10_000, 10_000),
        );
        assert!((quote.cost_usd - 0.8875).abs() < 1e-9);
        assert!(!quote.lower_bound);
    }

    #[test]
    fn gpt56_fast_keeps_base_usd_card() {
        let book = PriceBook {
            catalog: HashMap::new(),
            catalog_state: "test",
        };
        let quote = book.quote(
            "gpt-5.6-sol",
            Some("fast"),
            &metrics(100_000, 50_000, 10_000, 10_000),
        );
        assert!((quote.cost_usd - 0.8875).abs() < 1e-9);
        assert!(!quote.lower_bound);
    }

    #[test]
    fn gpt56_long_context_multiplies_all_input_side_buckets() {
        let book = PriceBook {
            catalog: HashMap::new(),
            catalog_state: "test",
        };
        let quote = book.quote(
            "gpt-5.6-sol",
            Some("standard"),
            &metrics(280_000, 10_000, 0, 10_000),
        );
        let expected = 280_000.0 * 5e-6 * 2.0 + 10_000.0 * 0.5e-6 * 2.0 + 10_000.0 * 30e-6 * 1.5;
        assert!((quote.cost_usd - expected).abs() < 1e-9);
    }

    #[test]
    fn unknown_model_is_not_guessed() {
        let book = PriceBook {
            catalog: HashMap::new(),
            catalog_state: "test",
        };
        let quote = book.quote("definitely-unknown", None, &metrics(100, 0, 0, 10));
        assert_eq!(quote.cost_usd, 0.0);
        assert!(quote.lower_bound);
    }

    #[test]
    fn canonical_provider_wins_duplicate_models_dev_entries() {
        let json = br#"{
          "other": {"models":{"gpt-test":{"cost":{"input":99,"output":99}}}},
          "openai": {"models":{"gpt-test":{"cost":{"input":5,"output":30}}}}
        }"#;
        let catalog = parse_models_dev(json).unwrap();
        let price = catalog.get("gpt-test").unwrap();
        assert!((price.input - 5e-6).abs() < 1e-12);
    }
}
