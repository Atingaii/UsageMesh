from pathlib import Path
import re

path = Path("src/app.tsx")
text = path.read_text(encoding="utf-8")

# ---------------------------------------------------------------------------
# 1) Codex subscription-speed accounting. Keep it auditable in code, but do
#    not surface rate-card/source implementation details in the product UI.
# ---------------------------------------------------------------------------
needle = "const FAST_SUBSCRIPTION_MULTIPLIER = 2.5;"
if needle not in text:
    raise SystemExit("FAST_SUBSCRIPTION_MULTIPLIER declaration not found")

replacement = r'''function subscriptionSpeedMultiplier(record: UsageRecord): number {
  const tier = String(record.tier || '').trim().toLowerCase();
  if (record.tool.trim().toLowerCase() !== 'codex' || (tier !== 'fast' && tier !== 'priority')) {
    return 1;
  }

  const model = normalizeModel(record.model);
  // OpenAI Codex / ChatGPT Work official Speed rate card (2026-08):
  // GPT-5.6 and GPT-5.5 Fast consume 2.5x Standard credits; GPT-5.4 consumes 2x.
  // API-key Priority/Fast is deliberately NOT inferred here: it has separate API pricing.
  if (model.startsWith('gpt-5.6') || model.startsWith('gpt-5.5')) return 2.5;
  if (model.startsWith('gpt-5.4')) return 2;
  return 1;
}'''
text = text.replace(needle, replacement, 1)

pattern = re.compile(
    r"const\s+tier\s*=\s*(?P<row>[A-Za-z_$][A-Za-z0-9_$]*)\.tier\.trim\(\)\.toLowerCase\(\);\s*"
    r"const\s+multiplier\s*=\s*tier\s*===\s*['\"]fast['\"]\s*\|\|\s*tier\s*===\s*['\"]priority['\"]\s*"
    r"\?\s*FAST_SUBSCRIPTION_MULTIPLIER\s*:\s*1\s*;",
    re.MULTILINE,
)
match = pattern.search(text)
if not match:
    raise SystemExit("generic Fast multiplier expression not found")
row = match.group("row")
text = text[: match.start()] + f"const multiplier = subscriptionSpeedMultiplier({row});" + text[match.end() :]

text = text.replace("fastMultiplier: FAST_SUBSCRIPTION_MULTIPLIER,", "fastMultiplier: 2.5,")
text = text.replace("Codex Fast: GPT-5.6/5.5 2.5× · GPT-5.4 2×", "Fast")
text = text.replace("Fast 2.5×", "Fast")

# ---------------------------------------------------------------------------
# 2) Product-facing branding/privacy polish. Repository identity, pricing
#    provider names and multiplier explanations are implementation metadata,
#    not dashboard chrome.
# ---------------------------------------------------------------------------
text = text.replace(
    "repoBadge={dataset.repo} pricingBadge={dataset.pricing.source}",
    'repoBadge="" pricingBadge=""',
)
text = text.replace(
    "repoBadge = 'Atingaii/UsageMesh', pricingBadge = 'LiteLLM live · Fast 2.5×'",
    "repoBadge = '', pricingBadge = ''",
)
text = text.replace(
    '<div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent-blue-light)] border border-[var(--accent-blue-border)] text-[var(--accent-blue)] font-medium"><ShieldCheck className="w-3.5 h-3.5" /><span>{pricingBadge}</span></div>',
    '{pricingBadge && <div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent-blue-light)] border border-[var(--accent-blue-border)] text-[var(--accent-blue)] font-medium"><ShieldCheck className="w-3.5 h-3.5" /><span>{pricingBadge}</span></div>}',
)
text = text.replace(
    '<span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-card-hover)] border border-[var(--border-color)] text-[var(--text-muted)] font-mono">Atingaii/UsageMesh</span>',
    '',
)
text = text.replace(
    "{ id: 'cost', title: '订阅等价费用', value: `$${cost.toFixed(4)}`, subtext: pricing.source, icon: Coins, highlight: true, info: true },",
    "{ id: 'cost', title: '订阅等价费用', value: `$${cost.toFixed(4)}`, subtext: 'API 等价估算', icon: Coins, highlight: true, info: false },",
)

# Reuse the generated UsageMesh app icon in the sidebar and locked shell.
text = text.replace(
    '<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--accent-blue)] text-white font-mono font-bold text-sm shadow-sm shrink-0"><Terminal className="w-4 h-4" /></div>',
    '<img src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`} alt="" className="w-8 h-8 rounded-lg shadow-sm shrink-0" />',
)
text = text.replace(
    '<div title="UsageMesh Usage Console" className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--accent-blue)] text-white font-mono font-bold text-sm mx-auto shadow-sm">T</div>',
    '<img src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`} alt="UsageMesh" title="UsageMesh Usage Console" className="w-8 h-8 rounded-lg shadow-sm mx-auto" />',
)
text = text.replace(
    '<div className="w-7 h-7 rounded-lg bg-[var(--accent-blue)] text-white flex items-center justify-center font-mono font-bold text-xs">T</div>',
    '<img src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`} alt="" className="w-7 h-7 rounded-lg" />',
)

# ---------------------------------------------------------------------------
# 3) Restore the original usage-analysis information architecture. The Figma
#    bundle had drifted into a generic chart builder. The approved design is a
#    usage-statistics summary, cache/input/output detail, trend, then device and
#    route breakdowns. It intentionally stays data-driven and responsive.
# ---------------------------------------------------------------------------
usage_component = r'''const UsageAnalysisView: React.FC<Props> = ({ isDarkMode, records }) => {
  const [metric, setMetric] = useState<'totalTokens' | 'cost' | 'inputTokens' | 'cacheReadTokens' | 'outputTokens'>('totalTokens');

  const totals = useMemo(() => ({
    totalTokens: sum(records, 'totalTokens'),
    input: sum(records, 'inputTokens'),
    cacheRead: sum(records, 'cacheReadTokens'),
    cacheWrite: sum(records, 'cacheWriteTokens'),
    output: sum(records, 'outputTokens'),
    reasoning: sum(records, 'reasoningTokens'),
    requests: sum(records, 'requestsCount'),
    cost: sum(records, 'cost'),
  }), [records]);

  const trendRows = useMemo(() => trend(records), [records]);
  const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHitRate = inputSide > 0 ? (totals.cacheRead / inputSide) * 100 : 0;

  const breakdowns = useMemo(() => {
    const make = (key: 'device' | 'routeProvider') => {
      const grouped = new Map<string, number>();
      for (const row of records) {
        const name = String(row[key] || '未知');
        grouped.set(name, (grouped.get(name) || 0) + row.totalTokens);
      }
      return [...grouped.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
    };
    return { devices: make('device'), routes: make('routeProvider') };
  }, [records]);

  const metricLabel: Record<typeof metric, string> = {
    totalTokens: '总 Tokens',
    cost: '订阅等价费用',
    inputTokens: '输入 Tokens',
    cacheReadTokens: '缓存读取',
    outputTokens: '输出 Tokens',
  };

  const compact = (value: number) => analysisCompact(Number(value || 0));
  const metricValue = (point: DailyTrendPoint) => Number(point[metric] || 0);
  const yFormatter = (value: number) => metric === 'cost' ? `$${Number(value).toFixed(Number(value) < 1 ? 2 : 1)}` : compact(Number(value));
  const chartTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const point: DailyTrendPoint = payload[0].payload;
    const value = metricValue(point);
    return <div className="min-w-[210px] rounded-xl border border-slate-800 bg-slate-950/95 p-3 text-xs text-white shadow-2xl font-mono">
      <div className="mb-2 flex justify-between gap-4 border-b border-slate-800 pb-1.5 text-slate-400"><span>日期</span><span className="text-blue-400">{point.date}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-400">{metricLabel[metric]}</span><span className="font-bold">{metric === 'cost' ? `$${value.toFixed(4)}` : Math.round(value).toLocaleString()}</span></div>
      <div className="mt-1 flex justify-between gap-4 text-slate-400"><span>请求记录</span><span>{point.requestsCount.toLocaleString()}</span></div>
    </div>;
  };

  const BreakdownList = ({ title, icon: Icon, data }: { title: string; icon: React.ElementType; data: { name: string; value: number }[] }) => {
    const max = data[0]?.value || 1;
    return <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3.5">
        <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-[var(--accent-blue)]" /><h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3></div>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">TOP {Math.min(6, data.length)}</span>
      </div>
      <div className="divide-y divide-[var(--border-subtle)]">
        {data.map(item => <div key={item.name} className="px-4 py-3 hover:bg-[var(--bg-card-hover)] transition-colors">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate font-medium text-[var(--text-primary)]" title={item.name}>{item.name}</span><span className="shrink-0 font-mono font-semibold text-[var(--text-secondary)]">{compact(item.value)}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-main)]"><div className="h-full rounded-full bg-[var(--accent-blue)] transition-all" style={{ width: `${Math.max(2, item.value / max * 100)}%` }} /></div>
        </div>)}
        {!data.length && <div className="px-4 py-10 text-center text-xs text-[var(--text-muted)]">当前筛选范围暂无数据</div>}
      </div>
    </section>;
  };

  return <div className="space-y-4 transition-colors">
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4 lg:p-5 shadow-2xs">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2"><TrendingUp className="h-4 w-4 text-[var(--accent-blue)]" /><h2 className="text-base font-semibold text-[var(--text-primary)]">使用统计</h2></div>
          <p className="text-xs text-[var(--text-muted)]">查看当前筛选范围内的 Token 消耗、请求与成本统计</p>
        </div>
        <div className="grid min-w-[230px] grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]">
          <div className="px-4 py-2.5"><div className="text-[10px] text-[var(--text-muted)]">总请求数</div><div className="mt-0.5 font-mono text-base font-bold text-[var(--text-primary)]">{Math.round(totals.requests).toLocaleString()}</div></div>
          <div className="border-l border-[var(--border-color)] px-4 py-2.5"><div className="text-[10px] text-[var(--text-muted)]">订阅等价费用</div><div className="mt-0.5 font-mono text-base font-bold text-emerald-600">${totals.cost.toFixed(4)}</div></div>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--accent-blue-light)] text-[var(--accent-blue)]"><Cpu className="h-6 w-6" /></div>
        <div className="min-w-0"><div className="text-xs font-medium text-[var(--text-muted)]">真实消耗 Tokens</div><div className="mt-0.5 flex flex-wrap items-baseline gap-2"><span className="font-mono-numbers text-3xl font-bold tracking-tight text-[var(--text-primary)] lg:text-4xl">{Math.round(totals.totalTokens).toLocaleString()}</span><span className="text-xs font-mono text-[var(--text-muted)]">≈ {compact(totals.totalTokens)}</span></div></div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/45 p-3.5"><div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><ArrowDownRight className="h-3.5 w-3.5" /><span>新增输入</span></div><div className="mt-1.5 font-mono-numbers text-xl font-semibold text-[var(--text-primary)]">{Math.round(totals.input).toLocaleString()}</div></div>
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/45 p-3.5"><div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><ArrowUpRight className="h-3.5 w-3.5" /><span>Output</span></div><div className="mt-1.5 font-mono-numbers text-xl font-semibold text-[var(--text-primary)]">{Math.round(totals.output + totals.reasoning).toLocaleString()}</div></div>
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/45 p-3.5"><div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><Database className="h-3.5 w-3.5" /><span>创建</span></div><div className="mt-1.5 font-mono-numbers text-xl font-semibold text-[var(--text-primary)]">{Math.round(totals.cacheWrite).toLocaleString()}</div></div>
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/45 p-3.5"><div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><Database className="h-3.5 w-3.5" /><span>命中</span></div><div className="mt-1.5 font-mono-numbers text-xl font-semibold text-[var(--text-primary)]">{Math.round(totals.cacheRead).toLocaleString()}</div></div>
      </div>

      <div className="mt-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/45 p-3.5">
        <div className="mb-2 flex items-center justify-between text-xs"><span className="text-[var(--text-muted)]">缓存命中率</span><span className="font-mono font-semibold text-emerald-600">{cacheHitRate.toFixed(1)}%</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--border-subtle)]"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, cacheHitRate))}%` }} /></div>
      </div>
    </section>

    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3.5">
        <div><h3 className="text-sm font-semibold text-[var(--text-primary)]">用量趋势</h3><p className="mt-0.5 text-xs text-[var(--text-muted)]">按时间查看 Token 与费用变化</p></div>
        <div className="relative"><select value={metric} onChange={e => setMetric(e.target.value as typeof metric)} className="h-9 appearance-none rounded-lg border border-[var(--border-color)] bg-[var(--bg-main)] pl-3 pr-8 text-xs font-medium text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]"><option value="totalTokens">总 Tokens</option><option value="cost">订阅等价费用</option><option value="inputTokens">输入 Tokens</option><option value="cacheReadTokens">缓存读取</option><option value="outputTokens">输出 Tokens</option></select><ChevronDown className="pointer-events-none absolute right-2.5 top-3 h-3 w-3 text-[var(--text-muted)]" /></div>
      </div>
      <div className="h-[360px] w-full p-3 lg:h-[420px] lg:p-4"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trendRows} margin={{ top: 12, right: 16, left: 4, bottom: 8 }}><defs><linearGradient id="usageAnalysisFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563eb" stopOpacity={0.22} /><stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? '#262a33' : '#eef2f7'} /><XAxis dataKey="date" minTickGap={28} tick={{ fontSize: 11, fill: isDarkMode ? '#9ca3af' : '#667085' }} tickLine={false} axisLine={false} /><YAxis tickFormatter={yFormatter} width={64} tick={{ fontSize: 11, fill: isDarkMode ? '#9ca3af' : '#667085' }} tickLine={false} axisLine={false} /><Tooltip content={chartTooltip} /><Area type="monotone" dataKey={metricValue} stroke="#2563eb" strokeWidth={2.5} fill="url(#usageAnalysisFill)" dot={{ r: 3, fill: '#2563eb', strokeWidth: 0 }} activeDot={{ r: 5 }} /></AreaChart></ResponsiveContainer></div>
      {!trendRows.length && <div className="pb-8 text-center text-xs text-[var(--text-muted)]">当前筛选范围暂无趋势数据</div>}
    </section>

    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <BreakdownList title="按设备" icon={Monitor} data={breakdowns.devices} />
      <BreakdownList title="按路由提供商" icon={Route} data={breakdowns.routes} />
    </div>
  </div>;
};'''

usage_pattern = re.compile(
    r"const UsageAnalysisView: React\.FC<Props> = \(\{ isDarkMode, records \}\) => \{.*?\n\};\n\nfunction ymd",
    re.DOTALL,
)
if not usage_pattern.search(text):
    raise SystemExit("UsageAnalysisView block not found")
text = usage_pattern.sub(usage_component + "\n\nfunction ymd", text, count=1)

# Usage Analysis and Aggregated Data both retain the approved date/dimension
# filter row. Aggregated Data also keeps the six summary KPIs shown in the
# original design rather than dropping straight into the table.
text = text.replace(
    "{activeTab==='analytics' && <UsageAnalysisView isDarkMode={isDarkMode} records={filtered} />}",
    "{activeTab==='analytics' && <><FilterBar filters={filters} options={options} onChangeFilter={changeFilter} onResetFilters={resetFilters} /><UsageAnalysisView isDarkMode={isDarkMode} records={filtered} /></>}",
)
text = text.replace(
    "{activeTab==='aggregated' && <AggregatedDataView records={filtered} />}",
    "{activeTab==='aggregated' && <><FilterBar filters={filters} options={options} onChangeFilter={changeFilter} onResetFilters={resetFilters} /><KpiCards totalTokens={totals.totalTokens} cost={totals.cost} inputTokens={totals.input} cacheReadTokens={totals.cacheRead} outputTokens={totals.output} requestsCount={totals.requests} pricing={dataset.pricing} /><AggregatedDataView records={filtered} /></>}",
)

# Never expose implementation-source labels in table tooltips/CSV metadata.
text = text.replace("r.pricingResolved ? 'LiteLLM' : 'Ledger fallback'", "r.pricingResolved ? 'Dynamic' : 'Stored'")
text = text.replace("r.pricingResolved ? 'LiteLLM 动态价格' : '账本内历史价格'", "r.pricingResolved ? '动态价格' : '账本内价格'")

# Final safety checks: the source can keep comments about the audited policy,
# but user-visible strings must not contain repository/source/multiplier chrome.
if "FAST_SUBSCRIPTION_MULTIPLIER" in text:
    raise SystemExit("generic Fast multiplier survived patch")
if "subscriptionSpeedMultiplier" not in text:
    raise SystemExit("surface-aware speed policy missing")
if "Codex Fast: GPT-5.6/5.5 2.5× · GPT-5.4 2×" in text:
    raise SystemExit("internal Fast multiplier label survived patch")
if "高级用量分析" in text:
    raise SystemExit("obsolete generic analytics UI survived patch")
if "repoBadge={dataset.repo}" in text or "pricingBadge={dataset.pricing.source}" in text:
    raise SystemExit("internal topbar metadata survived patch")

path.write_text(text, encoding="utf-8")
