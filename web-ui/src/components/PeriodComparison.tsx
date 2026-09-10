import { useMemo, useState } from "react";
import type { DashboardDataset, FilterState } from "../lib/types";
import { compact, localDate, money } from "../lib/analytics";
import {
  changeLabel,
  compareUsage,
  type ComparisonPeriod,
} from "../lib/insights";
import { Section } from "./ui";
export function PeriodComparison({
  dataset,
  filters,
}: {
  dataset: DashboardDataset;
  filters: FilterState;
}) {
  const [period, setPeriod] = useState<ComparisonPeriod>("7d");
  const today = localDate(new Date());
  const result = useMemo(
    () => compareUsage(dataset.records, filters, period),
    [dataset.records, filters, period, today],
  );
  const hasCurrent = result.currentCount > 0,
    hasPrevious = result.previousCount > 0;
  const uncertain =
    dataset.warnings.length > 0 ||
    dataset.devices.length < dataset.expectedDevices;
  const lowerBound = result.current.lowerBound || result.previous.lowerBound;
  return (
    <Section
      title="周期对比"
      subtitle="沿用设备、模型等维度筛选；时间独立选择，按浏览器本地日期排除未结束周期"
      action={
        <select
          aria-label="对比周期"
          value={period}
          onChange={(e) => setPeriod(e.target.value as ComparisonPeriod)}
        >
          <option value="7d">最近完整 7 天</option>
          <option value="30d">最近完整 30 天</option>
          <option value="month">上月与前月</option>
        </select>
      }
    >
      <div className="insights-body">
        <p className="small muted">
          本期：{result.ranges.currentLabel}
          <br />
          前期：{result.ranges.previousLabel}
        </p>
        <div className="comparison-grid">
          {(
            [
              ["totalTokens", "总 Tokens"],
              ["cost", "估算费用"],
              ["requestsCount", "请求数"],
            ] as const
          ).map(([key, label]) => (
            <article key={key}>
              <span>{label}</span>
              <strong>
                {hasCurrent
                  ? `${key === "cost" && result.current.lowerBound ? "≥ " : ""}${key === "cost" ? money(result.current[key]) : compact(result.current[key])}`
                  : "暂无记录"}
              </strong>
              <small>
                前期：
                {hasPrevious
                  ? `${key === "cost" && result.previous.lowerBound ? "≥ " : ""}${key === "cost" ? money(result.previous[key]) : compact(result.previous[key])}`
                  : "暂无记录"}
              </small>
              <p>
                {uncertain
                  ? "账本未完整读取，暂不比较"
                  : changeLabel(
                      result.current[key],
                      result.previous[key],
                      hasCurrent,
                      hasPrevious,
                      key === "cost" && lowerBound,
                    )}
              </p>
            </article>
          ))}
        </div>
        <p className="small muted">
          比较基于已读取账本，不代表已证明历史覆盖完整。无记录不等于零消耗；自然月天数可能不同。
        </p>
        {hasCurrent && hasPrevious && !uncertain && !lowerBound && (
          <div className="comparison-drivers">
            <h3>费用变化最大的模型</h3>
            <ul>
              {result.changes.map((row) => (
                <li key={row.name}>
                  <span>{row.name}</span>
                  <strong>
                    {row.delta > 0 ? "+" : row.delta < 0 ? "−" : ""}
                    {money(Math.abs(row.delta))}
                  </strong>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
