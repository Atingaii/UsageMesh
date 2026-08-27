use serde::{Deserialize, Serialize};

pub const CURRENT_LEDGER_SCHEMA_VERSION: u32 = 4;

fn is_false(value: &bool) -> bool {
    !*value
}

/// Additive accounting metrics only. These are the dimensions Tokscale exposes
/// with stable semantics across clients and that can be safely summed across
/// date/model/provider/device rows.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    pub messages: i32,
    pub cost_usd: f64,
}

impl Metrics {
    pub fn total_tokens(&self) -> i64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
            .saturating_add(self.reasoning)
    }

    pub fn add(&mut self, other: &Metrics) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.reasoning = self.reasoning.saturating_add(other.reasoning);
        self.messages = self.messages.saturating_add(other.messages);
        self.cost_usd += other.cost_usd;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub date: String,
    pub client: String,
    /// Raw provider/routing identity emitted by the source parser. Kept for auditability.
    pub provider: String,
    /// Normalized upstream model vendor (OpenAI, Anthropic, Google, etc.).
    pub upstream_vendor: String,
    /// Normalized routing/billing provider (official vendor, AWS Bedrock, Azure, OpenRouter, relay, etc.).
    pub route_provider: String,
    /// One of official, cloud, aggregator, relay, inference-provider, self-hosted, custom, unknown.
    pub route_type: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// True when the mature pricing source cannot fully price every observed token bucket.
    #[serde(default, skip_serializing_if = "is_false")]
    pub cost_lower_bound: bool,
    #[serde(flatten)]
    pub metrics: Metrics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricingInfo {
    /// Human-readable accounting policy shown by the dashboard.
    pub policy: String,
    /// Mature implementation / dataset family used as the pricing source of truth.
    pub source: String,
    /// Public upstream data source used for the general model catalog.
    pub source_url: String,
    /// Pinned compatibility note for guarded model families such as GPT-5.6.
    pub compatibility: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub schema_version: u32,
    pub generated_at: String,
    pub device: DeviceInfo,
    pub rows: Vec<UsageRow>,
    pub totals: Metrics,
    pub scan_ms: u64,
    #[serde(default)]
    pub pricing: PricingInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedLedger {
    pub schema_version: u32,
    pub kind: String,
    pub device_hash: String,
    pub updated_at: String,
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
}

/// Small password-wrapped manifest stored on `um-dashboard`.
/// It never contains prompts or usage data; it only wraps the existing random
/// workspace dashboard key so users can unlock the same static dashboard from
/// any browser with one memorable password instead of a long URL fragment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAccessEnvelope {
    pub schema_version: u32,
    pub kind: String,
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
    pub updated_at: String,
}
