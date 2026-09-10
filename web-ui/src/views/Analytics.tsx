import { memo, useMemo, useState } from "react";
import type { RequestRecord, UsageRecord } from "../lib/types";
import {
  COLORS,
  compact,
  FILTER_LABELS,
  groupRows,
  METRICS,
  money,
  number,
  totals,
  type Dimension,
  type Metric,
} from "../lib/analytics";
import { Badge, EmptyState, Section } from "../components/ui";
import { UsageTable } from "../components/UsageTable";

export const Analytics = memo(function Analytics({
  records,
  requests,
}: {
  records: UsageRecord[];
  requests: RequestRecord[];
}) {
  const [dimension, setDimension] = useState<Dimension>("model"),
    [metric, setMetric] = useState<Metric>("totalTokens");
  const summary = useMemo(() => totals(records), [records]);
  const groups = useMemo(
    () => groupRows(records, dimension, metric),
    [records, dimension, metric],
  );
  const top3 = groups
    .slice(0, 3)
    .reduce((total, group) => total + group.share, 0);
  const matrix = useMemo(() => {
    const devices = groupRows(records, "device")
        .slice(0, 6)
        .map((item) => item.name),
      models = groupRows(records, "model")
        .slice(0, 6)
        .map((item) => item.name);
    const values = new Map<string, number>();
    for (const row of records) {
      const key = JSON.stringify([row.device, row.model]);
      values.set(key, (values.get(key) || 0) + row.totalTokens);
    }
    return { devices, models, values, max: Math.max(1, ...values.values()) };
  }, [records]);
  const combinations = useMemo(() => {
    const map = new Map<
      string,
      {
        device: string;
        model: string;
        tool: string;
        tier: string;
        tokens: number;
        cost: number;
        requests: number;
        cache: number;
        input: number;
        lower: boolean;
      }
    >();
    for (const row of records) {
      const key = JSON.stringify([row.deviceId, row.model, row.tool, row.tier]);
      const item = map.get(key) || {
        device: row.device,
        model: row.model,
        tool: row.tool,
        tier: row.tier,
        tokens: 0,
        cost: 0,
        requests: 0,
        cache: 0,
        input: 0,
        lower: false,
      };
      item.tokens += row.totalTokens;
      item.cost += row.cost;
      item.requests += row.requestsCount;
      item.cache += row.cacheReadTokens;
      item.input +=
        row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
      item.lower ||= row.costLowerBound;
      map.set(key, item);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 12);
  }, [records]);
  const stats = [
    [
      "缓存命中率",
      `${summary.cacheRate.toFixed(1)}%`,
      "缓存读取 / 全部输入侧 Tokens",
    ],
    [
      "平均 Tokens / 请求",
      summary.requestsCount
        ? compact(summary.totalTokens / summary.requestsCount)
        : "—",
      `${summary.requestsCount ? money(summary.cost / summary.requestsCount, 4) : "—"} / 请求${summary.lowerBound ? "（费用下界）" : ""}`,
    ],
    [
      "输出 / 输入侧",
      summary.inputSide
        ? `${(((summary.outputTokens + summary.reasoningTokens) / summary.inputSide) * 100).toFixed(1)}%`
        : "—",
      "输出包含 Reasoning Tokens",
    ],
    [
      "每百万 Tokens 费用",
      `${summary.lowerBound ? "≥ " : ""}${summary.totalTokens ? money((summary.cost / summary.totalTokens) * 1e6) : "—"}`,
      "用于结构比较，不代表实际账单",
    ],
  ];
  return (
    <div className="view-stack analytics-view">
      <div className="analysis-stats" aria-label="当前范围分析汇总">
        {stats.map(([label, value, note]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <Section
        title="结构贡献"
        subtitle="按维度定位主要贡献者，占比始终以全部筛选记录为分母"
        action={
          <div className="table-actions">
            <label className="inline-select">
              维度
              <select
                aria-label="分析维度"
                value={dimension}
                onChange={(event) =>
                  setDimension(event.target.value as Dimension)
                }
              >
                {Object.entries(FILTER_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-select">
              指标
              <select
                aria-label="分析指标"
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
          </div>
        }
      >
        <div className="contribution-layout">
          <div className="contribution-bars">
            {groups.slice(0, 14).map((group, index) => (
              <div className="contribution-row" key={group.name}>
                <span title={group.name}>{group.name}</span>
                <div className="progress-track">
                  <div
                    style={{
                      width: `${groups[0]?.value ? (group.value / groups[0].value) * 100 : 0}%`,
                      background: COLORS[index % COLORS.length],
                    }}
                  />
                </div>
                <strong>
                  {metric === "cost"
                    ? money(group.value)
                    : compact(group.value)}
                </strong>
                <small>{group.share.toFixed(1)}%</small>
              </div>
            ))}
            {!groups.length && <EmptyState />}
          </div>
          <div className="concentration">
            <span>前三项贡献</span>
            <strong>{top3.toFixed(1)}%</strong>
            <p className="muted small">
              共 {groups.length} 项。
              {groups.length > 14
                ? "图表展示前 14 项，其余项已计入占比分母。"
                : "已展示全部贡献项。"}
            </p>
          </div>
        </div>
      </Section>
      <Section
        title="设备 × 模型用量矩阵"
        subtitle="展示用量最高的 6 台设备与 6 个模型"
      >
        <div
          className="table-scroll matrix-scroll"
          tabIndex={0}
          role="region"
          aria-label="设备模型用量矩阵"
        >
          {matrix.devices.length ? (
            <table className="matrix">
              <caption className="sr-only">
                每台设备在各模型上的 Tokens 用量
              </caption>
              <thead>
                <tr>
                  <th scope="col">设备 / 模型</th>
                  {matrix.models.map((model) => (
                    <th scope="col" key={model} title={model}>
                      {model}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.devices.map((device) => (
                  <tr key={device}>
                    <th scope="row">{device}</th>
                    {matrix.models.map((model) => {
                      const value =
                        matrix.values.get(JSON.stringify([device, model])) || 0;
                      return (
                        <td key={model}>
                          <span
                            title={`${number(value)} Tokens`}
                            style={{
                              background: `color-mix(in srgb, var(--primary) ${value ? 10 + (42 * value) / matrix.max : 3}%, var(--bg-card))`,
                            }}
                          >
                            {value ? compact(value) : "—"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState />
          )}
        </div>
      </Section>
      <Section
        title="高消耗组合"
        subtitle="按设备、模型、客户端与 Tier 聚合，展示 Tokens 最高的 12 项"
      >
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="高消耗组合表"
        >
          <table>
            <thead>
              <tr>
                {[
                  "设备",
                  "模型",
                  "客户端",
                  "Tier",
                  "Tokens",
                  "估算费用",
                  "请求",
                  "缓存命中率",
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {combinations.map(([key, row]) => (
                <tr key={key}>
                  <td>{row.device}</td>
                  <td className="mono">{row.model}</td>
                  <td>{row.tool}</td>
                  <td>
                    <Badge>{row.tier}</Badge>
                  </td>
                  <td className="numeric">{compact(row.tokens)}</td>
                  <td className="numeric">
                    {row.lower ? "≥ " : ""}
                    {money(row.cost, 4)}
                  </td>
                  <td className="numeric">{number(row.requests)}</td>
                  <td className="numeric">
                    {row.input
                      ? ((row.cache / row.input) * 100).toFixed(1)
                      : "0.0"}
                    %
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!combinations.length && <EmptyState />}
        </div>
      </Section>
      <UsageTable
        rows={requests}
        requests
        limitNote="展示当前各设备账本内保留的请求记录；设备端滚动保留近期明细，并非完整历史。前端不再额外截断，可分页查看或全部导出。"
      />
    </div>
  );
});
