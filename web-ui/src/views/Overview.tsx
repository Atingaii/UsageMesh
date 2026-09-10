import { memo, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Coins,
  Cpu,
  Layers3,
  Sparkles,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ActiveTab, UsageRecord } from "../lib/types";
import {
  COLORS,
  compact,
  groupRows,
  METRICS,
  money,
  number,
  totals,
  trend,
  type Dimension,
  type Metric,
} from "../lib/analytics";
import { EmptyState, Section } from "../components/ui";

export function KpiCards({ records }: { records: UsageRecord[] }) {
  const value = useMemo(() => totals(records), [records]);
  const cards = [
    {
      title: "总 Tokens",
      value: compact(value.totalTokens),
      full: number(value.totalTokens),
      note: "输入、缓存、输出与 Reasoning",
      icon: Layers3,
      tone: "violet",
      tag: "TOTAL USAGE",
    },
    {
      title: "估算费用",
      value: `${value.lowerBound ? "≥ " : ""}${money(value.cost)}`,
      full: money(value.cost, 6),
      note: "设备端兼容价卡 · 非实际账单",
      icon: Coins,
      tone: "amber",
      tag: "ESTIMATED COST",
    },
    {
      title: "请求记录",
      value: number(value.requestsCount),
      full: number(value.requestsCount),
      note: `${new Set(records.map((row) => row.model)).size} 个模型参与了你的工作`,
      icon: Cpu,
      tone: "teal",
      tag: "TOTAL REQUESTS",
    },
    {
      title: "缓存命中率",
      value: `${value.cacheRate.toFixed(1)}%`,
      full: `${value.cacheRate.toFixed(3)}%`,
      note: `${compact(value.cacheReadTokens)} Tokens 来自缓存读取`,
      icon: ArrowDownToLine,
      tone: "blue",
      tag: "CACHE EFFICIENCY",
    },
  ];
  return (
    <div className="kpi-grid">
      {cards.map((card) => (
        <section className="kpi-card" key={card.title}>
          <div className="kpi-top">
            <span>{card.title}</span>
            <span className={`kpi-icon ${card.tone}`}>
              <card.icon size={17} />
            </span>
          </div>
          <div className="kpi-value" title={card.full}>
            {card.value}
          </div>
          <div className="kpi-note">{card.note}</div>
          <span className="kpi-tag">{card.tag}</span>
        </section>
      ))}
    </div>
  );
}
export function TrendChart({ records }: { records: UsageRecord[] }) {
  const [metric, setMetric] = useState<Metric>("totalTokens");
  const data = useMemo(() => trend(records), [records]);
  const value = useMemo(() => totals(records), [records]);
  return (
    <Section
      title="用量趋势"
      subtitle="每一天的投入，都清晰可见"
      className="trend-panel"
      action={
        <label className="inline-select">
          <span className="sr-only">趋势指标</span>
          <select
            aria-label="趋势指标"
            value={metric}
            onChange={(event) => setMetric(event.target.value as Metric)}
          >
            {Object.entries(METRICS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <div className="chart-summary">
        <span className="legend-dot" />
        <span>{METRICS[metric]}</span>
        <strong>
          {metric === "cost" ? money(value[metric]) : compact(value[metric])}
        </strong>
        <span className="muted small">/ 当前筛选范围</span>
      </div>
      {data.length ? (
        <div
          className="trend-chart"
          role="img"
          aria-label={`${METRICS[metric]}按日趋势，共 ${data.length} 天`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 12, right: 18, left: 4, bottom: 0 }}
            >
              <CartesianGrid
                stroke="var(--border-subtle)"
                vertical={false}
                strokeDasharray="3 4"
              />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--text-muted)", fontSize: "0.8125rem" }}
                tickLine={false}
                axisLine={false}
                minTickGap={35}
                dy={10}
              />
              <YAxis
                tickFormatter={
                  metric === "cost" ? (v) => money(Number(v), 0) : compact
                }
                tick={{ fill: "var(--text-muted)", fontSize: "0.8125rem" }}
                tickLine={false}
                axisLine={false}
                width={55}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 10,
                  color: "var(--text-primary)",
                  fontSize: "0.875rem",
                }}
                labelFormatter={(_, items) =>
                  String(items[0]?.payload?.date || "")
                }
                formatter={(v) => [
                  metric === "cost" ? money(Number(v), 4) : number(Number(v)),
                  METRICS[metric],
                ]}
              />
              <Area
                type="monotone"
                dataKey={metric}
                stroke="#538bff"
                strokeWidth={2}
                fill="var(--chart-fill)"
                dot={data.length === 1 ? { r: 4 } : false}
                activeDot={{ r: 5, strokeWidth: 3, stroke: "var(--bg-card)" }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState />
      )}
      <div className="chart-footnote">
        <span>按本地日期汇总</span>
        <span>账本原始估算 · 保留缓存与上下文计价语义</span>
      </div>
    </Section>
  );
}
function Ranking({
  records,
  dimension,
  title,
  label,
}: {
  records: UsageRecord[];
  dimension: Dimension;
  title: string;
  label: string;
}) {
  const values = useMemo(
    () => groupRows(records, dimension),
    [records, dimension],
  );
  return (
    <Section
      title={title}
      action={
        <span className="muted small">
          {values.length} {label}
        </span>
      }
    >
      <div className="ranking-list">
        {values.slice(0, 5).map((item, index) => (
          <div className="ranking-item" key={item.name}>
            <div className="ranking-title">
              <span
                className="ranking-marker"
                style={{ background: COLORS[index % COLORS.length] }}
              />
              <span title={item.name}>{item.name}</span>
              <strong>{compact(item.value)}</strong>
              <small>{item.share.toFixed(1)}%</small>
            </div>
            <div className="progress-track">
              <div
                style={{
                  width: `${item.share}%`,
                  background: COLORS[index % COLORS.length],
                }}
              />
            </div>
          </div>
        ))}
        {!values.length && <EmptyState />}
        {values.length > 5 && (
          <p className="muted small">
            其余 {values.length - 5} 项占{" "}
            {values
              .slice(5)
              .reduce((s, v) => s + v.share, 0)
              .toFixed(1)}
            %
          </p>
        )}
      </div>
    </Section>
  );
}
export const Overview = memo(function Overview({
  records,
  onNavigate,
  monthlyCost,
  budget,
  lowerBound,
}: {
  records: UsageRecord[];
  onNavigate: (tab: ActiveTab) => void;
  monthlyCost: number;
  budget: number;
  lowerBound: boolean;
}) {
  const values = useMemo(() => totals(records), [records]);
  const recentRecords = useMemo(
    () =>
      [...records]
        .sort(
          (a, b) =>
            (b.timestampMs ?? Date.parse(b.date)) -
            (a.timestampMs ?? Date.parse(a.date)),
        )
        .slice(0, 5),
    [records],
  );
  const tokenTypes = [
    ["新增输入", values.inputTokens],
    ["缓存读取", values.cacheReadTokens],
    ["缓存写入", values.cacheWriteTokens],
    ["输出", values.outputTokens],
    ["Reasoning", values.reasoningTokens],
  ] as const;
  return (
    <div className="view-stack">
      <div className="credit-today">
        <TrendChart records={records} />
        <KpiCards records={records} />
      </div>
      <h2 className="region-heading">近期概览</h2>
      <div className="overview-rank-grid">
        <Section title="近期活动" subtitle="当前筛选范围内最近的聚合记录">
          <div className="credit-activity">
            {recentRecords.map((row) => (
              <div key={row.id}>
                <div>
                  <strong>{row.model}</strong>
                  <small>
                    {row.device} · {row.date}
                  </small>
                </div>
                <span>{compact(row.totalTokens)} Tokens</span>
              </div>
            ))}
            {!records.length && <EmptyState />}
          </div>
          <button
            className="text-button credit-card-link"
            onClick={() => onNavigate("aggregated")}
          >
            查看全部 <ArrowRight size={14} />
          </button>
        </Section>
        <Section
          title="Token 构成"
          subtitle="看清用量的每一部分"
          className="token-panel"
        >
          <div className="token-total">
            <span className="eyebrow">TOKEN BREAKDOWN</span>
            <strong>{compact(values.totalTokens)}</strong>
            <span>Tokens 总用量</span>
          </div>
          <div
            className="token-stacked"
            role="img"
            aria-label={tokenTypes
              .map(([name, value]) => `${name} ${number(value)}`)
              .join("，")}
          >
            {tokenTypes.map(([name, value], index) => (
              <span
                key={name}
                title={`${name} ${number(value)}`}
                style={{
                  width: `${values.totalTokens ? (value / values.totalTokens) * 100 : 0}%`,
                  background: COLORS[index],
                }}
              />
            ))}
          </div>
          <div className="token-legend">
            {tokenTypes.map(([name, value], index) => (
              <div key={name}>
                <span
                  className="ranking-marker"
                  style={{ background: COLORS[index] }}
                />
                <span>{name}</span>
                <strong>{compact(value)}</strong>
                <small>
                  {values.totalTokens
                    ? ((value / values.totalTokens) * 100).toFixed(1)
                    : "0.0"}
                  %
                </small>
              </div>
            ))}
          </div>
          <button
            className="text-button token-detail"
            onClick={() => onNavigate("analytics")}
          >
            进一步分析用量
            <ArrowRight size={14} />
          </button>
        </Section>
        <Ranking
          records={records}
          dimension="model"
          title="模型分布"
          label="个模型"
        />
        <Ranking
          records={records}
          dimension="tool"
          title="客户端分布"
          label="个客户端"
        />
        <Ranking
          records={records}
          dimension="device"
          title="设备分布"
          label="台设备"
        />
        <Ranking
          records={records}
          dimension="routeProvider"
          title="路由分布"
          label="条路由"
        />
      </div>
      <div className="insight-strip">
        <span className="icon-tile">
          <Sparkles size={20} />
        </span>
        <div>
          <strong>
            {budget
              ? `本月费用提醒 · ${lowerBound ? "≥ " : ""}${money(monthlyCost)} / ${money(budget)}`
              : "了解用量，也掌握节奏。"}
          </strong>
          <p>
            {budget
              ? `已达到提醒阈值的 ${((monthlyCost / budget) * 100).toFixed(1)}%。按本月全部设备估算，不受页面筛选影响。${monthlyCost >= budget ? "已达到设定阈值。" : ""}`
              : "设置每月费用提醒，在概览中查看用量进度。提醒仅保存在当前浏览器。"}
          </p>
        </div>
        <button className="button" onClick={() => onNavigate("settings")}>
          {budget ? "调整提醒" : "设置费用提醒"}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </div>
  );
});
