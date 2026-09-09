export type QuotaForecastState =
  | "ready"
  | "partial"
  | "insufficient"
  | "expired"
  | "invalid";
export type QuotaForecastReason =
  | "no-samples"
  | "one-sample"
  | "zero-span"
  | "early-window"
  | "flat-usage"
  | "stale-snapshot"
  | "invalid-window"
  | "short-span"
  | "insufficient-change"
  | "rapid-jump"
  | "low-confidence"
  | null;

export interface QuotaForecast {
  version: 1;
  method: "stable-linear-regression-v1";
  state: QuotaForecastState;
  reason: QuotaForecastReason;
  sampleCount: number;
  stableSampleCount: number;
  window: {
    startMs: number | null;
    endMs: number | null;
    elapsedFraction: number | null;
    remainingMs: number | null;
  };
  latest: {
    atMs: number | null;
    usedPercent: number | null;
    ageMs: number | null;
    isStale: boolean;
  };
  pace: {
    expectedUsedPercent: number | null;
    deltaPercent: number | null;
    stage: "far-below" | "below" | "on-track" | "above" | "far-above" | null;
  };
  recent: {
    ratePercentPerHour: number | null;
    spanMs: number | null;
    rSquared: number | null;
    confidence: number;
    hasRapidJump: boolean;
  };
  projection: {
    usedPercentAtReset: number | null;
    reaches90AtMs: number | null;
    reaches100AtMs: number | null;
    exhaustsBeforeReset: boolean;
    sustainableRatePercentPerHour: number | null;
    speedRatio: number | null;
  };
  series: Array<{ atMs: number; usedPercent: number; progress: number }>;
}

export interface QuotaForecastCycleInput {
  windowMinutes?: number | null;
  resetsAt?: string;
  nominalStartAt?: string;
  firstObservedAt?: string;
  closedAt?: string | null;
  segment?: number;
  samples?: Array<{ at?: string; usedPercent?: number }>;
}

export function forecastQuotaCycle(
  cycle: QuotaForecastCycleInput,
  nowMs?: number,
): QuotaForecast;
