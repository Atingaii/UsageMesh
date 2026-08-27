from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing follow-up anchor: {label}")
    return text.replace(old, new, 1)


# Evidence bundle: keep a client-wide route classification for global client settings.
# The raw endpoint itself never enters this structure.
p = Path("rust-cli/src/evidence.rs")
text = p.read_text()
text = replace_once(
    text,
    '''    pub provider_hints: HashMap<String, RouteHint>,
    /// Request/session reasoning configuration recovered from local source logs.
''',
    '''    pub provider_hints: HashMap<String, RouteHint>,
    /// Client-wide route evidence derived locally from global settings/env. Values
    /// contain only normalized labels/types; raw endpoint URLs are never retained.
    pub client_route_hints: HashMap<String, RouteHint>,
    /// Request/session reasoning configuration recovered from local source logs.
''',
    "client-route-hints-field",
)

# Add CodeBuddy's documented settings files and environment override. Tokscale's
# accounting root is ~/.codebuddy/projects, so these parent-level settings need
# an explicit local-only evidence pass.
anchor = '''fn parse_json_candidate(line: &str) -> Option<Value> {
'''
helper = r'''fn route_hint_from_settings_value(value: &Value) -> Option<RouteHint> {
    let base_url = recursive_string_for_keys(
        value,
        &[
            "codebuddybaseurl",
            "baseurl",
            "apibase",
            "apiurl",
            "endpoint",
            "apiendpoint",
            "providerurl",
            "modelendpoint",
        ],
        0,
    )?;
    if !base_url.contains('.') && !base_url.contains("localhost") {
        return None;
    }
    let provider = recursive_string_for_keys(
        value,
        &["provider", "providerid", "modelprovider", "providername"],
        0,
    )
    .unwrap_or_else(|| "unknown".to_string());
    Some(route_hint_from_base_url(&provider, &base_url))
}

fn scan_codebuddy_global_route(home: &Path, bundle: &mut EvidenceBundle) {
    // settings.local.json has higher precedence and therefore runs second.
    for path in [
        home.join(".codebuddy/settings.json"),
        home.join(".codebuddy/settings.local.json"),
    ] {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(hint) = route_hint_from_settings_value(&value) {
            bundle.client_route_hints.insert("codebuddy".to_string(), hint);
        }
    }

    // Environment overrides file settings. Reduce it immediately to a route hint;
    // do not copy CODEBUDDY_BASE_URL into the evidence bundle or ledger.
    if let Ok(base_url) = std::env::var("CODEBUDDY_BASE_URL") {
        if !base_url.trim().is_empty() {
            bundle.client_route_hints.insert(
                "codebuddy".to_string(),
                route_hint_from_base_url("unknown", base_url.trim()),
            );
        }
    }
}

'''
text = replace_once(text, anchor, helper + anchor, "codebuddy-global-route-helper")
text = replace_once(
    text,
    '''    bundle.provider_hints = codex_provider_hints(&home);

    for root in [
''',
    '''    bundle.provider_hints = codex_provider_hints(&home);
    scan_codebuddy_global_route(&home, &mut bundle);

    for root in [
''',
    "scan-codebuddy-global-route",
)

# Test global-settings extraction without exposing a raw URL field.
test_anchor = '''    #[test]
    fn route_evidence_reduces_base_url_to_local_classification() {
'''
test = r'''    #[test]
    fn codebuddy_settings_base_url_becomes_client_route_only() {
        let value: Value = serde_json::json!({
            "env": { "CODEBUDDY_BASE_URL": "https://api.openai.com/v1" }
        });
        let hint = route_hint_from_settings_value(&value).unwrap();
        assert_eq!(hint.route_provider, "official");
        assert_eq!(hint.route_type, "official");
    }

'''
text = replace_once(text, test_anchor, test + test_anchor, "codebuddy-route-test")
p.write_text(text)


# Collector precedence: session-specific endpoint > provider config > client-global endpoint.
p = Path("rust-cli/src/collector.rs")
text = p.read_text()
text = replace_once(
    text,
    '''    let route_hint = session_evidence
        .and_then(|item| item.route_hint.as_ref())
        .or_else(|| evidence.provider_hints.get(&raw_provider.to_ascii_lowercase()));
''',
    '''    let route_hint = session_evidence
        .and_then(|item| item.route_hint.as_ref())
        .or_else(|| evidence.provider_hints.get(&raw_provider.to_ascii_lowercase()))
        .or_else(|| evidence.client_route_hints.get(client));
''',
    "collector-client-route-fallback",
)
# Remove an import that became unused after pricing metadata moved fully into the ledger.
text = text.replace("DeviceInfo, Ledger, Metrics, PricingInfo, RequestDetail, UsageRow", "DeviceInfo, Ledger, Metrics, RequestDetail, UsageRow")
p.write_text(text)


# Unknown provider + a concrete non-official endpoint should be a custom relay,
# not a misleading route provider literally named `unknown`.
p = Path("rust-cli/src/provider.rs")
text = p.read_text()
text = text.replace(
    'route_provider: if id.is_empty() || official_provider_name(&id).is_some() {',
    'route_provider: if id.is_empty() || id == "unknown" || official_provider_name(&id).is_some() {',
)
p.write_text(text)


# JSX text cannot contain this raw comparison token in the generated paragraph.
p = Path("web-ui/src/app.tsx")
text = p.read_text().replace(">272K 输入的请求", "272K 以上输入的请求")
p.write_text(text)

# Keep Dashboard package metadata aligned with the CLI release.
for name in ["web-ui/package.json", "web-ui/package-lock.json"]:
    p = Path(name)
    p.write_text(p.read_text().replace('"version": "2.2.4"', '"version": "2.3.0"'))

print("v2.3.0 follow-up patch applied")
