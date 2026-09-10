import { describe, expect, it } from "vitest";
import {
  buildSubscriptionPeriods,
  type SubscriptionPeriod,
} from "../src/lib/subscriptionPeriods";
import { mergeOfficialQuotaData } from "../src/lib/quotaCycles";
import {
  currentSubscriptions,
  subscriptionHistory,
} from "../src/lib/subscriptions";
import type { OfficialQuotaCycle, OfficialQuotaData } from "../src/lib/types";

// Every fixture uses this UTC origin; the weekly window ending at hour 168
// starts at hour 0, and the next real weekly window ends at hour 336.
const origin = Date.parse("2026-09-01T00:00:00Z");
const at = (hours: number) =>
  new Date(origin + hours * 3_600_000).toISOString();
function cycle(
  id: string,
  resetHour: number,
  points: [number, number][],
  overrides: Partial<OfficialQuotaCycle> = {},
): OfficialQuotaCycle {
  const samples = points.map(([hours, usedPercent]) => ({
    at: at(hours),
    usedPercent,
  }));
  const first = samples[0],
    last = samples.at(-1)!;
  const windowMinutes = overrides.windowMinutes ?? 10080;
  return {
    id,
    accountKey: "account-a",
    account: "ChatGPT A",
    limitId: "codex",
    limitName: "Codex",
    windowName: "weekly",
    windowMinutes,
    resetsAt: at(resetHour),
    nominalStartAt: at(resetHour - windowMinutes / 60),
    firstObservedAt: first.at,
    lastObservedAt: last.at,
    firstUsedPercent: first.usedPercent,
    lastUsedPercent: last.usedPercent,
    samples,
    closedAt: null,
    closureReason: null,
    segment: 0,
    ...overrides,
  };
}
const resetChanges = (period: SubscriptionPeriod) =>
  period.changes.filter((change) => change.kind === "reset-time");
const replacedOriginal = () =>
  cycle(
    "original",
    168,
    [
      [24, 10],
      [48, 30],
    ],
    { closedAt: at(72), closureReason: "window-changed" },
  );

describe("从官方观测归并真实订阅周期", () => {
  it("同 reset 的不同分段与比例下降合为一周期，保留真实变化及采样缺口", () => {
    const before = cycle(
      "segment-0",
      168,
      [
        [24, 10],
        [48, 40],
      ],
      { closedAt: at(72), closureReason: "reset-adjustment" },
    );
    const after = cycle(
      "segment-1",
      168,
      [
        [72, 5],
        [120, 20],
      ],
      { segment: 1 },
    );
    const result = buildSubscriptionPeriods([before, after], [after]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resetsAt: at(168),
      nominalStartAt: at(0),
      firstObservedAt: at(24),
      lastObservedAt: at(120),
      lastUsedPercent: 20,
      segment: 0,
      closedAt: null,
    });
    expect(result[0].samples.map((sample) => sample.at)).toEqual(
      [24, 48, 72, 120].map(at),
    );
    expect(result[0].changes).toContainEqual({
      at: at(72),
      kind: "quota-adjustment",
      before: 40,
      after: 5,
    });
  });

  it("5 秒 reset 漂移仍是同一周期，并使用当前窗口的到期时间", () => {
    const older = cycle("older-device", 168, [
      [24, 10],
      [48, 20],
    ]);
    const current = cycle("current-device", 168 + 5 / 3600, [[72, 25]]);
    const result = buildSubscriptionPeriods([older], [current]);
    expect(result).toHaveLength(1);
    expect(result[0].resetsAt).toBe(current.resetsAt);
    expect(result[0].lastUsedPercent).toBe(25);
    expect(resetChanges(result[0])).toEqual([]);
  });

  it("提前变更的旧 reset 只成为当前周期 changes，不再列出历史行", () => {
    const replacement = cycle("replacement", 192, [
      [72, 0],
      [96, 15],
    ]);
    const result = buildSubscriptionPeriods(
      [replacedOriginal()],
      [replacement],
    );
    expect(result.map((period) => period.resetsAt)).toEqual([at(192)]);
    expect(resetChanges(result[0])).toEqual([
      { at: at(72), kind: "reset-time", before: at(168), after: at(192) },
    ]);
    expect(result[0].samples).toEqual(replacement.samples);
  });

  it("旧 reset 日期过去后，被替换片段也不能复活为历史周期", () => {
    const completed = cycle(
      "replacement-completed",
      192,
      [
        [72, 0],
        [180, 55],
      ],
      { closedAt: at(192), closureReason: "window-changed" },
    );
    const current = cycle("next-actual-week", 360, [
      [193, 0],
      [240, 15],
    ]);
    const result = buildSubscriptionPeriods(
      [replacedOriginal(), completed],
      [current],
    );
    expect(result.map((period) => period.resetsAt)).toEqual([at(360), at(192)]);
    expect(
      result.find((period) => period.resetsAt === at(168)),
    ).toBeUndefined();
    expect(resetChanges(result[1])).toContainEqual({
      at: at(72),
      kind: "reset-time",
      before: at(168),
      after: at(192),
    });
  });

  it("跨过实际到期边界后开启独立周期，边界采样归新周期", () => {
    const completed = cycle(
      "complete",
      168,
      [
        [24, 10],
        [167, 60],
      ],
      { closedAt: at(168), closureReason: "window-changed" },
    );
    const current = cycle("next", 336, [
      [168, 0],
      [192, 10],
    ]);
    const result = buildSubscriptionPeriods([completed], [current]);
    expect(result.map((period) => period.resetsAt)).toEqual([at(336), at(168)]);
    expect(result[0].samples.map((sample) => sample.at)).toEqual(
      [168, 192].map(at),
    );
    expect(result[1].samples.map((sample) => sample.at)).toEqual(
      [24, 167].map(at),
    );
    expect(result.flatMap(resetChanges)).toEqual([]);
  });

  it("采样跳过一整周期时保留观测到的两期，不补出中间周期", () => {
    const completed = cycle("earlier", 168, [
      [24, 10],
      [100, 30],
    ]);
    const current = cycle("after-gap", 504, [
      [340, 0],
      [360, 5],
    ]);
    const result = buildSubscriptionPeriods([completed], [current]);
    expect(result.map((period) => period.resetsAt)).toEqual([at(504), at(168)]);
    expect(
      result.flatMap((period) => period.samples.map((sample) => sample.at)),
    ).toEqual([340, 360, 24, 100].map(at));
  });

  it("不跨账号、limit、窗口名称或时长归并", () => {
    const variants = [
      {},
      { accountKey: "account-b" },
      { limitId: "codex-other" },
      { windowName: "primary" },
      { windowMinutes: 300 },
    ];
    const observations = variants.map((overrides, index) =>
      cycle(
        `independent-${index}`,
        168,
        [
          [166, 10],
          [167, 20],
        ],
        overrides,
      ),
    );
    const result = buildSubscriptionPeriods(observations, []);
    expect(result).toHaveLength(observations.length);
    expect(new Set(result.map((period) => period.id))).toEqual(
      new Set(observations.map((period) => period.id)),
    );
  });

  it("当前官方 0% 覆盖同一时点的旧历史比例", () => {
    const history = cycle("old-copy", 168, [
      [24, 10],
      [120, 80],
    ]);
    const current = cycle("current-zero", 168, [[120, 0]]);
    const result = buildSubscriptionPeriods([history], [current]);
    expect(result).toHaveLength(1);
    expect(result[0].lastUsedPercent).toBe(0);
    expect(result[0].samples.at(-1)).toEqual({ at: at(120), usedPercent: 0 });
  });

  it("多份当前窗口中最新的 0% 仍有权威性，与输入顺序无关", () => {
    const older = cycle("older-current", 168, [[96, 80]]);
    const latest = cycle("latest-zero", 168, [[120, 0]]);
    for (const current of [
      [older, latest],
      [latest, older],
    ]) {
      const result = buildSubscriptionPeriods([], current);
      expect(result).toHaveLength(1);
      expect(result[0].lastObservedAt).toBe(at(120));
      expect(result[0].lastUsedPercent).toBe(0);
      expect(result[0].samples.at(-1)).toEqual({ at: at(120), usedPercent: 0 });
    }
  });

  it("R1→R2→R1 回拨保留两次变化，R2 的用量不能污染恢复的 R1", () => {
    const firstR1 = cycle(
      "first-r1",
      168,
      [
        [24, 10],
        [48, 70],
      ],
      { closedAt: at(72), closureReason: "window-changed" },
    );
    const middleR2 = cycle(
      "middle-r2",
      192,
      [
        [72, 80],
        [96, 99],
      ],
      { closedAt: at(120), closureReason: "window-changed" },
    );
    const restoredR1 = cycle("restored-r1", 168, [
      [120, 0],
      [144, 0],
    ]);
    const result = buildSubscriptionPeriods([firstR1, middleR2], [restoredR1]);
    expect(result).toHaveLength(1);
    expect(result[0].resetsAt).toBe(at(168));
    expect(result[0].lastUsedPercent).toBe(0);
    expect(result[0].samples.some((sample) => sample.usedPercent === 99)).toBe(
      false,
    );
    expect(result[0].samples.at(-1)).toEqual({ at: at(144), usedPercent: 0 });
    expect(resetChanges(result[0])).toEqual([
      { at: at(72), kind: "reset-time", before: at(168), after: at(192) },
      { at: at(120), kind: "reset-time", before: at(192), after: at(168) },
    ]);
  });

  it("历史完整周期不被分段编号或内部 closedAt 裁切，也不发明起点采样", () => {
    const before = cycle(
      "natural-segment-0",
      168,
      [
        [4, 5],
        [70, 40],
      ],
      { closedAt: at(72), closureReason: "reset-adjustment" },
    );
    const after = cycle(
      "natural-segment-1",
      168,
      [
        [72, 10],
        [167, 65],
      ],
      { closedAt: at(168), closureReason: "window-changed", segment: 1 },
    );
    const next = cycle("current-next", 336, [
      [168, 0],
      [192, 5],
    ]);
    const result = buildSubscriptionPeriods([before, after], [next]);
    const historical = result.find((period) => period.resetsAt === at(168))!;
    expect(historical).toMatchObject({
      nominalStartAt: at(0),
      resetsAt: at(168),
      firstObservedAt: at(4),
      lastObservedAt: at(167),
      closedAt: null,
      closureReason: null,
      segment: 0,
    });
    expect(historical.samples.map((sample) => sample.at)).toEqual(
      [4, 70, 72, 167].map(at),
    );
    expect(result).toHaveLength(2);
  });

  it("另一设备未记录 closedAt 时，提前观测到的新 reset 仍取代旧窗口", () => {
    const original = cycle("other-device-old", 168, [
      [24, 10],
      [48, 30],
    ]);
    const replacement = cycle("official-current", 192, [
      [72, 0],
      [96, 15],
    ]);
    const result = buildSubscriptionPeriods([original], [replacement]);
    expect(result.map((period) => period.resetsAt)).toEqual([at(192)]);
    expect(resetChanges(result[0])).toEqual([
      { at: at(72), kind: "reset-time", before: at(168), after: at(192) },
    ]);
  });

  it("回拨后再跨真实到期，恢复的 R1 成为完整历史，R2 不会复活", () => {
    const firstR1 = cycle(
      "first-r1",
      168,
      [
        [24, 10],
        [48, 70],
      ],
      {
        closedAt: at(72),
        closureReason: "window-changed",
      },
    );
    const middleR2 = cycle(
      "middle-r2",
      192,
      [
        [72, 80],
        [96, 99],
      ],
      {
        closedAt: at(120),
        closureReason: "window-changed",
      },
    );
    const restoredR1 = cycle(
      "completed-restored-r1",
      168,
      [
        [120, 0],
        [167, 20],
      ],
      {
        closedAt: at(168),
        closureReason: "window-changed",
      },
    );
    const next = cycle("actual-next", 336, [
      [169, 0],
      [200, 5],
    ]);
    const result = buildSubscriptionPeriods(
      [firstR1, middleR2, restoredR1],
      [next],
    );
    expect(result.map((period) => period.resetsAt)).toEqual([at(336), at(168)]);
    const history = result[1];
    expect(history).toMatchObject({
      nominalStartAt: at(0),
      lastUsedPercent: 20,
      closedAt: null,
    });
    expect(history.samples.some((sample) => sample.usedPercent === 99)).toBe(
      false,
    );
    expect(resetChanges(history)).toEqual([
      { at: at(72), kind: "reset-time", before: at(168), after: at(192) },
      { at: at(120), kind: "reset-time", before: at(192), after: at(168) },
    ]);
  });

  it("跨设备相同末次观测保留提前关闭证据，中间窗口缺失也不让旧周期复活", () => {
    const closed = cycle(
      "closed-device",
      168,
      [
        [24, 10],
        [48, 30],
      ],
      {
        closedAt: at(72),
        closureReason: "window-changed",
      },
    );
    const open = cycle("open-device", 168, [
      [24, 10],
      [48, 30],
    ]);
    // The replacement observed at hour 72 is no longer retained. Only a much
    // later official snapshot remains, after the original deadline has passed.
    const fromDevice = (replica: OfficialQuotaCycle): OfficialQuotaData => ({
      version: 1,
      latest: [
        {
          provider: "codex",
          source: "codex-app-server",
          status: "observed",
          accountKey: replica.accountKey,
          account: replica.account,
          limitId: replica.limitId,
          limitName: replica.limitName,
          planType: "pro",
          updatedAt: at(360),
          windows: [
            {
              name: replica.windowName,
              windowMinutes: replica.windowMinutes,
              resetsAt: at(504),
              usedPercent: 5,
              remainingPercent: 95,
            },
          ],
        },
      ],
      cycles: [replica],
      officialUsage: [],
    });
    const results = [
      [closed, open],
      [open, closed],
    ].map((replicas) => {
      const merged = mergeOfficialQuotaData(replicas.map(fromDevice))!;
      expect(merged.cycles).toHaveLength(1);
      expect(merged.cycles[0]).toMatchObject({
        resetsAt: at(168),
        lastObservedAt: at(48),
        closedAt: at(72),
        closureReason: "window-changed",
      });
      const current = currentSubscriptions(merged);
      expect(current).toHaveLength(1);
      expect(current[0].cycle).toMatchObject({
        resetsAt: at(504),
        firstObservedAt: at(360),
        lastObservedAt: at(360),
      });
      const history = subscriptionHistory(merged, current, Date.parse(at(360)));
      expect(history).toEqual([]);
      // Also retain the same closure evidence when raw replicas reach the
      // period builder directly, before the cross-device merge stage.
      expect(
        buildSubscriptionPeriods(replicas, [current[0].cycle!]).map(
          (period) => period.resetsAt,
        ),
      ).toEqual([at(504)]);
      return { merged, current, history };
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("R1→R2→R3→R2 只保留真实后继变更，不虚构 R1 直接跳到 R3", () => {
    const first = cycle(
      "first-r1",
      168,
      [
        [24, 10],
        [48, 50],
      ],
      { closedAt: at(72), closureReason: "window-changed" },
    );
    const second = cycle(
      "first-r2",
      192,
      [
        [72, 0],
        [96, 70],
      ],
      { closedAt: at(120), closureReason: "window-changed" },
    );
    const third = cycle(
      "temporary-r3",
      216,
      [
        [120, 0],
        [144, 60],
      ],
      { closedAt: at(160), closureReason: "window-changed" },
    );
    const restored = cycle("restored-r2", 192, [
      [160, 0],
      [180, 15],
    ]);
    const orders = [
      [first, second, third],
      [first, third, second],
      [second, first, third],
      [second, third, first],
      [third, first, second],
      [third, second, first],
    ];
    const results = orders.map((observations) => {
      const periods = buildSubscriptionPeriods(observations, [restored]);
      expect(periods).toHaveLength(1);
      expect(periods[0]).toMatchObject({
        resetsAt: at(192),
        lastObservedAt: at(180),
        lastUsedPercent: 15,
      });
      expect(resetChanges(periods[0])).toEqual([
        { at: at(72), kind: "reset-time", before: at(168), after: at(192) },
        { at: at(120), kind: "reset-time", before: at(192), after: at(216) },
        { at: at(160), kind: "reset-time", before: at(216), after: at(192) },
      ]);
      return periods;
    });
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it("归并不修改原始观测对象或原始采样", () => {
    const replacement = cycle("replacement", 192, [
      [72, 0],
      [96, 15],
    ]);
    const input = [replacedOriginal(), replacement];
    const before = JSON.stringify(input);
    buildSubscriptionPeriods(input, [replacement]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
