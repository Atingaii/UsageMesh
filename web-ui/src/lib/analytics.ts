import type {
  DailyTrendPoint,
  FilterState,
  UsageRecord,
  RequestRecord,
} from "./types";

export const DEFAULT_FILTERS: FilterState = {
  timeRange: "all",
  device: "all",
  tool: "all",
  model: "all",
  vendor: "all",
  routeProvider: "all",
  routeType: "all",
  rawProvider: "all",
  tier: "all",
};
export const FILTER_LABELS = {
  device: "设备",
  tool: "客户端",
  model: "模型",
  vendor: "模型厂商",
  routeProvider: "路由提供商",
  routeType: "路由类型",
  rawProvider: "原始 Provider",
  tier: "速率 / Tier",
} as const;
export const TIME_LABELS = {
  today: "今日",
  "7d": "近 7 天",
  "30d": "近 30 天",
  month: "本月",
  all: "全部时间",
  custom: "自定义",
} as const;
export const ROUTE_LABELS: Record<string, string> = {
  official: "官方",
  cloud: "云服务",
  aggregator: "聚合服务",
  relay: "中转",
  "inference-provider": "推理服务",
  inference: "推理服务",
  "self-hosted": "自托管",
  self_hosted: "自托管",
  custom: "自定义",
  unknown: "未知",
};
export const METRICS = {
  totalTokens: "总 Tokens",
  cost: "估算费用",
  requestsCount: "请求数",
  inputTokens: "输入 Tokens",
  cacheReadTokens: "缓存读取",
  cacheWriteTokens: "缓存写入",
  outputTokens: "输出 Tokens",
  reasoningTokens: "Reasoning",
} as const;
export type Metric = keyof typeof METRICS;
export type Dimension = keyof typeof FILTER_LABELS;
export const COLORS = [
  "#625df5",
  "#14a38b",
  "#d99a36",
  "#bf79d4",
  "#4996be",
  "#8a8f9d",
];
export const number = (value: number) =>
  Math.round(value).toLocaleString("zh-CN");
export const compact = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
export const money = (value: number, digits = 2) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export function dateTime(value: string | number) {
  const d = new Date(value);
  return value && Number.isFinite(d.getTime())
    ? d.toLocaleString("zh-CN", { hour12: false })
    : "尚无记录";
}
export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function rowDate(row: { timestampMs: number; date: string }) {
  return row.timestampMs > 0
    ? localDate(new Date(row.timestampMs))
    : row.date.slice(0, 10);
}
export function filterError(filters: FilterState): string | null {
  if (filters.timeRange !== "custom") return null;
  if (!filters.customStartDate || !filters.customEndDate)
    return "请选择完整的开始和结束时间。";
  const start = new Date(filters.customStartDate).getTime(),
    end = new Date(filters.customEndDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return "请输入有效的日期和时间。";
  return start > end ? "结束时间不能早于开始时间。" : null;
}
export function inTimeRange(
  row: { timestampMs: number; date: string },
  filters: FilterState,
  now = new Date(),
): boolean {
  const date = rowDate(row),
    today = localDate(now);
  if (filters.timeRange === "all") return true;
  if (filters.timeRange === "today") return date === today;
  if (filters.timeRange === "7d" || filters.timeRange === "30d") {
    const start = new Date(now);
    start.setDate(start.getDate() - (filters.timeRange === "7d" ? 6 : 29));
    return date >= localDate(start) && date <= today;
  }
  if (filters.timeRange === "month")
    return date.startsWith(today.slice(0, 7)) && date <= today;
  if (filterError(filters)) return false;
  if (row.timestampMs > 0)
    return (
      row.timestampMs >= new Date(filters.customStartDate!).getTime() &&
      row.timestampMs <= new Date(filters.customEndDate!).getTime() + 59_999
    );
  return (
    date >= filters.customStartDate!.slice(0, 10) &&
    date <= filters.customEndDate!.slice(0, 10)
  );
}
export function matchesFilters(
  row: UsageRecord | RequestRecord,
  filters: FilterState,
): boolean {
  return (
    inTimeRange(row, filters) &&
    (Object.keys(FILTER_LABELS) as Dimension[]).every(
      (key) => filters[key] === "all" || row[key] === filters[key],
    )
  );
}
export function sum(rows: UsageRecord[], metric: Metric) {
  return rows.reduce((result, row) => result + row[metric], 0);
}
export function totals(rows: UsageRecord[]) {
  const values = Object.fromEntries(
    Object.keys(METRICS).map((key) => [key, sum(rows, key as Metric)]),
  ) as Record<Metric, number>;
  const inputSide =
    values.inputTokens + values.cacheReadTokens + values.cacheWriteTokens;
  return {
    ...values,
    inputSide,
    cacheRate: inputSide ? (values.cacheReadTokens / inputSide) * 100 : 0,
    lowerBound: rows.some((row) => row.costLowerBound),
  };
}
export function groupRows(
  rows: UsageRecord[],
  dimension: Dimension,
  metric: Metric = "totalTokens",
) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = row[dimension] || "未知";
    groups.set(key, (groups.get(key) || 0) + row[metric]);
  }
  const total = sum(rows, metric);
  return [...groups]
    .map(([name, value]) => ({
      name,
      value,
      share: total ? (value / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
}
export function trend(rows: UsageRecord[]): DailyTrendPoint[] {
  const days = new Map<string, DailyTrendPoint>();
  for (const row of rows) {
    const date = rowDate(row);
    const item = days.get(date) || {
      date,
      label: date.slice(5).replace("-", "/"),
      totalTokens: 0,
      cost: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requestsCount: 0,
    };
    for (const metric of Object.keys(METRICS) as Metric[])
      item[metric] += row[metric];
    days.set(date, item);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Guard spreadsheet formula interpretation, including values with leading whitespace.
export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\s]*[=+@\-\t\r]/.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function makeCsv(headers: string[], rows: unknown[][]) {
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
) {
  const url = URL.createObjectURL(
    new Blob([makeCsv(headers, rows)], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
