import { localDate, matchesFilters, rowDate, totals } from "./analytics";
import { deviceSyncStatus } from "./data";
import type { DashboardDataset, FilterState, UsageRecord } from "./types";
export type ComparisonPeriod = "7d" | "30d" | "month";
export function comparisonRanges(period: ComparisonPeriod, now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end),
    previous = new Date(end);
  if (period === "month") {
    end.setDate(1);
    start.setDate(1);
    start.setMonth(start.getMonth() - 1);
    previous.setDate(1);
    previous.setMonth(previous.getMonth() - 2);
  } else {
    const days = period === "7d" ? 7 : 30;
    start.setDate(start.getDate() - days);
    previous.setDate(previous.getDate() - days * 2);
  }
  const label = (a: Date, b: Date) => {
    const inclusive = new Date(b);
    inclusive.setDate(inclusive.getDate() - 1);
    return `${localDate(a)} — ${localDate(inclusive)}`;
  };
  return {
    start: localDate(start),
    end: localDate(end),
    previous: localDate(previous),
    currentLabel: label(start, end),
    previousLabel: label(previous, start),
  };
}
export function compareUsage(
  records: UsageRecord[],
  filters: FilterState,
  period: ComparisonPeriod,
  now = new Date(),
) {
  const ranges = comparisonRanges(period, now);
  const scope = records.filter((row) =>
    matchesFilters(row, { ...filters, timeRange: "all" }),
  );
  const current = scope.filter(
    (row) => rowDate(row) >= ranges.start && rowDate(row) < ranges.end,
  );
  const previous = scope.filter(
    (row) => rowDate(row) >= ranges.previous && rowDate(row) < ranges.start,
  );
  const models = new Map<
    string,
    { name: string; current: number; previous: number }
  >();
  for (const [rows, key] of [
    [current, "current"],
    [previous, "previous"],
  ] as const)
    for (const row of rows) {
      const item = models.get(row.model) || {
        name: row.model || "未知模型",
        current: 0,
        previous: 0,
      };
      item[key] += row.cost;
      models.set(row.model, item);
    }
  return {
    ranges,
    current: totals(current),
    previous: totals(previous),
    currentCount: current.length,
    previousCount: previous.length,
    changes: [...models.values()]
      .map((v) => ({ ...v, delta: v.current - v.previous }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3),
  };
}
export function changeLabel(
  current: number,
  previous: number,
  hasCurrent: boolean,
  hasPrevious: boolean,
  lowerBound = false,
) {
  if (!hasCurrent || !hasPrevious) return "记录不足，暂不计算变化";
  if (lowerBound) return "费用为下界，暂不计算变化";
  if (previous === 0)
    return current === 0 ? "与前期持平" : "前期为 0，不计算百分比";
  const change = ((current - previous) / previous) * 100;
  return change === 0
    ? "与前期持平"
    : `${change > 0 ? "增加" : "减少"} ${Math.abs(change).toFixed(1)}%`;
}
export function dataQuality(dataset: DashboardDataset, now = Date.now()) {
  const missing = Math.max(0, dataset.expectedDevices - dataset.devices.length);
  const delayed = dataset.devices.filter(
    (d) => deviceSyncStatus(d.presenceAt, now) !== "online",
  );
  const stale = dataset.devices.filter(
    (d) =>
      !Number.isFinite(Date.parse(d.lastSync)) ||
      now - Date.parse(d.lastSync) > 24 * 60 * 60 * 1000,
  );
  const unresolved = dataset.records.filter(
    (r) => !r.pricingResolved || r.costLowerBound,
  ).length;
  const dated = dataset.records.filter((r) => !r.timestampMs).length;
  const dates = dataset.requests
    .map((r) => r.timestampMs)
    .filter((t) => t > 0 && Number.isFinite(t));
  let earliest = Infinity,
    latest = -Infinity;
  for (const t of dates) {
    earliest = Math.min(earliest, t);
    latest = Math.max(latest, t);
  }
  return {
    missing,
    delayed,
    stale,
    unresolved,
    dated,
    earliest: Number.isFinite(earliest) ? earliest : null,
    latest: Number.isFinite(latest) ? latest : null,
  };
}
