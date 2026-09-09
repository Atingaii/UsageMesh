const MIN_RATE = 0.001;
const STALE_MS = 15 * 60_000;
const MIN_READY_SPAN_MS = 10 * 60_000;
const ROUNDING_TOLERANCE = 1;
const RAPID_JUMP_POINTS = 5;
const RAPID_JUMP_MS = 10 * 60_000;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function timestamp(value) {
  const result = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

function empty(reason) {
  return {
    version: 1,
    method: "stable-linear-regression-v1",
    state: "invalid",
    reason,
    sampleCount: 0,
    stableSampleCount: 0,
    window: {
      startMs: null,
      endMs: null,
      elapsedFraction: null,
      remainingMs: null,
    },
    latest: { atMs: null, usedPercent: null, ageMs: null, isStale: false },
    pace: { expectedUsedPercent: null, deltaPercent: null, stage: null },
    recent: {
      ratePercentPerHour: null,
      spanMs: null,
      rSquared: null,
      confidence: 0,
      hasRapidJump: false,
    },
    projection: {
      usedPercentAtReset: null,
      reaches90AtMs: null,
      reaches100AtMs: null,
      exhaustsBeforeReset: false,
      sustainableRatePercentPerHour: null,
      speedRatio: null,
    },
    series: [],
  };
}

function regression(samples) {
  if (samples.length < 2) return null;
  const origin = samples[0].atMs;
  const points = samples.map((sample) => ({
    x: (sample.atMs - origin) / 3_600_000,
    y: sample.usedPercent,
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let ssXX = 0;
  let ssXY = 0;
  let ssTotal = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    ssXX += dx * dx;
    ssXY += dx * dy;
    ssTotal += dy * dy;
  }
  if (!(ssXX > 0)) return null;
  const slope = ssXY / ssXX;
  let ssError = 0;
  for (const point of points) {
    const predicted = meanY + slope * (point.x - meanX);
    ssError += (point.y - predicted) ** 2;
  }
  const rSquared =
    ssTotal === 0 ? 1 : Math.max(0, Math.min(1, 1 - ssError / ssTotal));
  return { slope, rSquared };
}

function thresholdAt(latest, rate, threshold) {
  if (latest.usedPercent >= threshold) return latest.atMs;
  if (!(rate > 0)) return null;
  const hours = (threshold - latest.usedPercent) / rate;
  const result = latest.atMs + hours * 3_600_000;
  return Number.isFinite(result) && result >= latest.atMs ? result : null;
}

function paceStage(delta) {
  if (delta < -6) return "far-below";
  if (delta < -2) return "below";
  if (delta <= 2) return "on-track";
  if (delta <= 6) return "above";
  return "far-above";
}

export function forecastQuotaCycle(cycle, nowMs = Date.now()) {
  if (!cycle || typeof cycle !== "object" || !finite(nowMs))
    return empty("invalid-window");
  const resetMs = timestamp(cycle.resetsAt);
  const nominalStartMs = timestamp(cycle.nominalStartAt);
  const firstObservedMs = timestamp(cycle.firstObservedAt);
  const closedMs = cycle.closedAt == null ? null : timestamp(cycle.closedAt);
  const durationMinutes =
    finite(cycle.windowMinutes) && cycle.windowMinutes > 0
      ? cycle.windowMinutes
      : null;
  if (resetMs == null || durationMinutes == null)
    return empty("invalid-window");
  const durationMs = durationMinutes * 60_000;
  const fullStartMs = resetMs - durationMs;
  const startMs =
    Number(cycle.segment) > 0
      ? Math.max(nominalStartMs ?? fullStartMs, firstObservedMs ?? fullStartMs)
      : fullStartMs;
  const endMs = closedMs == null ? resetMs : Math.min(resetMs, closedMs);
  if (
    !finite(startMs) ||
    !(endMs > startMs) ||
    resetMs - fullStartMs !== durationMs
  )
    return empty("invalid-window");

  const raw = Array.isArray(cycle.samples) ? cycle.samples : [];
  const unique = new Map();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const atMs = timestamp(value.at);
    if (atMs == null || atMs < startMs || atMs >= endMs || atMs > nowMs)
      continue;
    if (
      !finite(value.usedPercent) ||
      value.usedPercent < 0 ||
      value.usedPercent > 100
    )
      continue;
    unique.set(atMs, {
      atMs,
      usedPercent: value.usedPercent,
    });
  }
  const samples = [...unique.values()].sort((a, b) => a.atMs - b.atMs);
  const base = empty(samples.length ? "one-sample" : "no-samples");
  base.state = endMs <= nowMs ? "expired" : "insufficient";
  base.sampleCount = samples.length;
  base.window = {
    startMs,
    endMs,
    elapsedFraction: Math.max(
      0,
      Math.min(1, (Math.min(nowMs, endMs) - fullStartMs) / durationMs),
    ),
    remainingMs: Math.max(0, endMs - nowMs),
  };
  if (!samples.length) return base;

  let stableStart = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index].usedPercent - samples[index - 1].usedPercent;
    if (delta < -ROUNDING_TOLERANCE) {
      stableStart = index;
    }
  }
  const stable = samples.slice(stableStart);
  const latest = stable.at(-1);
  const ageMs = Math.max(0, nowMs - latest.atMs);
  const isStale = endMs > nowMs && ageMs > STALE_MS;
  const latestProgress = Math.max(
    0,
    Math.min(1, (latest.atMs - fullStartMs) / durationMs),
  );
  const expected = latestProgress * 100;
  const deltaPercent = latest.usedPercent - expected;
  base.stableSampleCount = stable.length;
  base.latest = {
    atMs: latest.atMs,
    usedPercent: latest.usedPercent,
    ageMs,
    isStale,
  };
  base.pace = {
    expectedUsedPercent: expected,
    deltaPercent,
    stage: paceStage(deltaPercent),
  };
  base.series = stable.map((sample) => ({
    ...sample,
    progress: Math.max(
      0,
      Math.min(1, (sample.atMs - fullStartMs) / durationMs),
    ),
  }));

  if (!isStale && endMs > nowMs) {
    const remainingHours = Math.max(0, resetMs - nowMs) / 3_600_000;
    base.projection.sustainableRatePercentPerHour =
      remainingHours > 0 ? (100 - latest.usedPercent) / remainingHours : null;
  }

  const recentHorizonMs = Math.max(
    15 * 60_000,
    Math.min(24 * 3_600_000, durationMs * 0.1),
  );
  const horizonRecent = stable.filter(
    (sample) => sample.atMs >= latest.atMs - recentHorizonMs,
  );
  let recent = horizonRecent;
  if (recent.length < 2) recent = stable.slice(-5);
  let hasRapidJump = false;
  for (let index = 1; index < horizonRecent.length; index += 1) {
    const delta =
      horizonRecent[index].usedPercent - horizonRecent[index - 1].usedPercent;
    const elapsed = horizonRecent[index].atMs - horizonRecent[index - 1].atMs;
    if (delta > RAPID_JUMP_POINTS && elapsed <= RAPID_JUMP_MS) {
      hasRapidJump = true;
    }
  }
  const spanMs = recent.length > 1 ? latest.atMs - recent[0].atMs : 0;
  const observedChange =
    recent.length > 1 ? latest.usedPercent - recent[0].usedPercent : 0;
  const fit = regression(recent);
  if (!fit) {
    base.reason = stable.length < 2 ? "one-sample" : "zero-span";
    return base;
  }
  const rate = fit.slope < MIN_RATE ? 0 : fit.slope;
  const spanFactor = Math.max(0, Math.min(1, spanMs / recentHorizonMs));
  const jumpFactor = hasRapidJump ? 0.6 : 1;
  const confidence = Math.max(
    0,
    Math.min(
      1,
      Math.min(recent.length / 5, 1) * fit.rSquared * spanFactor * jumpFactor,
    ),
  );
  base.recent = {
    ratePercentPerHour: rate,
    spanMs,
    rSquared: fit.rSquared,
    confidence,
    hasRapidJump,
  };

  if (!isStale && endMs > nowMs) {
    const projectionHours = Math.max(0, resetMs - latest.atMs) / 3_600_000;
    const sustainableHours = Math.max(0, resetMs - nowMs) / 3_600_000;
    const sustainable =
      sustainableHours > 0
        ? (100 - latest.usedPercent) / sustainableHours
        : null;
    const projected = latest.usedPercent + rate * projectionHours;
    const reaches90AtMs = thresholdAt(latest, rate, 90);
    const reaches100AtMs = thresholdAt(latest, rate, 100);
    base.projection = {
      usedPercentAtReset: projected,
      reaches90AtMs,
      reaches100AtMs,
      exhaustsBeforeReset: reaches100AtMs != null && reaches100AtMs < resetMs,
      sustainableRatePercentPerHour: sustainable,
      speedRatio:
        sustainable != null && sustainable > 0 ? rate / sustainable : null,
    };
  }

  if (endMs <= nowMs) {
    base.state = "expired";
    base.reason = null;
  } else if (isStale) {
    base.state = "partial";
    base.reason = "stale-snapshot";
  } else if (stable.length < 3) {
    base.state = "partial";
    base.reason = "low-confidence";
  } else if (spanMs < MIN_READY_SPAN_MS) {
    base.state = "partial";
    base.reason = "short-span";
  } else if (observedChange < 1) {
    base.state = "partial";
    base.reason = rate === 0 ? "flat-usage" : "insufficient-change";
  } else if (base.window.elapsedFraction < 0.08) {
    base.state = "partial";
    base.reason = "early-window";
  } else if (hasRapidJump) {
    base.state = "partial";
    base.reason = "rapid-jump";
  } else if (confidence < 0.35) {
    base.state = "partial";
    base.reason = "low-confidence";
  } else {
    base.state = "ready";
    base.reason = null;
  }
  return base;
}
