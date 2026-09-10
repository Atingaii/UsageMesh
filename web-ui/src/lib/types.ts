export interface UsageRecord {
  id: string;
  date: string;
  timestampMs: number;
  device: string;
  deviceId: string;
  platform: string;
  architecture: string;
  tool: string;
  model: string;
  vendor: string;
  routeProvider: string;
  routeType: string;
  billingChannel: string;
  rawProvider: string;
  tier: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requestsCount: number;
  storedCost: number;
  cost: number;
  costLowerBound: boolean;
  pricingResolved: boolean;
  updatedAt: string;
}

export interface RequestRecord {
  id: string;
  timestampMs: number;
  date: string;
  device: string;
  deviceId: string;
  platform: string;
  architecture: string;
  tool: string;
  model: string;
  vendor: string;
  routeProvider: string;
  routeType: string;
  billingChannel: string;
  rawProvider: string;
  tier: string;
  reasoningEffort: string;
  agent: string;
  durationMs: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requestCount: number;
  cost: number;
  costLowerBound: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  architecture: string;
  lastSync: string;
  presenceAt: string;
  appVersion: string;
  costLowerBound: boolean;
  totalTokens: number;
  cost: number;
  requestsCount: number;
  sharePercentage: number;
  status: "online" | "syncing" | "offline" | "error";
}

export interface DailyTrendPoint {
  date: string;
  label: string;
  totalTokens: number;
  cost: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requestsCount: number;
}

export interface FilterState {
  timeRange: "today" | "7d" | "30d" | "month" | "all" | "custom";
  customStartDate?: string;
  customEndDate?: string;
  device: string;
  tool: string;
  model: string;
  vendor: string;
  routeProvider: string;
  routeType: string;
  rawProvider: string;
  tier: string;
}

export interface DynamicFilterOptions {
  device: string[];
  tool: string[];
  model: string[];
  vendor: string[];
  routeProvider: string[];
  routeType: string[];
  rawProvider: string[];
  tier: string[];
}

export interface PricingStatus {
  source: string;
  sourceUrl: string;
  updatedAt: string | null;
  fastMultiplier: number;
  resolvedRows: number;
  fallbackRows: number;
}

export interface OfficialQuotaWindow {
  name: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface OfficialQuotaSnapshot {
  provider: "codex";
  source: "codex-app-server";
  accountKey: string;
  account: string;
  limitId: string;
  limitName: string;
  planType: string;
  updatedAt: string;
  status: "observed";
  windows: OfficialQuotaWindow[];
}

export interface OfficialQuotaSample {
  at: string;
  usedPercent: number;
}

export interface OfficialQuotaCycle {
  id: string;
  accountKey: string;
  account: string;
  limitId: string;
  limitName: string;
  windowName: string;
  windowMinutes: number | null;
  resetsAt: string;
  nominalStartAt: string;
  firstObservedAt: string;
  lastObservedAt: string;
  firstUsedPercent: number;
  lastUsedPercent: number;
  samples: OfficialQuotaSample[];
  closedAt: string | null;
  closureReason: "reset-adjustment" | "window-changed" | null;
  segment: number;
}

export interface OfficialUsageSnapshot {
  accountKey: string;
  updatedAt: string;
  summary: unknown;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
  status: "observed" | "stale" | "unavailable";
  error?: string;
}

export interface OfficialQuotaData {
  version: 1;
  latest: OfficialQuotaSnapshot[];
  cycles: OfficialQuotaCycle[];
  officialUsage: OfficialUsageSnapshot[];
}

export interface DashboardDataset {
  repo: string;
  records: UsageRecord[];
  requests: RequestRecord[];
  devices: DeviceInfo[];
  pricing: PricingStatus;
  lastSync: string;
  warnings: string[];
  expectedDevices: number;
  /** Devices retained from this session's last successful read after a transient failure. */
  retainedDeviceIds?: string[];
  officialQuota?: OfficialQuotaData;
}

export type ActiveTab =
  | "overview"
  | "analytics"
  | "quota-cycles"
  | "devices"
  | "aggregated"
  | "settings"
  | "guide";
export type SyncStatus = "synced" | "syncing" | "error" | "partial";
