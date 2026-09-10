import type { OfficialQuotaCycle } from "./types";

const tolerance = 5000;
const time = (value: string | null) => Date.parse(value || "");
function firstAfter(sorted: number[], after: number) {
  let low = 0,
    high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= after) low = middle + 1;
    else high = middle;
  }
  return sorted[low] ?? Number.NaN;
}
const family = (cycle: OfficialQuotaCycle) =>
  JSON.stringify([
    cycle.accountKey,
    cycle.limitId,
    cycle.windowName,
    cycle.windowMinutes,
  ]);

export interface PeriodChange {
  at: string;
  kind: "reset-time" | "quota-adjustment";
  before: string | number;
  after: string | number;
}
export interface SubscriptionPeriod extends OfficialQuotaCycle {
  changes: PeriodChange[];
}

/** Derive calendar periods without changing or deleting the original observations. */
export function buildSubscriptionPeriods(
  observations: OfficialQuotaCycle[],
  current: OfficialQuotaCycle[],
): SubscriptionPeriod[] {
  const families = new Map<string, OfficialQuotaCycle[][]>();
  for (const cycle of [...observations, ...current].sort(
    (a, b) => time(a.resetsAt) - time(b.resetsAt),
  )) {
    if (
      !cycle.windowMinutes ||
      cycle.windowMinutes <= 0 ||
      !Number.isFinite(time(cycle.resetsAt))
    )
      continue;
    const key = family(cycle);
    const groups = families.get(key) || [];
    const last = groups.at(-1);
    if (
      last &&
      Math.abs(time(last[0].resetsAt) - time(cycle.resetsAt)) <= tolerance
    )
      last.push(cycle);
    else groups.push([cycle]);
    families.set(key, groups);
  }
  const output: SubscriptionPeriod[] = [];
  for (const groups of families.values()) {
    const nodes = groups.map((group) => {
      const ordered = [...group].sort(
        (a, b) =>
          time(a.lastObservedAt) - time(b.lastObservedAt) ||
          (time(a.closedAt) || 0) - (time(b.closedAt) || 0) ||
          a.segment - b.segment ||
          a.id.localeCompare(b.id),
      );
      const authority = [...ordered]
        .reverse()
        .find((cycle) => current.includes(cycle));
      const source = authority || ordered.at(-1)!;
      const reset = time(source.resetsAt);
      const start = reset - source.windowMinutes! * 60000;
      const observed = time(source.lastObservedAt);
      const samples = new Map<number, OfficialQuotaCycle["samples"][number]>();
      // Latest snapshot wins ties; percentage changes never create another period.
      for (const cycle of [...ordered, ...(authority ? [authority] : [])]) {
        for (const sample of [
          { at: cycle.firstObservedAt, usedPercent: cycle.firstUsedPercent },
          ...cycle.samples,
          { at: cycle.lastObservedAt, usedPercent: cycle.lastUsedPercent },
        ]) {
          const at = time(sample.at);
          if (at >= start && at < reset && at <= observed)
            samples.set(at, sample);
        }
      }
      const sorted = [...samples.values()].sort(
        (a, b) => time(a.at) - time(b.at),
      );
      const changes: PeriodChange[] = [];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].usedPercent < sorted[i - 1].usedPercent)
          changes.push({
            at: sorted[i].at,
            kind: "quota-adjustment",
            before: sorted[i - 1].usedPercent,
            after: sorted[i].usedPercent,
          });
      }
      const period: SubscriptionPeriod = {
        ...source,
        nominalStartAt: new Date(start).toISOString(),
        firstObservedAt: sorted[0]?.at || source.firstObservedAt,
        firstUsedPercent: sorted[0]?.usedPercent ?? source.firstUsedPercent,
        samples: sorted,
        segment: 0,
        closedAt: null,
        closureReason: null,
        changes,
      };
      return {
        source,
        period,
        start,
        reset,
        observed,
        sampleTimes: sorted.map((sample) => time(sample.at)),
        authority: !!authority,
        replaced: false,
        parent: -1,
      };
    });
    const raw = groups.flat();
    const membership = new Map<OfficialQuotaCycle, number>();
    groups.forEach((group, index) =>
      group.forEach((cycle) => membership.set(cycle, index)),
    );
    const earlySuccessor = (previous: OfficialQuotaCycle) => {
      const closed = time(previous.closedAt);
      return raw
        .filter(
          (candidate) =>
            Math.abs(time(candidate.resetsAt) - time(previous.resetsAt)) >
              tolerance &&
            time(candidate.firstObservedAt) >= closed - tolerance &&
            time(candidate.firstObservedAt) <
              time(previous.resetsAt) - tolerance &&
            time(candidate.lastObservedAt) > time(previous.lastObservedAt) &&
            closed >=
              time(candidate.resetsAt) - candidate.windowMinutes! * 60000 &&
            closed < time(candidate.resetsAt),
        )
        .sort(
          (a, b) =>
            time(a.firstObservedAt) - time(b.firstObservedAt) ||
            time(b.lastObservedAt) - time(a.lastObservedAt),
        )[0];
    };
    for (const node of nodes) {
      if (node.authority) continue;
      const previous = node.source;
      const closed = time(previous.closedAt);
      const earlyClosure =
        previous.closureReason === "window-changed" &&
        closed < node.reset - tolerance;
      if (earlyClosure) {
        // Link the first observed successor, not whichever final group was updated first.
        const next = earlySuccessor(previous);
        node.replaced = true;
        if (next) node.parent = membership.get(next)!;
        continue;
      }
      // Another device may observe the replacement without recording a closure.
      const successor = nodes
        .map((next, index) => ({
          next,
          index,
          at: firstAfter(next.sampleTimes, node.observed),
        }))
        .filter(
          ({ next, at }) =>
            next !== node &&
            next.observed > node.observed &&
            at < node.reset - tolerance &&
            at >= next.start &&
            at < next.reset &&
            at <= next.observed,
        )
        .sort((a, b) => a.at - b.at || a.next.observed - b.next.observed)[0];
      if (successor) {
        node.replaced = true;
        node.parent = successor.index;
        successor.next.period.changes.push({
          at: new Date(successor.at).toISOString(),
          kind: "reset-time",
          before: previous.resetsAt,
          after: successor.next.period.resetsAt,
        });
      }
    }
    // Preserve every observed transition, including a change back to a previous reset.
    for (const previous of raw) {
      const closed = time(previous.closedAt);
      if (
        previous.closureReason !== "window-changed" ||
        !(closed < time(previous.resetsAt) - tolerance)
      )
        continue;
      const next = earlySuccessor(previous);
      if (!next) continue;
      nodes[membership.get(next)!].period.changes.push({
        at: new Date(
          Math.max(closed, time(next.firstObservedAt)),
        ).toISOString(),
        kind: "reset-time",
        before: previous.resetsAt,
        after: next.resetsAt,
      });
    }
    // Carry adjustments through successive corrections to their final period.
    for (const node of [...nodes].sort(
      (a, b) => time(a.source.lastObservedAt) - time(b.source.lastObservedAt),
    )) {
      if (node.parent >= 0)
        nodes[node.parent].period.changes.push(...node.period.changes);
    }
    for (const node of nodes) {
      if (node.replaced) continue;
      const unique = new Map<string, PeriodChange>();
      for (const change of node.period.changes) {
        const at = time(change.at);
        if (
          at >= time(node.period.nominalStartAt) &&
          at < time(node.period.resetsAt)
        )
          unique.set(JSON.stringify(change), change);
      }
      node.period.changes = [...unique.values()].sort(
        (a, b) => time(a.at) - time(b.at),
      );
      output.push(node.period);
    }
  }
  return output.sort((a, b) => time(b.resetsAt) - time(a.resetsAt));
}

/** Idle rolling snapshots do not provide a stable historical reset boundary. */
export function isElapsedSubscriptionPeriod(
  period: SubscriptionPeriod,
  nowMs: number,
) {
  return (
    time(period.resetsAt) <= nowMs &&
    (period.lastUsedPercent > 0 ||
      period.samples.some((sample) => sample.usedPercent > 0))
  );
}
