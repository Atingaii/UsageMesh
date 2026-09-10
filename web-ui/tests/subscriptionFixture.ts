import { dataset, record } from "./fixtures";
import type { OfficialQuotaCycle } from "../src/lib/types";
export function subscriptionFixture(now = Date.now()) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const reset = now + 5 * 86400000;
  const cycle: OfficialQuotaCycle = {
    id: "weekly",
    accountKey: "demo-account",
    account: "ChatGPT · Pro",
    limitId: "codex",
    limitName: "Codex",
    windowName: "primary",
    windowMinutes: 10080,
    resetsAt: iso(reset),
    nominalStartAt: iso(reset - 7 * 86400000),
    firstObservedAt: iso(now - 36 * 3600000),
    lastObservedAt: iso(now),
    firstUsedPercent: 0,
    lastUsedPercent: 57,
    samples: [
      { at: iso(now - 3600000), usedPercent: 55 },
      { at: iso(now - 1800000), usedPercent: 56 },
      { at: iso(now), usedPercent: 57 },
    ],
    closedAt: null,
    closureReason: null,
    segment: 0,
  };
  const records = Array.from({ length: 120 }, (_, i) =>
    record({
      id: `record-${i}`,
      date: iso(now - (i + 2) * 60000).slice(0, 10),
      timestampMs: now - (i + 2) * 60000,
      deviceId: i % 3 ? "mac" : "linux",
      device: i % 3 ? "MacBook Pro" : "Linux 工作站",
      model: i % 2 ? "gpt-5.6-sol" : "gpt-6-astra",
      billingChannel: "official-subscription",
      cost: 850 / 120,
      totalTokens: 756000000 / 120,
      requestsCount: 50,
    }),
  );
  return dataset({
    repo: "demo/UsageMesh",
    records,
    lastSync: iso(now),
    expectedDevices: 2,
    devices: ["mac", "linux"].map((id, i) => ({
      id,
      name: i ? "Linux 工作站" : "MacBook Pro",
      platform: i ? "linux" : "darwin",
      architecture: "arm64",
      lastSync: iso(now),
      presenceAt: iso(now),
      appVersion: "2.7.0",
      costLowerBound: false,
      totalTokens: 0,
      cost: 0,
      requestsCount: 0,
      sharePercentage: 50,
      status: "online",
    })),
    officialQuota: {
      version: 1,
      latest: [
        {
          provider: "codex",
          source: "codex-app-server",
          accountKey: cycle.accountKey,
          account: cycle.account,
          limitId: "codex",
          limitName: "Codex",
          planType: "pro",
          updatedAt: iso(now),
          status: "observed",
          windows: [
            {
              name: "primary",
              windowMinutes: 10080,
              resetsAt: cycle.resetsAt,
              usedPercent: 57,
              remainingPercent: 43,
            },
          ],
        },
      ],
      cycles: [
        cycle,
        {
          ...cycle,
          id: "old",
          resetsAt: iso(reset - 86400000),
          lastObservedAt: iso(now - 86400000),
          closedAt: iso(now - 86400000),
          closureReason: "window-changed",
        },
      ],
      officialUsage: [],
    },
  });
}
