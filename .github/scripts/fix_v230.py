from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


# 1) Provider routing: official status must come from locally observed base URL/domain,
# never merely from a provider label. The raw URL is not persisted anywhere.
p = Path("rust-cli/src/provider.rs")
text = p.read_text()
old_route = re.search(r"pub fn route_hint_from_base_url\(provider_id: &str, base_url: &str\) -> RouteHint \{.*?\n\}\n\n/// Classify a route conservatively", text, re.S)
if not old_route:
    raise SystemExit("missing patch anchor: route_hint_from_base_url")
new_route = r'''fn parsed_host(base_url: &str) -> Option<String> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = reqwest::Url::parse(raw)
        .or_else(|_| reqwest::Url::parse(&format!("https://{raw}")))
        .ok()?;
    parsed.host_str().map(|host| host.trim_end_matches('.').to_ascii_lowercase())
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn official_vendor_for_host(host: &str) -> Option<&'static str> {
    if host_is(host, "openai.com") || host_is(host, "chatgpt.com") {
        return Some("openai");
    }
    if host_is(host, "anthropic.com") {
        return Some("anthropic");
    }
    if host == "generativelanguage.googleapis.com" {
        return Some("google");
    }
    if host_is(host, "deepseek.com") {
        return Some("deepseek");
    }
    if host_is(host, "x.ai") {
        return Some("xai");
    }
    if host_is(host, "mistral.ai") {
        return Some("mistral");
    }
    if host_is(host, "moonshot.ai") || host_is(host, "moonshot.cn") {
        return Some("moonshotai");
    }
    None
}

pub fn route_hint_from_base_url(provider_id: &str, base_url: &str) -> RouteHint {
    let id = norm(provider_id);
    let host = parsed_host(base_url).unwrap_or_default();

    // Domain checks are host-aware so values such as `api.openai.com.evil.example`
    // cannot be mistaken for an official endpoint. Only the normalized result is
    // retained; the raw URL remains local and is never written into the ledger.
    if official_vendor_for_host(&host).is_some() {
        return RouteHint {
            route_provider: "official".into(),
            route_type: "official".into(),
        };
    }
    if host.contains("openai.azure.com") || host_is(&host, "azure.com") {
        return RouteHint {
            route_provider: "azure-openai".into(),
            route_type: "cloud".into(),
        };
    }
    if host.contains("bedrock") || host_is(&host, "amazonaws.com") {
        return RouteHint {
            route_provider: "aws-bedrock".into(),
            route_type: "cloud".into(),
        };
    }
    if host == "aiplatform.googleapis.com" || host.contains("vertex") {
        return RouteHint {
            route_provider: "google-vertex".into(),
            route_type: "cloud".into(),
        };
    }
    if host_is(&host, "openrouter.ai") {
        return RouteHint {
            route_provider: "openrouter".into(),
            route_type: "aggregator".into(),
        };
    }
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "0.0.0.0" | "::1") {
        return RouteHint {
            route_provider: "local".into(),
            route_type: "self-hosted".into(),
        };
    }

    let classified = classify(Some(&id), "unknown", true, None);
    if classified.route_type != "official" && classified.route_type != "unknown" {
        return RouteHint {
            route_provider: classified.route_provider,
            route_type: classified.route_type,
        };
    }
    RouteHint {
        route_provider: if id.is_empty() || official_provider_name(&id).is_some() {
            "custom-relay".into()
        } else {
            id
        },
        route_type: "relay".into(),
    }
}

/// Classify a route conservatively'''
text = text[:old_route.start()] + new_route + text[old_route.end():]
text = text.replace(
    "/// URL wins. Otherwise first-party `official` is used only when the source\n/// session itself explicitly named that provider.",
    "/// URL wins. A provider name alone never proves a first-party route; `official`\n/// requires locally observed endpoint-domain evidence.",
)
text = replace_once(
    text,
    '''    if explicit {
        if official_provider_name(&raw).is_some() {
            return official_identity(upstream_vendor);
        }
        return ProviderIdentity {
            upstream_vendor,
            route_provider: raw,
            route_type: "custom".into(),
        };
    }
''',
    '''    if explicit {
        // Provider labels identify an implementation/vendor, not the network path.
        // Do not claim `official` unless a locally observed base URL produced a hint.
        if official_provider_name(&raw).is_some() {
            return ProviderIdentity {
                upstream_vendor,
                route_provider: raw,
                route_type: "unknown".into(),
            };
        }
        return ProviderIdentity {
            upstream_vendor,
            route_provider: raw,
            route_type: "custom".into(),
        };
    }
''',
    "provider-name-not-proof",
)
text = text.replace(
    '''    fn proven_first_party_route_uses_one_official_bucket() {
        let openai = classify(Some("openai"), "gpt-5.6-sol", true, None);
        assert_eq!(openai.upstream_vendor, "openai");
        assert_eq!(openai.route_provider, "official");
        assert_eq!(openai.route_type, "official");

        let anthropic = classify(Some("anthropic"), "claude-sonnet-4", true, None);
        assert_eq!(anthropic.upstream_vendor, "anthropic");
        assert_eq!(anthropic.route_provider, "official");
        assert_eq!(anthropic.route_type, "official");
    }
''',
    '''    fn provider_name_alone_does_not_prove_official_route() {
        let openai = classify(Some("openai"), "gpt-5.6-sol", true, None);
        assert_eq!(openai.upstream_vendor, "openai");
        assert_eq!(openai.route_provider, "openai");
        assert_eq!(openai.route_type, "unknown");
    }
''',
)
insert_test = '''
    #[test]
    fn lookalike_domain_is_not_official() {
        let hint = route_hint_from_base_url("openai", "https://api.openai.com.evil.example/v1");
        assert_eq!(hint.route_type, "relay");
    }
'''
text = text.replace("\n    #[test]\n    fn custom_openai_base_url_overrides_official_name()", insert_test + "\n    #[test]\n    fn custom_openai_base_url_overrides_official_name()")
p.write_text(text)


# 2) Evidence scanner: recover base URL/endpoint locally for all text-config clients,
# immediately reduce it to a route hint, and never persist the URL itself.
p = Path("rust-cli/src/evidence.rs")
text = p.read_text()
helper_anchor = '''fn parse_json_candidate(line: &str) -> Option<Value> {
'''
route_helpers = r'''fn recursive_string_for_keys(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let normalized = normalized_key(key);
                if keys.contains(&normalized.as_str()) {
                    if let Some(text) = child.as_str().filter(|value| !value.trim().is_empty()) {
                        return Some(text.trim().to_string());
                    }
                }
            }
            object.values().find_map(|child| recursive_string_for_keys(child, keys, depth + 1))
        }
        Value::Array(items) => items.iter().find_map(|child| recursive_string_for_keys(child, keys, depth + 1)),
        _ => None,
    }
}

fn register_route(client: &str, path: &Path, value: &Value, bundle: &mut EvidenceBundle) {
    let Some(base_url) = recursive_string_for_keys(
        value,
        &["baseurl", "apibase", "apiurl", "endpoint", "apiendpoint", "providerurl", "modelendpoint"],
        0,
    ) else {
        return;
    };
    if !base_url.contains('.') && !base_url.contains("localhost") {
        return;
    }
    let provider = recursive_string_for_keys(
        value,
        &["provider", "providerid", "modelprovider", "providername"],
        0,
    )
    .unwrap_or_else(|| "unknown".to_string());
    let hint = route_hint_from_base_url(&provider, &base_url);

    let mut ids = fallback_ids(path);
    collect_session_ids(value, &mut ids, 0);
    if ids.is_empty() {
        if provider != "unknown" {
            bundle.provider_hints.insert(provider.to_ascii_lowercase(), hint);
        }
        return;
    }
    for id in ids {
        let entry = bundle.sessions.entry((client.to_string(), id)).or_default();
        if provider != "unknown" {
            entry.explicit_provider = Some(provider.clone());
        }
        entry.route_hint = Some(hint.clone());
    }
}

'''
text = replace_once(text, helper_anchor, route_helpers + helper_anchor, "generic-route-helper")
text = replace_once(
    text,
    '''    if extension == "json" {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                register_effort(client, path, &value, bundle);
            }
        }
        return;
    }
''',
    '''    if extension == "json" {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                register_effort(client, path, &value, bundle);
                register_route(client, path, &value, bundle);
            }
        }
        return;
    }
    if extension == "toml" {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(value) = raw.parse::<toml::Value>() {
                if let Ok(json_value) = serde_json::to_value(value) {
                    register_effort(client, path, &json_value, bundle);
                    register_route(client, path, &json_value, bundle);
                }
            }
        }
        return;
    }
''',
    "json-toml-route-scan",
)
text = replace_once(
    text,
    '''        let lower = line.to_ascii_lowercase();
        if !lower.contains("reasoning") && !lower.contains("thinking") {
            continue;
        }
        if let Some(value) = parse_json_candidate(&line) {
            register_effort(client, path, &value, bundle);
        }
''',
    '''        let lower = line.to_ascii_lowercase();
        let has_effort = lower.contains("reasoning") || lower.contains("thinking");
        let has_route = lower.contains("base_url")
            || lower.contains("baseurl")
            || lower.contains("api_url")
            || lower.contains("apiurl")
            || lower.contains("endpoint");
        if !has_effort && !has_route {
            continue;
        }
        if let Some(value) = parse_json_candidate(&line) {
            if has_effort {
                register_effort(client, path, &value, bundle);
            }
            if has_route {
                register_route(client, path, &value, bundle);
            }
        }
''',
    "line-route-scan",
)
text = text.replace('        "json" | "jsonl" | "ndjson" | "log"', '        "json" | "jsonl" | "ndjson" | "log" | "toml"')
# Add explicit regression test: route hint stores classification only, not URL.
route_test = r'''
    #[test]
    fn route_evidence_reduces_base_url_to_local_classification() {
        let mut bundle = EvidenceBundle::default();
        let value: Value = serde_json::json!({
            "sessionId": "s-route",
            "provider": "openai",
            "baseUrl": "https://api.openai.com/v1"
        });
        register_route("codebuddy", Path::new("/tmp/s-route.json"), &value, &mut bundle);
        let evidence = bundle.sessions.get(&("codebuddy".to_string(), "s-route".to_string())).unwrap();
        assert_eq!(evidence.route_hint.as_ref().unwrap().route_type, "official");
        assert_eq!(evidence.explicit_provider.as_deref(), Some("openai"));
    }
'''
text = text.replace("\n    #[test]\n    fn effort_extractor_reads_common_shapes_without_guessing_content()", route_test + "\n    #[test]\n    fn effort_extractor_reads_common_shapes_without_guessing_content()")
p.write_text(text)


# 3) Collector: use per-date official pricing and generic local route hints.
p = Path("rust-cli/src/collector.rs")
text = p.read_text()
text = replace_once(
    text,
    '    let quote = price_book.quote(model, Some("standard"), &metrics);',
    '    let quote = price_book.quote_on_date(model, &message.date, Some("standard"), &metrics);',
    "canonical-date-pricing",
)
text = replace_once(
    text,
    '''    let identity = provider::classify(
        Some(raw_provider),
        model,
        explicit,
        session_evidence.and_then(|item| item.route_hint.as_ref()),
    );
''',
    '''    let route_hint = session_evidence
        .and_then(|item| item.route_hint.as_ref())
        .or_else(|| evidence.provider_hints.get(&raw_provider.to_ascii_lowercase()));
    let identity = provider::classify(Some(raw_provider), model, explicit, route_hint);
''',
    "generic-provider-hint-fallback",
)
text = replace_once(
    text,
    '        let quote = price_book.quote(&model, Some(&enhanced.tier), &metrics);',
    '        let quote = price_book.quote_on_date(&model, &enhanced.date, Some(&enhanced.tier), &metrics);',
    "enhanced-date-pricing",
)
text = text.replace(
    '''        // If Codex did not record cache-write separately, the normalized fresh
        // input can contain some cache creation. CC Switch charges GPT-5.6 cache
        // creation at 1.25x input, so the result is explicitly marked as a lower
        // bound rather than pretending to be exact.
''',
    '''        // If Codex did not record cache-write separately, the normalized fresh
        // input can contain cache creation. GPT-5.6 official API docs bill cache
        // writes at 1.25x uncached input, so this remains a lower bound.
''',
)
p.write_text(text)


# 4) Pricing: official OpenAI cards take precedence, effective-date aware;
# models.dev remains fallback for other models.
p = Path("rust-cli/src/pricing.rs")
text = p.read_text()
text = replace_once(
    text,
    '''const MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const PRICING_POLICY: &str = "api-equivalent-estimate-v3";
''',
    '''const MODELS_DEV_URL: &str = "https://models.dev/api.json";
const OPENAI_GPT56_SOL_URL: &str = "https://developers.openai.com/api/docs/models/gpt-5.6-sol";
pub const PRICING_POLICY: &str = "official-time-aware-api-estimate-v4";
const GPT56_SOL_PROMO_EFFECTIVE: &str = "2026-08-21";
const GPT56_TERRA_LUNA_REPRICE_EFFECTIVE: &str = "2026-07-30";
''',
    "pricing-policy-v4",
)
text = text.replace(
    '            source: format!("CC Switch compatible · {}", self.catalog_state),\n            source_url: MODELS_DEV_URL.to_string(),\n            compatibility: "GPT-5.6 guarded base rates; speed tier is recorded separately and does not multiply USD cost"\n                .to_string(),',
    '            source: format!("OpenAI official GPT-5.6 cards + models.dev fallback · {}", self.catalog_state),\n            source_url: OPENAI_GPT56_SOL_URL.to_string(),\n            compatibility: "GPT-5.6 pricing is effective-date aware; explicit Fast/Priority uses the official API Fast card; unknown models fall back conservatively"\n                .to_string(),',
)
lookup_re = re.search(r"    fn lookup\(&self, model_id: &str\) -> Option<EffectivePricing> \{.*?\n    pub fn quote\(&self, model_id: &str, _tier: Option<&str>, metrics: &Metrics\) -> PriceQuote \{.*?\n    \}\n\}", text, re.S)
if not lookup_re:
    raise SystemExit("missing patch anchor: pricing lookup/quote")
new_lookup = r'''    fn lookup(&self, model_id: &str, date: &str, tier: Option<&str>) -> Option<EffectivePricing> {
        let normalized = normalize_model_id(model_id);
        for alias in lookup_aliases(&normalized) {
            if let Some(official) = guarded_pricing(&alias, date, tier) {
                return Some(official);
            }
            if let Some(pricing) = self.catalog.get(&alias) {
                return Some(*pricing);
            }
        }
        None
    }

    pub fn quote(&self, model_id: &str, tier: Option<&str>, metrics: &Metrics) -> PriceQuote {
        self.quote_on_date(model_id, "9999-12-31", tier, metrics)
    }

    pub fn quote_on_date(
        &self,
        model_id: &str,
        date: &str,
        tier: Option<&str>,
        metrics: &Metrics,
    ) -> PriceQuote {
        let Some(pricing) = self.lookup(model_id, date, tier) else {
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
}'''
text = text[:lookup_re.start()] + new_lookup + text[lookup_re.end():]
guarded_re = re.search(r"/// Guarded GPT-5\.6 API-equivalent base prices\..*?fn guarded_pricing\(model_id: &str\) -> Option<EffectivePricing> \{.*?\n\}\n", text, re.S)
if not guarded_re:
    raise SystemExit("missing patch anchor: guarded_pricing")
new_guarded = r'''/// GPT-5.6 official API price schedule, USD/token.
/// Sources: OpenAI model docs / pricing announcements. The Aug-21 Sol promotion
/// and Jul-30 Terra/Luna repricing are applied by request date. Cache writes are
/// 1.25x uncached input. Explicit Fast/Priority uses the official Fast API card
/// (2x the short-context Standard card); >272K input then applies 2x input-side
/// and 1.5x output to the full request.
fn guarded_pricing(model_id: &str, date: &str, tier: Option<&str>) -> Option<EffectivePricing> {
    let normalized = match model_id {
        "gpt-5.6" | "gpt-5.6-low" | "gpt-5.6-medium" | "gpt-5.6-high" | "gpt-5.6-xhigh"
        | "gpt-5.6-minimal" | "gpt-5.6-max" => "gpt-5.6-sol",
        other => other,
    };
    let observed_date = if date.len() >= 10 { date } else { "9999-12-31" };
    let (input_mtok, cached_mtok, output_mtok) = match normalized {
        "gpt-5.6-sol" if observed_date >= GPT56_SOL_PROMO_EFFECTIVE => (4.0, 0.4, 20.0),
        "gpt-5.6-sol" => (5.0, 0.5, 30.0),
        "gpt-5.6-terra" if observed_date >= GPT56_TERRA_LUNA_REPRICE_EFFECTIVE => (2.0, 0.2, 12.0),
        "gpt-5.6-terra" => (2.5, 0.25, 15.0),
        "gpt-5.6-luna" if observed_date >= GPT56_TERRA_LUNA_REPRICE_EFFECTIVE => (0.2, 0.02, 1.2),
        "gpt-5.6-luna" => (1.0, 0.1, 6.0),
        _ => return None,
    };
    let fast = matches!(
        tier.unwrap_or("standard").trim().to_ascii_lowercase().as_str(),
        "fast" | "priority"
    );
    let speed_multiplier = if fast { 2.0 } else { 1.0 };
    let input = input_mtok * speed_multiplier / 1_000_000.0;
    let cache_read = cached_mtok * speed_multiplier / 1_000_000.0;
    let output = output_mtok * speed_multiplier / 1_000_000.0;
    let cache_write = input * 1.25;
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
'''
text = text[:guarded_re.start()] + new_guarded + text[guarded_re.end():]
text = text.replace('fn gpt56_sol_uses_guarded_base_card()', 'fn gpt56_sol_uses_current_official_promotional_card()')
text = text.replace('assert!((quote.cost_usd - 0.8875).abs() < 1e-9);', 'assert!((quote.cost_usd - 0.67).abs() < 1e-9);', 1)
text = text.replace('fn gpt56_fast_keeps_base_usd_card()', 'fn gpt56_fast_uses_official_fast_api_card()')
# second occurrence of old expected
text = text.replace('assert!((quote.cost_usd - 0.8875).abs() < 1e-9);', 'assert!((quote.cost_usd - 1.34).abs() < 1e-9);', 1)
# Replace long-context expected formula if present.
text = text.replace(
    'let expected = 280_000.0 * 5e-6 * 2.0 + 10_000.0 * 0.5e-6 * 2.0 + 10_000.0 * 30e-6 * 1.5;',
    'let expected = 280_000.0 * 4e-6 * 2.0 + 10_000.0 * 0.4e-6 * 2.0 + 10_000.0 * 20e-6 * 1.5;',
)
# Historical rate regression.
historical_test = r'''
    #[test]
    fn gpt56_sol_preserves_pre_aug21_historical_price() {
        let book = PriceBook { catalog: HashMap::new(), catalog_state: "test" };
        let quote = book.quote_on_date(
            "gpt-5.6-sol",
            "2026-08-20",
            Some("standard"),
            &metrics(100_000, 50_000, 10_000, 10_000),
        );
        assert!((quote.cost_usd - 0.8875).abs() < 1e-9);
        assert!(!quote.lower_bound);
    }

'''
text = text.replace("\n    #[test]\n    fn gpt56_fast_uses_official_fast_api_card()", historical_test + "    #[test]\n    fn gpt56_fast_uses_official_fast_api_card()")
p.write_text(text)


# 5) CLI wording and dashboard: no heuristic official label; price provenance is explicit.
p = Path("rust-cli/src/main.rs")
text = p.read_text().replace("Subscription-equivalent cost: ${:.2}", "API-equivalent estimated cost: ${:.2}")
p.write_text(text)

p = Path("web-ui/src/app.tsx")
text = p.read_text()
route_re = re.search(r"function normalizedRoute\(row: LedgerRow\): \{ provider: string; type: string; label: string \} \{.*?\n\}\n", text, re.S)
if not route_re:
    raise SystemExit("missing patch anchor: normalizedRoute")
new_front_route = r'''function normalizedRoute(row: LedgerRow): { provider: string; type: string; label: string } {
  const provider = String(row.routeProvider || row.provider || 'unknown').trim().toLowerCase();
  const type = String(row.routeType || 'unknown').trim().toLowerCase();
  const vendor = String(row.upstreamVendor || '').trim().toLowerCase();
  if (type === 'official') {
    const vendorLabel = vendor ? vendor.replace(/^./, c => c.toUpperCase()) : '';
    return { provider: 'official', type: 'official', label: vendorLabel ? `官方 · ${vendorLabel}` : '官方' };
  }
  // Never promote a raw provider name such as `openai` to official in the browser.
  // Only the device-side local base-URL mapper may set routeType=official.
  return { provider: provider || 'unknown', type: type || 'unknown', label: String(row.routeProvider || row.provider || '未知') };
}
'''
text = text[:route_re.start()] + new_front_route + text[route_re.end():]
text = text.replace("const LEDGER_PRICING_SOURCE_URL = 'https://models.dev/api.json';", "const LEDGER_PRICING_SOURCE_URL = 'https://developers.openai.com/api/docs/models/gpt-5.6-sol';")
text = text.replace("source: 'UsageMesh ledger · CC Switch compatible / models.dev',", "source: 'UsageMesh ledger · OpenAI official cards / models.dev fallback',")
text = text.replace(
    '设备端计价与 CC Switch 口径兼容，通用模型目录来自 models.dev，并对 CodeBuddy/WorkBuddy 等客户端的内部模型后缀（如 `-ioa`）做保守别名归一；GPT-5.6 Sol 审计基准为每 1M Tokens：输入 $5.00、Cache Read $0.50、Cache Write $6.25、输出 $30.00。Fast / Priority 只作为速率/Tier 元数据保留，不再乘进美元费用；这样网站与设备端统一账本保持同一 API 等价计费口径。',
    '设备端优先采用模型厂商官方价格卡，其他模型再回退 models.dev；CodeBuddy/WorkBuddy 等客户端的内部模型后缀（如 `-ioa`）仅做保守查价别名。GPT-5.6 Sol 会按请求日期套用官方有效期价格：2026-08-21 起 Standard 为输入 $4.00、Cache Read $0.40、Cache Write $5.00、输出 $20.00；更早历史请求仍使用当时官方价格。明确标记为 Fast / Priority 的请求按官方 Fast API 价格卡计价，Standard 不会误乘 Fast 倍率；>272K 输入的请求按官方长上下文规则处理。',
)
p.write_text(text)


# 6) Documentation and release version.
p = Path("docs/PRICING.md")
p.write_text('''# Cost semantics

UsageMesh reports an **estimated API-equivalent USD cost**. It is an estimate, not a provider invoice and not a subscription-quota meter.

## Source of truth and precedence

Token parsing, cache buckets, request boundaries and route evidence are resolved on the device before encryption. Pricing precedence is:

1. **Official upstream model price cards** when UsageMesh has an audited rule for the model family.
2. `models.dev` as the general-model fallback.
3. A lower-bound marker (`≥`) when a bucket/model cannot be priced reliably.

The hosted Dashboard never re-prices aggregate rows in the browser; it displays the request/device-side cost already written into the encrypted ledger.

For GPT-5.6, UsageMesh follows the official OpenAI model documentation and effective dates. GPT-5.6 Sol Standard requests on/after **2026-08-21** use **$4.00 input / $0.40 cached input / $20.00 output per 1M tokens**. Cache writes are **1.25x uncached input**, therefore **$5.00/1M** at that Sol rate. Requests before that effective date keep the prior official **$5.00 / $0.50 / $30.00** card and **$6.25/1M** cache-write rate. Terra/Luna's 2026-07-30 repricing is handled the same way.

Official reference: https://developers.openai.com/api/docs/models/gpt-5.6-sol

## Speed tier

UsageMesh never guesses Fast from model name or performance. `Standard`, `Fast` and `Priority` come from local request evidence. A Standard request uses the Standard card. Explicit API `Fast`/`Priority` requests use the official Fast API price card; they are not given the old blanket 2.5x multiplier.

GPT-5.6 requests above 272K input tokens use OpenAI's documented long-context rule for the full request (2x input-side and 1.5x output-side pricing).

## Route / official-provider classification

`official` is not inferred merely because a parser says `provider=openai` or `provider=anthropic`. UsageMesh attempts to read the request/base endpoint locally. It parses the hostname and immediately reduces it to a non-sensitive route classification such as `official`, `openrouter`, `azure-openai`, `aws-bedrock`, `local`, or `custom-relay`.

**The raw base URL is never written into the UsageMesh ledger, pair code, index, or GitHub repository.** Only the normalized route label/type can leave the machine. Host matching is boundary-aware, so a lookalike domain such as `api.openai.com.evil.example` is not accepted as official.

If a client does not expose a usable endpoint locally, UsageMesh leaves the route unverified/unknown rather than falsely claiming it is official.

## Pricing-policy migration

A pricing-policy change invalidates historical stored `costUsd` values. On the first sync after an accounting-policy upgrade, UsageMesh automatically performs a full local rescan/reprice before publishing the encrypted ledger. This prevents old dates from retaining a previous price card.

## Client model aliases

Some coding clients expose internal model suffixes. Exact model IDs are attempted first; conservative lookup-only aliases are used only as fallback. For example, `deepseek-v4-flash-ioa` may fall back to `deepseek-v4-flash` when the exact ID is absent. Unknown models remain lower bounds rather than being guessed.
''')

p = Path("README.zh-CN.md")
r = p.read_text()
r = r.replace(
    'Dashboard 展示的是**API 等价美元费用估算**，不是供应商发票，也不把 Fast / Priority 的订阅额度倍率混入美元费用。计费策略版本变化时，设备下一次同步会自动执行一次全量历史重算，避免旧账本日期继续保留旧费用。CodeBuddy/WorkBuddy 这类客户端的内部模型后缀（例如 `deepseek-v4-flash-ioa`）会在精确匹配失败后映射到对应的 canonical 模型；仍无法可靠计价的记录会让总费用显示 `≥`，不会伪装成精确值。具体规则从主 README 中移出，统一放在 [docs/PRICING.md](docs/PRICING.md)。',
    'Dashboard 展示的是**API 等价美元费用估算**，优先采用模型厂商官方价格卡并按生效日期重算历史；通用模型再回退 `models.dev`。例如 GPT-5.6 Sol 在 2026-08-21 起使用 OpenAI 当前官方促销价，旧日期仍保留当时的官方价格。Standard 不会误乘 Fast 倍率，只有本地请求证据明确为 Fast/Priority 时才使用对应官方 Fast API 价格。路由的“官方”标签也只由设备端读取到的 base URL/endpoint 域名本地判定，**原始 URL 不上传 GitHub**，只上传 `official/openrouter/relay/...` 这类归一化标签。具体规则见 [docs/PRICING.md](docs/PRICING.md)。',
)
p.write_text(r)

p = Path("README.md")
r = p.read_text()
marker = "## Pricing"
if marker in r and "official price cards" not in r.lower():
    idx = r.index(marker)
    # Keep the existing section, just inject one concise policy paragraph after heading.
    line_end = r.find("\n", idx) + 1
    r = r[:line_end] + "\nUsageMesh prefers official upstream model price cards with effective-date-aware historical repricing, then falls back to `models.dev`. Official route labels require locally observed base-URL/domain evidence; the raw URL never leaves the device.\n" + r[line_end:]
p.write_text(r)

# Version bump. Cargo will refresh root Cargo.lock during verification.
p = Path("rust-cli/Cargo.toml")
p.write_text(p.read_text().replace('version = "2.2.4"', 'version = "2.3.0"', 1))

# Strengthen CI invariants to prevent regression back to provider-name heuristics/stale pricing.
p = Path(".github/workflows/rust-cli-ci.yml")
ci = p.read_text()
ci = ci.replace(
    "          grep -q 'thinkingbudget' rust-cli/src/evidence.rs\n",
    "          grep -q 'thinkingbudget' rust-cli/src/evidence.rs\n          grep -q 'route_hint_from_base_url' rust-cli/src/evidence.rs\n          grep -q 'official-time-aware-api-estimate-v4' rust-cli/src/pricing.rs\n          grep -q 'GPT56_SOL_PROMO_EFFECTIVE' rust-cli/src/pricing.rs\n",
)
p.write_text(ci)

print("v2.3.0 patch applied")
