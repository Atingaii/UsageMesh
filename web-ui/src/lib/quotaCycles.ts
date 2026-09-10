import type {
  OfficialQuotaCycle,
  OfficialQuotaData,
  OfficialQuotaSnapshot,
  OfficialUsageSnapshot,
  UsageRecord,
} from "./types";

export interface CycleBounds {
  from: number;
  to: number;
}

export interface CycleGroup {
  name: string;
  tokens: number;
  requests: number;
  cost: number;
  lowerBound: boolean;
}

export interface CycleAggregation {
  bounds: CycleBounds;
  rows: UsageRecord[];
  totalTokens: number;
  requests: number;
  cost: number;
  costLowerBound: boolean;
  deviceCount: number;
  devices: CycleGroup[];
  models: CycleGroup[];
  boundaryTokens: number;
  boundaryBuckets: number;
  legacyTokens: number;
  legacyBuckets: number;
}

function time(value: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

export function cycleBounds(cycle: OfficialQuotaCycle): CycleBounds {
  const reset = time(cycle.resetsAt);
  const nominal = time(cycle.nominalStartAt);
  const observed = time(cycle.firstObservedAt);
  const durationStart =
    Number.isFinite(reset) && cycle.windowMinutes != null
      ? reset - cycle.windowMinutes * 60_000
      : nominal;
  const from =
    cycle.segment > 0
      ? Math.max(
          Number.isFinite(nominal) ? nominal : durationStart,
          Number.isFinite(observed) ? observed : durationStart,
        )
      : durationStart;
  const closed = time(cycle.closedAt);
  const to = Number.isFinite(closed) ? Math.min(reset, closed) : reset;
  return { from, to };
}

/** One picker entry per reset window; retain the newest segment for pace forecasts. */
export function displayQuotaCycles(
  cycles: OfficialQuotaCycle[],
): OfficialQuotaCycle[] {
  const groups: OfficialQuotaCycle[][] = [];
  for (const cycle of [...cycles].sort(
    (a, b) => time(a.resetsAt) - time(b.resetsAt),
  )) {
    const group = groups.find(
      ([first]) =>
        first.accountKey === cycle.accountKey &&
        first.limitId === cycle.limitId &&
        first.windowName === cycle.windowName &&
        first.windowMinutes === cycle.windowMinutes &&
        Math.abs(time(first.resetsAt) - time(cycle.resetsAt)) <= 5_000,
    );
    if (group) group.push(cycle);
    else groups.push([cycle]);
  }
  return groups
    .map(
      (group) =>
        [...group].sort(
          (a, b) =>
            time(b.lastObservedAt) - time(a.lastObservedAt) ||
            Number(!!a.closedAt) - Number(!!b.closedAt) ||
            b.segment - a.segment,
        )[0],
    )
    .sort((a, b) => time(b.lastObservedAt) - time(a.lastObservedAt));
}

/** Usage totals describe the whole official window, not a quota adjustment segment. */
export function fullQuotaWindow(cycle: OfficialQuotaCycle): OfficialQuotaCycle {
  return { ...cycle, segment: 0, closedAt: null };
}

function isOfficialSubscription(row: UsageRecord): boolean {
  return (
    row.tool.trim().toLowerCase() === "codex" &&
    row.routeType === "official" &&
    row.billingChannel === "official-subscription"
  );
}

function group(rows: UsageRecord[], key: "device" | "model"): CycleGroup[] {
  const values = new Map<string, CycleGroup>();
  for (const row of rows) {
    const id = key === "device" ? row.deviceId || row.device : row.model;
    const name = row[key] || "未知";
    const value = values.get(id) || {
      name,
      tokens: 0,
      requests: 0,
      cost: 0,
      lowerBound: false,
    };
    value.tokens += row.totalTokens;
    value.requests += row.requestsCount;
    value.cost += row.cost;
    value.lowerBound ||= row.costLowerBound;
    values.set(id, value);
  }
  const groups = [...values.entries()];
  if (key === "device") {
    const names = new Map<string, number>();
    for (const [, value] of groups)
      names.set(value.name, (names.get(value.name) || 0) + 1);
    for (const [id, value] of groups) {
      if ((names.get(value.name) || 0) > 1) {
        const compactId =
          id.replace(/[^a-z0-9]/gi, "").slice(-8) || id.slice(-8);
        value.name = `${value.name} · ${compactId}`;
      }
    }
  }
  return groups
    .map(([, value]) => value)
    .sort(
      (a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name, "zh-CN"),
    );
}

export function aggregateQuotaCycle(
  records: UsageRecord[],
  cycle: OfficialQuotaCycle,
): CycleAggregation {
  const bounds = cycleBounds(cycle);
  const rows: UsageRecord[] = [];
  let boundaryTokens = 0;
  let boundaryBuckets = 0;
  let legacyTokens = 0;
  let legacyBuckets = 0;
  for (const row of records) {
    if (!isOfficialSubscription(row)) continue;
    if (!(row.timestampMs > 0)) {
      legacyTokens += row.totalTokens;
      legacyBuckets += 1;
      continue;
    }
    const bucketStart = row.timestampMs;
    const bucketEnd = bucketStart + 60_000;
    if (bucketStart >= bounds.from && bucketEnd <= bounds.to) {
      rows.push(row);
    } else if (bucketStart < bounds.to && bucketEnd > bounds.from) {
      boundaryTokens += row.totalTokens;
      boundaryBuckets += 1;
    }
  }
  return {
    bounds,
    rows,
    totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    requests: rows.reduce((sum, row) => sum + row.requestsCount, 0),
    cost: rows.reduce((sum, row) => sum + row.cost, 0),
    costLowerBound: rows.some((row) => row.costLowerBound),
    deviceCount: new Set(rows.map((row) => row.deviceId)).size,
    devices: group(rows, "device"),
    models: group(rows, "model"),
    boundaryTokens,
    boundaryBuckets,
    legacyTokens,
    legacyBuckets,
  };
}

/** Extrapolate recorded API-equivalent cost by elapsed time, never quota percent. */
export function forecastCycleCost(
  aggregation: CycleAggregation,
  syncedAt: string | null,
  nowMs = Date.now(),
): {
  total: number;
  recorded: number;
  asOf: number;
  elapsedFraction: number;
  partialPricing: boolean;
} | null {
  const { from, to } = aggregation.bounds;
  const syncedMs = time(syncedAt);
  const asOf = Math.min(nowMs, syncedMs);
  if (
    ![from, to, nowMs, asOf].every(Number.isFinite) ||
    to <= from ||
    nowMs >= to ||
    asOf <= from
  )
    return null;
  // Use completed minutes and the ledger's timestamp so an offline device is
  // not silently treated as having zero spend since its last synchronization.
  const rows = aggregation.rows.filter(
    (row) => row.timestampMs + 60_000 <= asOf,
  );
  if (
    !rows.length ||
    rows.some((row) => !Number.isFinite(row.cost) || row.cost < 0)
  )
    return null;
  const elapsedFraction = (asOf - from) / (to - from);
  const recorded = rows.reduce((sum, row) => sum + row.cost, 0);
  const total = recorded / elapsedFraction;
  if (!Number.isFinite(total)) return null;
  return {
    total,
    recorded,
    asOf,
    elapsedFraction,
    partialPricing: rows.some(
      (row) => row.costLowerBound || !row.pricingResolved,
    ),
  };
}

function snapshotKey(item: OfficialQuotaSnapshot): string {
  return JSON.stringify([item.accountKey, item.limitId]);
}

function cycleFamilyKey(item: OfficialQuotaCycle): string {
  return JSON.stringify([
    item.accountKey,
    item.limitId,
    item.windowName,
    item.windowMinutes,
    item.resetsAt,
  ]);
}

function usageKey(item: OfficialUsageSnapshot): string {
  return item.accountKey;
}

function newer<T>(left: T, right: T, getDate: (value: T) => string): T {
  return time(getDate(right)) >= time(getDate(left)) ? right : left;
}

/** Merge replicated metadata. Quota percentages are observations, never totals. */
export function mergeOfficialQuotaData(
  values: OfficialQuotaData[],
): OfficialQuotaData | undefined {
  if (!values.length) return undefined;
  const latest = new Map<string, OfficialQuotaSnapshot>();
  const cycleFamilies = new Map<string, Map<number, OfficialQuotaCycle[]>>();
  const usage = new Map<string, OfficialUsageSnapshot[]>();
  for (const [sourceIndex, value] of values.entries()) {
    for (const item of value.latest) {
      const key = snapshotKey(item);
      const previous = latest.get(key);
      latest.set(
        key,
        previous ? newer(previous, item, (entry) => entry.updatedAt) : item,
      );
    }
    for (const item of value.cycles) {
      const key = cycleFamilyKey(item);
      const sources = cycleFamilies.get(key) || new Map();
      const sourceCycles = sources.get(sourceIndex) || [];
      sourceCycles.push(item);
      sources.set(sourceIndex, sourceCycles);
      cycleFamilies.set(key, sources);
    }
    for (const item of value.officialUsage) {
      const key = usageKey(item);
      const items = usage.get(key) || [];
      items.push(item);
      usage.set(key, items);
    }
  }
  return {
    version: 1,
    latest: [...latest.values()].sort(
      (a, b) => time(b.updatedAt) - time(a.updatedAt),
    ),
    cycles: [...cycleFamilies.values()]
      .flatMap((sources) => {
        const authority = [...sources.entries()].sort((a, b) => {
          const latest = (cycles: OfficialQuotaCycle[]) =>
            Math.max(...cycles.map((cycle) => time(cycle.lastObservedAt)));
          return latest(b[1]) - latest(a[1]);
        })[0]?.[1];
        if (!authority) return [];
        const orderedAuthority = [...authority].sort(
          (a, b) => cycleBounds(a).from - cycleBounds(b).from,
        );
        const candidatesByAuthority = orderedAuthority.map(
          () => [] as OfficialQuotaCycle[],
        );
        for (const sourceCycles of sources.values()) {
          const orderedSource = [...sourceCycles].sort(
            (a, b) => cycleBounds(a).from - cycleBounds(b).from,
          );
          // Segment numbers and adjustment instants can differ across devices.
          // Only histories with the same complete shape are paired by order, so
          // an older device's pre-adjustment samples cannot enter a newer segment.
          if (orderedSource.length !== orderedAuthority.length) continue;
          for (let index = 0; index < orderedSource.length; index += 1) {
            candidatesByAuthority[index].push(orderedSource[index]);
          }
        }
        return orderedAuthority.map((cycle, authorityIndex) => {
          const bounds = cycleBounds(cycle);
          const samples = new Map<
            string,
            OfficialQuotaCycle["samples"][number]
          >();
          for (const candidate of [
            ...candidatesByAuthority[authorityIndex],
          ].sort((a, b) => time(a.lastObservedAt) - time(b.lastObservedAt))) {
            for (const sample of candidate.samples) {
              const at = time(sample.at);
              if (at >= bounds.from && at < bounds.to)
                samples.set(sample.at, sample);
            }
          }
          return {
            ...cycle,
            samples: [...samples.values()].sort(
              (a, b) => time(a.at) - time(b.at),
            ),
          };
        });
      })
      .sort((a, b) => time(b.resetsAt) - time(a.resetsAt)),
    officialUsage: [...usage.entries()]
      .map(([, items]) => {
        const ordered = [...items].sort(
          (a, b) => time(a.updatedAt) - time(b.updatedAt),
        );
        const base = ordered.at(-1)!;
        const buckets = new Map<
          string,
          { startDate: string; tokens: number }
        >();
        for (const item of ordered)
          for (const bucket of item.dailyUsageBuckets || [])
            buckets.set(bucket.startDate, bucket);
        return {
          ...base,
          dailyUsageBuckets: items.some((item) => item.dailyUsageBuckets)
            ? [...buckets.values()].sort((a, b) =>
                a.startDate.localeCompare(b.startDate),
              )
            : null,
        };
      })
      .sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
  };
}

export function formatWindowDuration(minutes: number | null): string {
  if (minutes == null) return "时长未知";
  if (minutes % 10_080 === 0) return `${minutes / 10_080} 周`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
