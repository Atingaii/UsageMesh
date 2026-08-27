from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


# Pricing policy gets an explicit version so upgrades can force a full historical reprice.
p = Path("rust-cli/src/pricing.rs")
text = p.read_text()
text = replace_once(
    text,
    'const MODELS_DEV_URL: &str = "https://models.dev/api.json";\n',
    'const MODELS_DEV_URL: &str = "https://models.dev/api.json";\npub const PRICING_POLICY: &str = "api-equivalent-estimate-v2";\n',
    "pricing-policy-const",
)
text = replace_once(
    text,
    '            policy: "api-equivalent-estimate".to_string(),',
    '            policy: PRICING_POLICY.to_string(),',
    "pricing-policy-metadata",
)
p.write_text(text)


# Collector: Codex's parser provider is first-party evidence unless an explicit base-url
# hint says otherwise. Also, unknown speed tier is no longer a dollar-cost lower bound.
p = Path("rust-cli/src/collector.rs")
text = p.read_text()
text = replace_once(
    text,
    '        && matches!(client, "opencode" | "micode")',
    '        && matches!(client, "codex" | "opencode" | "micode")',
    "codex-provider-explicit",
)
old = '''    // A canonical Codex fallback does not carry request-level service tier. The
    // standard-card number remains useful, but it is a lower bound because some
    // requests may have used Fast/Priority. Exact tier rows replace it whenever
    // their daily token total reconciles with Tokscale.
    let tier_unknown = message.client == "codex";
    (metrics, quote.lower_bound || tier_unknown)
'''
new = '''    // Service tier is usage metadata, not a USD multiplier. A canonical Codex
    // fallback can therefore use the same API-equivalent price even when the
    // request-level Standard/Fast label is unavailable.
    (metrics, quote.lower_bound)
'''
text = replace_once(text, old, new, "codex-tier-lower-bound")
p.write_text(text)


# Sync: the first run after a pricing-policy change MUST rebuild the entire ledger.
# Incremental replacement of only the last two days leaves historical costUsd stale.
p = Path("rust-cli/src/main.rs")
text = p.read_text()
old = '''    let previous = config::read_cached_ledger()?;
    let previous_for_compare = previous.clone();

    let (ledger, mode) = if full || previous.is_none() {
        (collector::collect(device_info(&config), None)?, "full")
    } else {
'''
new = '''    let previous = config::read_cached_ledger()?;
    let previous_for_compare = previous.clone();
    let pricing_migration = previous
        .as_ref()
        .is_some_and(|ledger| ledger.pricing.policy != pricing::PRICING_POLICY);
    let effective_full = full || previous.is_none() || pricing_migration;

    let (ledger, mode) = if effective_full {
        (
            collector::collect(device_info(&config), None)?,
            if pricing_migration { "full/pricing-migration" } else { "full" },
        )
    } else {
'''
text = replace_once(text, old, new, "pricing-migration-full-scan")
text = replace_once(
    text,
    '''    if full {
        github
            .sync_main_with_upstream()
''',
    '''    if full {
        github
            .sync_main_with_upstream()
''',
    "keep-manual-full-upstream-sync",
)
text = replace_once(
    text,
    '''        println!(
            "  Subscription-equivalent cost: ${:.2}",
            ledger.totals.cost_usd
        );
''',
    '''        println!("  API-equivalent estimated cost: ${:.2}", ledger.totals.cost_usd);
        if pricing_migration {
            println!("  Pricing migration: rebuilt full local history with the current policy");
        }
''',
    "sync-cost-copy",
)
p.write_text(text)


# Dashboard: normalize legacy first-party rows so `openai` is rendered with an
# official marker while preserving custom-relay evidence when it exists.
p = Path("web-ui/src/app.tsx")
text = p.read_text()
old = '''function routeLabel(row: LedgerRow): string {
  if (String(row.routeType || '').toLowerCase() === 'official') return '官方';
  return String(row.routeProvider || row.provider || '未知');
}
'''
new = '''function normalizedRoute(row: LedgerRow): { provider: string; type: string; label: string } {
  const raw = String(row.provider || '').trim().toLowerCase();
  const provider = String(row.routeProvider || row.provider || 'unknown').trim().toLowerCase();
  const vendor = String(row.upstreamVendor || '').trim().toLowerCase();
  let type = String(row.routeType || 'unknown').trim().toLowerCase();
  let canonical = provider;

  // Older ledgers sometimes carried `openai` as an unknown route when the Codex
  // parser knew the first-party provider but route evidence had not yet been
  // normalized. Do not rewrite explicit relay/cloud/aggregator evidence.
  const firstPartyAliases: Record<string, string> = {
    openai: 'openai', 'openai-codex': 'openai', anthropic: 'anthropic',
    google: 'google', gemini: 'google', 'google-ai': 'google',
    deepseek: 'deepseek', 'deepseek-ai': 'deepseek',
  };
  const firstParty = firstPartyAliases[provider] || firstPartyAliases[raw];
  if (type === 'official' || ((type === 'unknown' || !type) && firstParty && (!vendor || vendor === firstParty))) {
    type = 'official';
    canonical = 'official';
    const vendorLabel = (vendor || firstParty || '').replace(/^./, c => c.toUpperCase());
    return { provider: canonical, type, label: vendorLabel ? `官方 · ${vendorLabel}` : '官方' };
  }
  return { provider: canonical || 'unknown', type: type || 'unknown', label: String(row.routeProvider || row.provider || '未知') };
}
'''
text = replace_once(text, old, new, "normalized-route-helper")
text = replace_once(
    text,
    '''  const reasoning = Number(row.reasoning || 0);
  return {
''',
    '''  const reasoning = Number(row.reasoning || 0);
  const route = normalizedRoute(row);
  return {
''',
    "to-record-route",
)
text = replace_once(text, "    routeProvider: routeLabel(row),\n    routeType: String(row.routeType || 'unknown'),", "    routeProvider: route.provider,\n    routeType: route.type,", "to-record-route-fields")
text = replace_once(
    text,
    '''  const reasoning = Number(row.reasoning || 0);
  const route = routeLabel(row as LedgerRow);
  return {
''',
    '''  const reasoning = Number(row.reasoning || 0);
  const route = normalizedRoute(row as LedgerRow);
  return {
''',
    "to-request-route",
)
text = replace_once(text, "    routeProvider: route,\n    routeType: String(row.routeType || 'unknown'),", "    routeProvider: route.label,\n    routeType: route.type,", "to-request-route-fields")

# Pricing summary copy: clearly state full-ledger source and historical migration.
text = text.replace(
    "费用直接使用设备端逐请求计算后写入加密账本的结果，避免浏览器对聚合行二次计价造成偏差。",
    "费用直接使用设备端逐请求计算后写入加密账本的结果，避免浏览器对聚合行二次计价造成偏差；计费策略升级时设备会自动全量重建历史账本，避免旧日期残留过期费用。",
)
p.write_text(text)


# Documentation and versions.
p = Path("docs/PRICING.md")
pricing_doc = p.read_text()
pricing_doc += """

## Pricing-policy migration

A pricing-policy change invalidates historical stored `costUsd` values. UsageMesh compares the cached ledger's pricing policy identifier with the running CLI. On the first sync after an accounting-policy upgrade, it automatically performs a full local rescan/reprice before publishing the encrypted ledger. This prevents a two-day incremental merge from leaving older dates on a previous cost policy.
"""
p.write_text(pricing_doc)

p = Path("README.zh-CN.md")
r = p.read_text()
r = r.replace(
    "Dashboard 展示的是**API 等价美元费用估算**，不是供应商发票，也不把 Fast / Priority 的订阅额度倍率混入美元费用。",
    "Dashboard 展示的是**API 等价美元费用估算**，不是供应商发票，也不把 Fast / Priority 的订阅额度倍率混入美元费用。计费策略版本变化时，设备下一次同步会自动执行一次全量历史重算，避免旧账本日期继续保留旧费用。",
)
p.write_text(r)

p = Path("rust-cli/Cargo.toml")
p.write_text(p.read_text().replace('version = "2.2.2"', 'version = "2.2.3"', 1))
p = Path("web-ui/package.json")
p.write_text(p.read_text().replace('"version": "2.2.2"', '"version": "2.2.3"', 1))

Path(".release/v2.2.3").write_text(
    """UsageMesh 2.2.3 accounting migration and route-normalization release.
- Pricing-policy upgrades now force one automatic full historical reprice instead of leaving stale costUsd values in old dates.
- GPT-5.6 USD estimates use the same base card for Standard/Fast/Priority; tier stays separate metadata.
- Codex `openai` provider is normalized to the official route unless explicit relay/cloud evidence overrides it.
- The dashboard also renders legacy first-party `openai` rows with an official marker.
- Same-tab encrypted session resume from v2.2.2 remains compatible with the original Dashboard password.
"""
)
