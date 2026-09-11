import { memo, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
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
  METRICS,
  money,
  number,
  totals,
  trend,
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
    },
    {
      title: "估算费用",
      value: `${value.lowerBound ? "≥ " : ""}${money(value.cost)}`,
      full: money(value.cost, 6),
      note: "设备端兼容价卡 · 非实际账单",
    },
    {
      title: "请求记录",
      value: number(value.requestsCount),
      full: number(value.requestsCount),
      note: `${new Set(records.map((row) => row.model)).size} 个模型`,
    },
    {
      title: "缓存命中率",
      value: `${value.cacheRate.toFixed(1)}%`,
      full: `${value.cacheRate.toFixed(3)}%`,
      note: `${compact(value.cacheReadTokens)} Tokens 来自缓存读取`,
    },
  ];
  return (
    <div className="kpi-grid overview-metrics" aria-label="当前范围用量汇总">
      {cards.map((card) => (
        <section className="kpi-card" key={card.title}>
          <div className="kpi-top">
            <span>{card.title}</span>
          </div>
          <div className="kpi-value" title={card.full}>
            {card.value}
          </div>
          <div className="kpi-note">{card.note}</div>
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
      subtitle="按日汇总当前筛选范围"
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
                stroke="var(--primary)"
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
    <div className="view-stack overview-view">
      <KpiCards records={records} />
      <TrendChart records={records} />
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
          subtitle="输入、缓存与输出分布"
          className="token-panel"
        >
          <div className="token-total">
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
      </div>
      {budget > 0 && (
        <div className="insight-strip">
          <div>
            <strong>
              本月费用提醒 · {lowerBound ? "≥ " : ""}
              {money(monthlyCost)} / {money(budget)}
            </strong>
            <p>
              已达到提醒阈值的 {((monthlyCost / budget) * 100).toFixed(1)}%。
              按本月全部设备估算，不受页面筛选影响。
              {monthlyCost >= budget ? "已达到设定阈值。" : ""}
            </p>
          </div>
          <button className="button" onClick={() => onNavigate("settings")}>
            调整提醒 <ArrowUpRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
});
