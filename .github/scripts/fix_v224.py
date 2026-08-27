from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


# Pricing aliases used by coding clients such as CodeBuddy/WorkBuddy.
p = Path("rust-cli/src/pricing.rs")
text = p.read_text()
text = replace_once(
    text,
    'pub const PRICING_POLICY: &str = "api-equivalent-estimate-v2";',
    'pub const PRICING_POLICY: &str = "api-equivalent-estimate-v3";',
    "pricing-policy-v3",
)
text = replace_once(
    text,
    '''fn strip_date_suffix(value: &str) -> Option<String> {
    let (base, suffix) = value.rsplit_once('-')?;
    (suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_digit())).then(|| base.to_string())
}
''',
    '''fn strip_date_suffix(value: &str) -> Option<String> {
    let (base, suffix) = value.rsplit_once('-')?;
    ((suffix.len() == 8 || suffix.len() == 6) && suffix.chars().all(|ch| ch.is_ascii_digit()))
        .then(|| base.to_string())
}

fn lookup_aliases(normalized: &str) -> Vec<String> {
    let mut aliases = vec![normalized.to_string()];
    if let Some(value) = normalized.strip_suffix("-ioa") {
        aliases.push(value.to_string());
    }
    let snapshot = aliases.clone();
    for value in snapshot {
        if let Some(base) = strip_date_suffix(&value) {
            aliases.push(base);
        }
    }
    aliases.sort();
    aliases.dedup();
    aliases
}
''',
    "pricing-alias-helper",
)
old_lookup = '''    fn lookup(&self, model_id: &str) -> Option<EffectivePricing> {
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
'''
new_lookup = '''    fn lookup(&self, model_id: &str) -> Option<EffectivePricing> {
        let normalized = normalize_model_id(model_id);
        for alias in lookup_aliases(&normalized) {
            if let Some(guarded) = guarded_pricing(&alias) {
                return Some(guarded);
            }
            if let Some(pricing) = self.catalog.get(&alias) {
                return Some(*pricing);
            }
        }
        None
    }
'''
text = replace_once(text, old_lookup, new_lookup, "pricing-alias-lookup")
# Add a regression test for the exact CodeBuddy internal model id seen in real data.
insert_before = '''    #[test]
    fn unknown_model_is_not_guessed() {
'''
alias_test = '''    #[test]
    fn codebuddy_ioa_alias_uses_canonical_models_dev_price() {
        let mut catalog = HashMap::new();
        catalog.insert(
            "deepseek-v4-flash".to_string(),
            EffectivePricing {
                input: 0.14e-6,
                output: 0.28e-6,
                cache_read: 0.0028e-6,
                cache_write: 0.0,
                long_context_threshold: None,
                long_input_multiplier: 1.0,
                long_output_multiplier: 1.0,
            },
        );
        let book = PriceBook { catalog, catalog_state: "test" };
        let quote = book.quote(
            "deepseek-v4-flash-ioa",
            Some("standard"),
            &metrics(1_000_000, 0, 0, 1_000_000),
        );
        assert!((quote.cost_usd - 0.42).abs() < 1e-9);
        assert!(!quote.lower_bound);
    }

'''
text = replace_once(text, insert_before, alias_test + insert_before, "pricing-alias-test")
p.write_text(text)


# Dashboard: never present a lower-bound sum as an exact dollar figure.
p = Path("web-ui/src/app.tsx")
text = p.read_text()
text = replace_once(
    text,
    '''interface KpiCardsProps {
  totalTokens: number; cost: number; inputTokens: number; cacheReadTokens: number;
  outputTokens: number; requestsCount: number; pricing: PricingStatus;
}

const KpiCards: React.FC<KpiCardsProps> = ({ totalTokens, cost, inputTokens, cacheReadTokens, outputTokens, requestsCount, pricing }) => {
''',
    '''interface KpiCardsProps {
  totalTokens: number; cost: number; inputTokens: number; cacheReadTokens: number;
  outputTokens: number; requestsCount: number; pricing: PricingStatus; costLowerBound: boolean;
}

const KpiCards: React.FC<KpiCardsProps> = ({ totalTokens, cost, inputTokens, cacheReadTokens, outputTokens, requestsCount, pricing, costLowerBound }) => {
''',
    "kpi-lower-bound-prop",
)
text = replace_once(
    text,
    "    { id: 'cost', title: '估算费用', value: `$${cost.toFixed(4)}`, subtext: '统一账本估算', icon: Coins, highlight: true, info: false },",
    "    { id: 'cost', title: '估算费用', value: `${costLowerBound ? '≥' : ''}$${cost.toFixed(4)}`, subtext: costLowerBound ? '统一账本估算 · 存在未完全计价项' : '统一账本估算 · 已完整计价', icon: Coins, highlight: true, info: true },",
    "kpi-cost-lower-bound",
)
# The current filter must determine whether the current cost is exact.
text = replace_once(
    text,
    '''  const totals = useMemo(() => ({ totalTokens:sum(filtered,'totalTokens'),cost:sum(filtered,'cost'),input:sum(filtered,'inputTokens'),cacheRead:sum(filtered,'cacheReadTokens'),output:sum(filtered,'outputTokens'),requests:sum(filtered,'requestsCount') }), [filtered]);
''',
    '''  const totals = useMemo(() => ({ totalTokens:sum(filtered,'totalTokens'),cost:sum(filtered,'cost'),input:sum(filtered,'inputTokens'),cacheRead:sum(filtered,'cacheReadTokens'),output:sum(filtered,'outputTokens'),requests:sum(filtered,'requestsCount'),costLowerBound:filtered.some(row => row.costLowerBound) }), [filtered]);
''',
    "filtered-lower-bound",
)
text = text.replace(
    'requestsCount={totals.requests} pricing={dataset.pricing} />',
    'requestsCount={totals.requests} pricing={dataset.pricing} costLowerBound={totals.costLowerBound} />',
)
# Explain client aliases in the pricing modal.
text = text.replace(
    '通用模型目录来自 models.dev；GPT-5.6 Sol',
    '通用模型目录来自 models.dev，并对 CodeBuddy/WorkBuddy 等客户端的内部模型后缀（如 `-ioa`）做保守别名归一；GPT-5.6 Sol',
)
p.write_text(text)


# Documentation.
p = Path("docs/PRICING.md")
doc = p.read_text()
doc += '''

## Client model aliases

Some coding clients expose an internal route/model suffix instead of the canonical upstream model ID. UsageMesh first attempts an exact models.dev lookup, then applies conservative lookup-only aliases. In particular, CodeBuddy/WorkBuddy IDs ending in `-ioa` (for example `deepseek-v4-flash-ioa`) fall back to the canonical model ID (`deepseek-v4-flash`) only when the exact ID is absent. Six- and eight-digit release suffixes are handled the same way. Unknown models remain lower bounds rather than being guessed.

The Dashboard prefixes a filtered total with `≥` whenever any included row is still a lower-bound estimate, so an incomplete price catalog cannot look like an exact total.
'''
p.write_text(doc)

p = Path("README.zh-CN.md")
r = p.read_text()
r = r.replace(
    "计费策略版本变化时，设备下一次同步会自动执行一次全量历史重算，避免旧账本日期继续保留旧费用。",
    "计费策略版本变化时，设备下一次同步会自动执行一次全量历史重算，避免旧账本日期继续保留旧费用。CodeBuddy/WorkBuddy 这类客户端的内部模型后缀（例如 `deepseek-v4-flash-ioa`）会在精确匹配失败后映射到对应的 canonical 模型；仍无法可靠计价的记录会让总费用显示 `≥`，不会伪装成精确值。",
)
p.write_text(r)

# Skip an intermediate unreleased marker; v2.2.4 is the public stable release.
Path(".release/v2.2.3").unlink(missing_ok=True)
Path(".release/v2.2.4").write_text(
    """UsageMesh 2.2.4 accounting parity release.
- Pricing-policy changes force a full historical reprice on the next automatic sync.
- Fast/Priority no longer multiply API-equivalent USD cost; tier remains metadata.
- CodeBuddy/WorkBuddy `-ioa` model IDs fall back conservatively to canonical models.dev IDs when exact lookup is absent.
- Dashboard totals use a `≥` prefix whenever any included record is not fully priced.
- Codex `openai` routes render as official unless explicit relay/cloud evidence overrides them.
- Same-tab refresh keeps the sealed browser session; the original Dashboard password remains unchanged.
"""
)

p = Path("rust-cli/Cargo.toml")
p.write_text(p.read_text().replace('version = "2.2.3"', 'version = "2.2.4"', 1))
p = Path("web-ui/package.json")
p.write_text(p.read_text().replace('"version": "2.2.3"', '"version": "2.2.4"', 1))
