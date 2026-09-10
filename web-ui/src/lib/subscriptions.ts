import type {
  OfficialQuotaData,
  OfficialQuotaCycle,
  OfficialQuotaSnapshot,
  OfficialQuotaWindow,
} from "./types";
import { displayQuotaCycles } from "./quotaCycles";

export interface SubscriptionWindow {
  key: string;
  snapshot: OfficialQuotaSnapshot;
  window: OfficialQuotaWindow;
  cycle: OfficialQuotaCycle | null;
}
export const windowIdentity = (account: string, limit: string, name: string) =>
  JSON.stringify([account, limit, name]);
export function sameReset(a: string | null, b: string | null) {
  return (
    a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= 5000
  );
}

/** The current view is built from latest snapshots, including new/idle 0% windows. */
export function currentSubscriptions(
  data?: OfficialQuotaData,
): SubscriptionWindow[] {
  if (!data) return [];
  const snapshots = new Map<string, OfficialQuotaSnapshot>();
  for (const item of data.latest) {
    const key = JSON.stringify([item.accountKey, item.limitId]);
    const previous = snapshots.get(key);
    if (
      !previous ||
      Date.parse(item.updatedAt) > Date.parse(previous.updatedAt)
    )
      snapshots.set(key, item);
  }
  const families = new Map<string, OfficialQuotaCycle[]>();
  for (const cycle of data.cycles) {
    const key = windowIdentity(
      cycle.accountKey,
      cycle.limitId,
      cycle.windowName,
    );
    const family = families.get(key) || [];
    family.push(cycle);
    families.set(key, family);
  }
  return [...snapshots.values()]
    .flatMap((snapshot) =>
      snapshot.windows.map((window) => {
        const key = windowIdentity(
          snapshot.accountKey,
          snapshot.limitId,
          window.name,
        );
        const reset = Date.parse(window.resetsAt || "");
        const observed = Date.parse(snapshot.updatedAt);
        let cycle: OfficialQuotaCycle | null = null;
        if (
          Number.isFinite(reset) &&
          Number.isFinite(observed) &&
          window.windowMinutes != null &&
          window.windowMinutes > 0
        ) {
          const start = reset - window.windowMinutes * 60000;
          const samples = new Map<
            string,
            OfficialQuotaCycle["samples"][number]
          >();
          for (const item of (families.get(key) || [])
            .filter(
              (c) =>
                c.windowMinutes === window.windowMinutes &&
                sameReset(c.resetsAt, window.resetsAt),
            )
            .sort(
              (a, b) =>
                Date.parse(a.lastObservedAt) - Date.parse(b.lastObservedAt),
            )) {
            for (const sample of item.samples) {
              const at = Date.parse(sample.at);
              if (at >= start && at <= observed && at < reset)
                samples.set(sample.at, sample);
            }
          }
          samples.set(snapshot.updatedAt, {
            at: snapshot.updatedAt,
            usedPercent: window.usedPercent,
          });
          const ordered = [...samples.values()].sort(
            (a, b) => Date.parse(a.at) - Date.parse(b.at),
          );
          cycle = {
            id: key,
            accountKey: snapshot.accountKey,
            account: snapshot.account,
            limitId: snapshot.limitId,
            limitName: snapshot.limitName,
            windowName: window.name,
            windowMinutes: window.windowMinutes,
            resetsAt: window.resetsAt!,
            nominalStartAt: new Date(start).toISOString(),
            firstObservedAt: ordered[0].at,
            lastObservedAt: snapshot.updatedAt,
            firstUsedPercent: ordered[0].usedPercent,
            lastUsedPercent: window.usedPercent,
            samples: ordered,
            closedAt: null,
            closureReason: null,
            segment: 0,
          };
        }
        return { key, snapshot, window, cycle };
      }),
    )
    .sort(
      (a, b) =>
        (a.snapshot.limitId === "codex" ? 0 : 1) -
          (b.snapshot.limitId === "codex" ? 0 : 1) ||
        a.snapshot.accountKey.localeCompare(b.snapshot.accountKey) ||
        (b.window.windowMinutes || 0) - (a.window.windowMinutes || 0) ||
        a.key.localeCompare(b.key),
    );
}

/** Called only when history is opened. Replaced records remain auditable, never current choices. */
export function subscriptionHistory(
  data: OfficialQuotaData | undefined,
  current: SubscriptionWindow[],
  nowMs = Date.now(),
) {
  return displayQuotaCycles(data?.cycles || [])
    .filter(
      (cycle) =>
        !current.some(
          (item) =>
            Date.parse(item.window.resetsAt || "") > nowMs &&
            item.key ===
              windowIdentity(
                cycle.accountKey,
                cycle.limitId,
                cycle.windowName,
              ) &&
            item.window.windowMinutes === cycle.windowMinutes &&
            sameReset(item.window.resetsAt, cycle.resetsAt),
        ),
    )
    .sort(
      (a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt),
    );
}

/** An account switch can leave only one latest snapshot while older account usage remains. */
export function hasConflictingAccounts(
  data: OfficialQuotaData | undefined,
  selected: SubscriptionWindow,
): boolean {
  if (!data || !selected.cycle) return false;
  const from = Date.parse(selected.cycle.nominalStartAt),
    to = Date.parse(selected.snapshot.updatedAt);
  return (
    data.latest.some(
      (item) => item.accountKey !== selected.snapshot.accountKey,
    ) ||
    data.cycles.some(
      (cycle) =>
        cycle.accountKey !== selected.snapshot.accountKey &&
        Date.parse(cycle.firstObservedAt) <= to &&
        Date.parse(cycle.lastObservedAt) >= from &&
        (cycle.lastUsedPercent > 0 ||
          cycle.samples.some((sample) => sample.usedPercent > 0)),
    )
  );
}
