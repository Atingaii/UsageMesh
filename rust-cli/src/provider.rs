#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderIdentity {
    pub upstream_vendor: String,
    pub route_provider: String,
    pub route_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteHint {
    pub route_provider: String,
    pub route_type: String,
}

fn norm(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace([' ', '_'], "-")
}

pub fn infer_upstream_vendor(model: &str) -> String {
    let m = norm(model);
    if m.contains("claude")
        || m.contains("anthropic")
        || m.contains("sonnet")
        || m.contains("opus")
        || m.contains("haiku")
    {
        return "anthropic".into();
    }
    if m.contains("gpt")
        || m.contains("openai")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.contains("codex")
    {
        return "openai".into();
    }
    if m.contains("gemini") || m.contains("google") {
        return "google".into();
    }
    if m.contains("grok") {
        return "xai".into();
    }
    if m.contains("deepseek") {
        return "deepseek".into();
    }
    if m.contains("minimax") {
        return "minimax".into();
    }
    if m.contains("mistral") || m.contains("mixtral") {
        return "mistral".into();
    }
    if m.contains("llama") || m.starts_with("meta-") {
        return "meta".into();
    }
    if m.contains("qwen") {
        return "qwen".into();
    }
    if m.contains("kimi") || m.starts_with("k2") || m.starts_with("k3") {
        return "moonshotai".into();
    }
    if m.contains("glm") {
        return "zai".into();
    }
    if m.contains("mimo") {
        return "xiaomi".into();
    }
    if m.contains("command-r") || m.contains("cohere") {
        return "cohere".into();
    }
    if m.contains("nova-") || m.starts_with("amazon.") {
        return "amazon".into();
    }
    "unknown".into()
}

fn official_provider_name(raw: &str) -> Option<&'static str> {
    match raw {
        "openai" | "openai-codex" => Some("openai"),
        "anthropic" => Some("anthropic"),
        "google" | "gemini" | "google-ai" => Some("google"),
        "xai" | "x-ai" => Some("xai"),
        "deepseek" | "deepseek-ai" => Some("deepseek"),
        "moonshot" | "moonshotai" | "kimi" | "kimi-for-coding" => Some("moonshotai"),
        "zai" | "z-ai" | "zhipu" | "bigmodel" => Some("zai"),
        "minimax" | "minimax-ai" => Some("minimax"),
        "mistral" | "mistralai" => Some("mistral"),
        "cohere" => Some("cohere"),
        "qwen" | "dashscope" | "alibaba" | "aliyun" => Some("qwen"),
        _ => None,
    }
}

fn official_identity(upstream_vendor: String) -> ProviderIdentity {
    // `provider` on UsageRow preserves the source's raw provider identifier for
    // auditing. Once route evidence proves a first-party route, the normalized
    // route-provider dimension intentionally collapses vendor-specific labels to
    // one canonical `official` bucket. The upstream vendor remains available in
    // `upstreamVendor`, so no useful dimension is lost and the dashboard cannot
    // misleadingly show a first-party request as a custom provider.
    ProviderIdentity {
        upstream_vendor,
        route_provider: "official".into(),
        route_type: "official".into(),
    }
}

pub fn route_hint_from_base_url(provider_id: &str, base_url: &str) -> RouteHint {
    let id = norm(provider_id);
    let url = base_url.trim().to_ascii_lowercase();
    if url.contains("api.openai.com")
        || url.contains("api.anthropic.com")
        || url.contains("generativelanguage.googleapis.com")
    {
        return RouteHint {
            route_provider: "official".into(),
            route_type: "official".into(),
        };
    }
    if url.contains("openai.azure.com") || url.contains("azure.com/openai") {
        return RouteHint {
            route_provider: "azure-openai".into(),
            route_type: "cloud".into(),
        };
    }
    if url.contains("bedrock") || url.contains("amazonaws.com") {
        return RouteHint {
            route_provider: "aws-bedrock".into(),
            route_type: "cloud".into(),
        };
    }
    if url.contains("aiplatform.googleapis.com") || url.contains("vertex") {
        return RouteHint {
            route_provider: "google-vertex".into(),
            route_type: "cloud".into(),
        };
    }
    if url.contains("openrouter.ai") {
        return RouteHint {
            route_provider: "openrouter".into(),
            route_type: "aggregator".into(),
        };
    }
    if url.contains("localhost") || url.contains("127.0.0.1") || url.contains("0.0.0.0") {
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
    // A non-official custom base URL is strong evidence of a relay even when the
    // provider key itself is simply named `openai` or `anthropic`.
    RouteHint {
        route_provider: if id.is_empty() || official_provider_name(&id).is_some() {
            "custom-relay".into()
        } else {
            id
        },
        route_type: "relay".into(),
    }
}

/// Classify a route conservatively. A route hint obtained from an explicit base
/// URL wins. Otherwise first-party `official` is used only when the source
/// session itself explicitly named that provider.
pub fn classify(
    raw_provider: Option<&str>,
    model: &str,
    explicit: bool,
    hint: Option<&RouteHint>,
) -> ProviderIdentity {
    let upstream_vendor = infer_upstream_vendor(model);
    if let Some(hint) = hint {
        if hint.route_type == "official" {
            return official_identity(upstream_vendor);
        }
        return ProviderIdentity {
            upstream_vendor,
            route_provider: hint.route_provider.clone(),
            route_type: hint.route_type.clone(),
        };
    }
    let raw = raw_provider
        .map(norm)
        .filter(|value| !value.is_empty() && value != "unknown");
    let Some(raw) = raw else {
        return ProviderIdentity {
            upstream_vendor,
            route_provider: "unknown".into(),
            route_type: "unknown".into(),
        };
    };

    let cloud = [
        (
            ["aws", "bedrock", "amazon-bedrock"].as_slice(),
            "aws-bedrock",
        ),
        (
            ["azure", "azure-ai", "azure-openai"].as_slice(),
            "azure-openai",
        ),
        (
            ["vertex", "vertex-ai", "google-vertex", "gcp-vertex"].as_slice(),
            "google-vertex",
        ),
    ];
    for (aliases, canonical) in cloud {
        if aliases
            .iter()
            .any(|alias| raw == *alias || raw.contains(alias))
        {
            return ProviderIdentity {
                upstream_vendor,
                route_provider: canonical.into(),
                route_type: "cloud".into(),
            };
        }
    }
    if raw.contains("openrouter") {
        return ProviderIdentity {
            upstream_vendor,
            route_provider: "openrouter".into(),
            route_type: "aggregator".into(),
        };
    }
    for (needle, canonical) in [
        ("newapi", "newapi"),
        ("new-api", "newapi"),
        ("oneapi", "oneapi"),
        ("one-api", "oneapi"),
        ("litellm", "litellm"),
        ("cli-proxy", "cliproxyapi"),
        ("cliproxy", "cliproxyapi"),
        ("relay", "custom-relay"),
        ("gateway", "custom-gateway"),
        ("proxy", "custom-proxy"),
    ] {
        if raw.contains(needle) {
            return ProviderIdentity {
                upstream_vendor,
                route_provider: canonical.into(),
                route_type: "relay".into(),
            };
        }
    }
    for (needle, canonical) in [
        ("together", "together-ai"),
        ("fireworks", "fireworks-ai"),
        ("groq", "groq"),
        ("siliconflow", "siliconflow"),
        ("cloudflare", "cloudflare-workers-ai"),
        ("replicate", "replicate"),
        ("cerebras", "cerebras"),
        ("sambanova", "sambanova"),
        ("zenmux", "zenmux"),
        ("nano-gpt", "nano-gpt"),
        ("novita", "novita"),
    ] {
        if raw.contains(needle) {
            return ProviderIdentity {
                upstream_vendor,
                route_provider: canonical.into(),
                route_type: "inference-provider".into(),
            };
        }
    }
    if raw.contains("ollama")
        || raw.contains("llama.cpp")
        || raw == "local"
        || raw.contains("localhost")
    {
        return ProviderIdentity {
            upstream_vendor,
            route_provider: raw,
            route_type: "self-hosted".into(),
        };
    }
    if explicit {
        if official_provider_name(&raw).is_some() {
            return official_identity(upstream_vendor);
        }
        return ProviderIdentity {
            upstream_vendor,
            route_provider: raw,
            route_type: "custom".into(),
        };
    }
    ProviderIdentity {
        upstream_vendor,
        route_provider: raw,
        route_type: "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_upstream_from_route() {
        let identity = classify(Some("amazon-bedrock"), "claude-sonnet-4", true, None);
        assert_eq!(identity.upstream_vendor, "anthropic");
        assert_eq!(identity.route_provider, "aws-bedrock");
        assert_eq!(identity.route_type, "cloud");
    }

    #[test]
    fn inferred_openai_is_not_called_official() {
        let identity = classify(Some("openai"), "gpt-5.6-sol", false, None);
        assert_eq!(identity.upstream_vendor, "openai");
        assert_eq!(identity.route_type, "unknown");
    }

    #[test]
    fn proven_first_party_route_uses_one_official_bucket() {
        let openai = classify(Some("openai"), "gpt-5.6-sol", true, None);
        assert_eq!(openai.upstream_vendor, "openai");
        assert_eq!(openai.route_provider, "official");
        assert_eq!(openai.route_type, "official");

        let anthropic = classify(Some("anthropic"), "claude-sonnet-4", true, None);
        assert_eq!(anthropic.upstream_vendor, "anthropic");
        assert_eq!(anthropic.route_provider, "official");
        assert_eq!(anthropic.route_type, "official");
    }

    #[test]
    fn explicit_custom_provider_is_preserved() {
        let identity = classify(Some("my-newapi-gateway"), "gpt-5.6-sol", true, None);
        assert_eq!(identity.route_provider, "newapi");
        assert_eq!(identity.route_type, "relay");
    }

    #[test]
    fn official_base_url_maps_to_official_bucket() {
        let hint = route_hint_from_base_url("openai", "https://api.openai.com/v1");
        let identity = classify(Some("openai"), "gpt-5.6-sol", true, Some(&hint));
        assert_eq!(identity.route_provider, "official");
        assert_eq!(identity.route_type, "official");
    }

    #[test]
    fn custom_openai_base_url_overrides_official_name() {
        let hint = route_hint_from_base_url("openai", "https://relay.example.com/v1");
        let identity = classify(Some("openai"), "gpt-5.6-sol", true, Some(&hint));
        assert_eq!(identity.route_provider, "custom-relay");
        assert_eq!(identity.route_type, "relay");
    }
}
