import { describe, expect, it } from "vitest";
import { sanitizeOfficialQuota } from "../src/lib/data";
import {
  aggregateQuotaCycle,
  displayQuotaCycles,
  fullQuotaWindow,
  forecastCycleCost,
  cycleBounds,
  mergeOfficialQuotaData,
} from "../src/lib/quotaCycles";
import type {
  OfficialQuotaCycle,
  OfficialQuotaData,
  OfficialQuotaSnapshot,
} from "../src/lib/types";
import { record } from "./fixtures";
import { forecastQuotaCycle } from "../../rust-cli/local-web/quota-forecast.js";

const iso = (hour: number, minute = 0, second = 0) =>
  new Date(Date.UTC(2026, 8, 7, hour, minute, second)).toISOString();

function cycle(
  overrides: Partial<OfficialQuotaCycle> = {},
): OfficialQuotaCycle {
  return {
    id: "cycle-one",
    accountKey: "account-a",
    account: "a***@example.com",
    limitId: "primary",
    limitName: "Primary",
    windowName: "Rolling window",
    windowMinutes: 60,
    resetsAt: iso(11),
    nominalStartAt: iso(10),
    firstObservedAt: iso(10, 5),
    lastObservedAt: iso(10, 55),
    firstUsedPercent: 5,
    lastUsedPercent: 30,
    samples: [],
    closedAt: null,
    closureReason: null,
    segment: 0,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<OfficialQuotaSnapshot> = {},
): OfficialQuotaSnapshot {
  return {
    provider: "codex",
    source: "codex-app-server",
    accountKey: "account-a",
    account: "a***@example.com",
    limitId: "primary",
    limitName: "Primary",
    planType: "plus",
    updatedAt: iso(10, 30),
    status: "observed",
    windows: [
      {
        name: "Rolling window",
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: iso(11),
        windowMinutes: 60,
      },
    ],
    ...overrides,
  };
}

function quota(
  latest: OfficialQuotaSnapshot[],
  cycles: OfficialQuotaCycle[] = [],
): OfficialQuotaData {
  return { version: 1, latest, cycles, officialUsage: [] };
}

describe("官方订阅周期聚合", () => {
  it("跨设备合计官方订阅分钟桶，并排除官方 API、中转和非 Codex", () => {
    const rows = [
      record({
        id: "mac",
        deviceId: "mac",
        device: "Mac",
        tool: "Codex",
        timestampMs: Date.parse(iso(10, 10)),
        billingChannel: "official-subscription",
        routeType: "official",
        totalTokens: 100,
        requestsCount: 2,
        cost: 0.1,
      }),
      record({
        id: "pc",
        deviceId: "pc",
        device: "PC",
        tool: "codex",
        timestampMs: Date.parse(iso(10, 20)),
        billingChannel: "official-subscription",
        routeType: "official",
        totalTokens: 200,
        requestsCount: 3,
        cost: 0.2,
      }),
      record({
        id: "api",
        timestampMs: Date.parse(iso(10, 30)),
        billingChannel: "official-api",
        routeType: "official",
        totalTokens: 1_000,
      }),
      record({
        id: "relay",
        timestampMs: Date.parse(iso(10, 31)),
        billingChannel: "official-subscription",
        routeType: "relay",
        totalTokens: 2_000,
      }),
      record({
        id: "other",
        timestampMs: Date.parse(iso(10, 32)),
        tool: "Claude Code",
        billingChannel: "official-subscription",
        routeType: "official",
        totalTokens: 4_000,
      }),
    ];
    const result = aggregateQuotaCycle(rows, cycle());
    expect(result.totalTokens).toBe(300);
    expect(result.requests).toBe(5);
    expect(result.cost).toBeCloseTo(0.3);
    expect(result.deviceCount).toBe(2);
    expect(result.devices.map((item) => item.name)).toEqual(["PC", "Mac"]);
  });

  it("严格使用左闭右开窗口，完整分钟桶计入，跨边界桶单列", () => {
    const selected = cycle({
      windowMinutes: 60,
      resetsAt: iso(11, 0, 30),
      nominalStartAt: iso(10, 0, 30),
    });
    const result = aggregateQuotaCycle(
      [
        record({
          id: "left-cross",
          timestampMs: Date.parse(iso(10)),
          totalTokens: 11,
          billingChannel: "official-subscription",
        }),
        record({
          id: "inside",
          timestampMs: Date.parse(iso(10, 1)),
          totalTokens: 20,
          billingChannel: "official-subscription",
        }),
        record({
          id: "right-cross",
          timestampMs: Date.parse(iso(11)),
          totalTokens: 33,
          billingChannel: "official-subscription",
        }),
        record({
          id: "at-end",
          timestampMs: Date.parse(iso(11, 0, 30)),
          totalTokens: 44,
          billingChannel: "official-subscription",
        }),
      ],
      selected,
    );
    expect(result.rows.map((row) => row.id)).toEqual(["inside"]);
    expect(result.boundaryTokens).toBe(44);
    expect(result.boundaryBuckets).toBe(2);
  });

  it("日期精度旧记录不推测小时，并从精确总量排除", () => {
    const result = aggregateQuotaCycle(
      [
        record({
          timestampMs: 0,
          date: "2026-09-07",
          totalTokens: 88,
          billingChannel: "official-subscription",
        }),
      ],
      cycle(),
    );
    expect(result.totalTokens).toBe(0);
    expect(result.legacyTokens).toBe(88);
    expect(result.legacyBuckets).toBe(1);
  });

  it("同名设备按 deviceId 分组，并在显示名中加入区分后缀", () => {
    const result = aggregateQuotaCycle(
      [
        record({
          id: "one",
          deviceId: "1111aabb",
          device: "Mac",
          timestampMs: Date.parse(iso(10, 10)),
          totalTokens: 10,
          billingChannel: "official-subscription",
        }),
        record({
          id: "two",
          deviceId: "2222ccdd",
          device: "Mac",
          timestampMs: Date.parse(iso(10, 11)),
          totalTokens: 20,
          billingChannel: "official-subscription",
        }),
      ],
      cycle(),
    );
    expect(result.devices).toHaveLength(2);
    expect(result.devices.map((item) => item.name)).toEqual([
      "Mac · 2222ccdd",
      "Mac · 1111aabb",
    ]);
  });

  it("调整后的分段从名义起点与首次观测中的较晚者开始", () => {
    expect(
      cycleBounds(
        cycle({
          segment: 1,
          nominalStartAt: iso(10),
          firstObservedAt: iso(10, 17),
        }),
      ).from,
    ).toBe(Date.parse(iso(10, 17)));
  });
});

describe("多设备额度元数据归并", () => {
  it("同账户同额度只选最新百分比，不跨设备相加；重复周期取更新观测", () => {
    const olderCycle = cycle({
      lastUsedPercent: 20,
      lastObservedAt: iso(10, 20),
    });
    const newerCycle = cycle({
      lastUsedPercent: 35,
      lastObservedAt: iso(10, 40),
    });
    const merged = mergeOfficialQuotaData([
      quota([snapshot()], [olderCycle]),
      quota(
        [
          snapshot({
            updatedAt: iso(10, 45),
            windows: [
              {
                ...snapshot().windows[0],
                usedPercent: 25,
                remainingPercent: 75,
              },
            ],
          }),
        ],
        [newerCycle],
      ),
    ])!;
    expect(merged.latest).toHaveLength(1);
    expect(merged.latest[0].windows[0].usedPercent).toBe(25);
    expect(merged.cycles).toHaveLength(1);
    expect(merged.cycles[0].lastUsedPercent).toBe(35);
  });

  it("不同账户保持隔离，即使 limitId 和 cycle id 相同", () => {
    const merged = mergeOfficialQuotaData([
      quota([snapshot()], [cycle()]),
      quota(
        [snapshot({ accountKey: "account-b", account: "b***@example.com" })],
        [cycle({ accountKey: "account-b", account: "b***@example.com" })],
      ),
    ])!;
    expect(merged.latest).toHaveLength(2);
    expect(merged.cycles).toHaveLength(2);
  });

  it("重置点相同但源窗口时长不同的周期不会被合并", () => {
    const merged = mergeOfficialQuotaData([
      quota([], [cycle({ windowMinutes: 60 })]),
      quota([], [cycle({ windowMinutes: 120 })]),
    ])!;
    expect(merged.cycles).toHaveLength(2);
  });

  it("跨设备以最新观测设备的完整分段为权威，再合并周期内样本", () => {
    const deviceA = quota(
      [],
      [
        cycle({
          segment: 0,
          closedAt: iso(10, 20),
          closureReason: "reset-adjustment",
          lastObservedAt: iso(10, 20),
          samples: [{ at: iso(10, 10), usedPercent: 10 }],
        }),
        cycle({
          id: "a-segment",
          segment: 1,
          firstObservedAt: iso(10, 20),
          lastObservedAt: iso(10, 40),
          samples: [{ at: iso(10, 30), usedPercent: 30 }],
        }),
      ],
    );
    const deviceB = quota(
      [],
      [
        cycle({
          segment: 0,
          closedAt: iso(10, 25),
          closureReason: "reset-adjustment",
          lastObservedAt: iso(10, 25),
          samples: [{ at: iso(10, 15), usedPercent: 15 }],
        }),
        cycle({
          id: "b-segment",
          segment: 2,
          firstObservedAt: iso(10, 25),
          lastObservedAt: iso(10, 50),
          samples: [{ at: iso(10, 45), usedPercent: 45 }],
        }),
      ],
    );
    const merged = mergeOfficialQuotaData([deviceA, deviceB])!;
    expect(merged.cycles.map((item) => item.segment)).toEqual([0, 2]);
    expect(merged.cycles[0].samples.map((item) => item.usedPercent)).toEqual([
      10, 15,
    ]);
    expect(merged.cycles[1].samples.map((item) => item.usedPercent)).toEqual([
      30, 45,
    ]);
  });

  it("不同设备调整时间不同时，不把旧段样本混入权威新段", () => {
    const authority = quota(
      [],
      [
        cycle({
          segment: 0,
          closedAt: iso(10, 20),
          lastObservedAt: iso(10, 40),
          samples: [{ at: iso(10, 15), usedPercent: 30 }],
        }),
        cycle({
          id: "authority-new",
          segment: 7,
          firstObservedAt: iso(10, 20),
          lastObservedAt: iso(10, 50),
          samples: [{ at: iso(10, 30), usedPercent: 8 }],
        }),
      ],
    );
    const older = quota(
      [],
      [
        cycle({
          segment: 0,
          closedAt: iso(10, 25),
          lastObservedAt: iso(10, 25),
          samples: [{ at: iso(10, 22), usedPercent: 42 }],
        }),
        cycle({
          id: "older-new",
          segment: 1,
          firstObservedAt: iso(10, 25),
          lastObservedAt: iso(10, 35),
          samples: [{ at: iso(10, 32), usedPercent: 10 }],
        }),
      ],
    );
    const merged = mergeOfficialQuotaData([authority, older])!;
    expect(merged.cycles[0].samples.map((item) => item.usedPercent)).toEqual([
      30,
    ]);
    expect(merged.cycles[1].samples.map((item) => item.usedPercent)).toEqual([
      8, 10,
    ]);
  });

  it("同账户每日用量由较新快照覆盖，不把设备副本相加", () => {
    const first = quota([]);
    first.officialUsage = [
      {
        accountKey: "account-a",
        updatedAt: iso(9),
        summary: {},
        status: "observed",
        dailyUsageBuckets: [
          { startDate: "2026-09-06", tokens: 10 },
          { startDate: "2026-09-07", tokens: 20 },
        ],
      },
    ];
    const second = quota([]);
    second.officialUsage = [
      {
        accountKey: "account-a",
        updatedAt: iso(10),
        summary: {},
        status: "observed",
        dailyUsageBuckets: [{ startDate: "2026-09-07", tokens: 25 }],
      },
    ];
    expect(
      mergeOfficialQuotaData([first, second])!.officialUsage[0]
        .dailyUsageBuckets,
    ).toEqual([
      { startDate: "2026-09-06", tokens: 10 },
      { startDate: "2026-09-07", tokens: 25 },
    ]);
  });
});

describe("共享额度预测", () => {
  it("以稳定近段样本计算速度、终点使用率、耗尽时间与可持续速度", () => {
    const selected = cycle({
      samples: [
        { at: iso(10, 15), usedPercent: 10 },
        { at: iso(10, 22), usedPercent: 15 },
        { at: iso(10, 30), usedPercent: 20 },
      ],
    });
    const forecast = forecastQuotaCycle(selected, Date.parse(iso(10, 30)));
    expect(forecast.state).toBe("ready");
    expect(forecast.recent.ratePercentPerHour).toBeGreaterThan(35);
    expect(forecast.projection.usedPercentAtReset).toBeGreaterThan(39);
    expect(forecast.projection.sustainableRatePercentPerHour).toBe(160);
    expect(forecast.projection.reaches100AtMs).not.toBeNull();
    expect(JSON.stringify(forecast)).not.toMatch(/NaN|Infinity/);
  });

  it("单点仍给可持续速度，但不生成近段速度", () => {
    const forecast = forecastQuotaCycle(
      cycle({ samples: [{ at: iso(10, 30), usedPercent: 20 }] }),
      Date.parse(iso(10, 30)),
    );
    expect(forecast.state).toBe("insufficient");
    expect(forecast.recent.ratePercentPerHour).toBeNull();
    expect(forecast.projection.sustainableRatePercentPerHour).toBe(160);
  });

  it("下降超过舍入容忍后切段，短时突增保留但降级", () => {
    const afterDecrease = forecastQuotaCycle(
      cycle({
        samples: [
          { at: iso(10, 5), usedPercent: 40 },
          { at: iso(10, 15), usedPercent: 50 },
          { at: iso(10, 16), usedPercent: 20 },
          { at: iso(10, 30), usedPercent: 25 },
        ],
      }),
      Date.parse(iso(10, 30)),
    );
    expect(afterDecrease.stableSampleCount).toBe(2);
    expect(afterDecrease.series[0].usedPercent).toBe(20);

    const jump = forecastQuotaCycle(
      cycle({
        samples: [
          { at: iso(10, 10), usedPercent: 0 },
          { at: iso(10, 15), usedPercent: 10 },
          { at: iso(10, 25), usedPercent: 11 },
        ],
      }),
      Date.parse(iso(10, 25)),
    );
    expect(jump.stableSampleCount).toBe(3);
    expect(jump.recent.hasRapidJump).toBe(true);
    expect(jump.state).toBe("partial");
    expect(jump.reason).toBe("rapid-jump");
  });

  it("早期突增离开近段窗口后不再永久降低趋势状态", () => {
    const selected = cycle({
      windowMinutes: 10_080,
      resetsAt: new Date(
        Date.parse(iso(10)) + 7 * 24 * 60 * 60_000,
      ).toISOString(),
      nominalStartAt: iso(10),
      samples: [
        { at: iso(10, 1), usedPercent: 0 },
        { at: iso(10, 5), usedPercent: 10 },
        {
          at: new Date(Date.parse(iso(10)) + 48 * 3_600_000).toISOString(),
          usedPercent: 20,
        },
        {
          at: new Date(Date.parse(iso(10)) + 49 * 3_600_000).toISOString(),
          usedPercent: 22,
        },
        {
          at: new Date(Date.parse(iso(10)) + 50 * 3_600_000).toISOString(),
          usedPercent: 24,
        },
      ],
    });
    const now = Date.parse(iso(10)) + 50 * 3_600_000;
    const forecast = forecastQuotaCycle(selected, now);
    expect(forecast.recent.hasRapidJump).toBe(false);
    expect(forecast.reason).not.toBe("rapid-jump");
  });

  it("节奏基准使用末次观测时刻，未来样本即使只超前一分钟也不参与", () => {
    const forecast = forecastQuotaCycle(
      cycle({
        samples: [
          { at: iso(10, 10), usedPercent: 10 },
          { at: iso(10, 20), usedPercent: 20 },
          { at: iso(10, 31), usedPercent: 90 },
        ],
      }),
      Date.parse(iso(10, 30)),
    );
    expect(forecast.sampleCount).toBe(2);
    expect(forecast.latest.atMs).toBe(Date.parse(iso(10, 20)));
    expect(forecast.pace.expectedUsedPercent).toBeCloseTo(100 / 3);
  });

  it("过期快照和结束周期不输出当前投影，未来样本不能驱动预测", () => {
    const stale = forecastQuotaCycle(
      cycle({
        samples: [
          { at: iso(10, 10), usedPercent: 10 },
          { at: iso(10, 20), usedPercent: 20 },
          { at: iso(10, 40), usedPercent: 95 },
        ],
      }),
      Date.parse(iso(10, 36)),
    );
    expect(stale.sampleCount).toBe(2);
    expect(stale.reason).toBe("stale-snapshot");
    expect(stale.projection.reaches100AtMs).toBeNull();

    const expired = forecastQuotaCycle(
      cycle({
        samples: [
          { at: iso(10, 30), usedPercent: 20 },
          { at: iso(10, 45), usedPercent: 30 },
        ],
      }),
      Date.parse(iso(12)),
    );
    expect(expired.state).toBe("expired");
    expect(expired.projection.usedPercentAtReset).toBeNull();
    expect(expired.projection.reaches100AtMs).toBeNull();
  });
});

it("严格清洗外部额度字段、数值和时间", () => {
  const clean = sanitizeOfficialQuota({
    version: 1,
    latest: [
      snapshot(),
      snapshot({ updatedAt: "yesterday" }),
      {
        ...snapshot(),
        windows: [{ ...snapshot().windows[0], usedPercent: 101 }],
      },
    ],
    cycles: [cycle(), cycle({ segment: 0.5 }), cycle({ resetsAt: "invalid" })],
    officialUsage: {
      accountKey: "account-a",
      updatedAt: iso(10),
      summary: {},
      status: "stale",
      dailyUsageBuckets: [
        { startDate: "2026-09-07", tokens: 12 },
        { startDate: "bad", tokens: 9 },
      ],
    },
  })!;
  expect(clean.latest).toHaveLength(2);
  expect(clean.latest[1].windows).toHaveLength(0);
  expect(clean.cycles).toHaveLength(1);
  expect(clean.officialUsage[0].dailyUsageBuckets).toEqual([
    { startDate: "2026-09-07", tokens: 12 },
  ]);
  expect(clean.officialUsage[0].status).toBe("stale");
});

it("读取失败的近期快照不能显示为当前额度或继续预测", async () => {
  const { createElement } = await import("react");
  const { render, screen, cleanup } = await import("@testing-library/react");
  const { QuotaCycles } = await import("../src/views/QuotaCycles");
  const { dataset } = await import("./fixtures");
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset * 60_000).toISOString();
  const selected = cycle({
    nominalStartAt: at(-30),
    resetsAt: at(30),
    firstObservedAt: at(-25),
    lastObservedAt: at(0),
    lastUsedPercent: 40,
    samples: Array.from({ length: 6 }, (_, i) => ({
      at: at(-25 + i * 5),
      usedPercent: 35 + i,
    })),
  });
  try {
    render(
      createElement(QuotaCycles, {
        dataset: dataset({
          records: [],
          officialQuota: quota([], [selected]),
        }),
      }),
    );
    expect(screen.getByText("快照已过期")).toBeTruthy();
    expect(screen.queryByText("当前官方快照")).toBeNull();
    expect(
      screen.queryByRole("img", {
        name: "当前周期官方比例、理想节奏和线性预测",
      }),
    ).toBeNull();
    expect(screen.getByText("耗尽预测暂不可用")).toBeTruthy();
  } finally {
    cleanup();
  }
});

describe("周期总金额预测", () => {
  const usage = (overrides = {}) =>
    record({
      timestampMs: Date.parse(iso(10, 10)),
      cost: 30,
      billingChannel: "official-subscription",
      ...overrides,
    });
  it("按时间进度外推金额，排除未来记录，不使用官方额度百分比", () => {
    const result = aggregateQuotaCycle(
      [
        usage(),
        usage({
          id: "future",
          timestampMs: Date.parse(iso(10, 45)),
          cost: 900,
        }),
      ],
      cycle({ lastUsedPercent: 90 }),
    );
    const estimate = forecastCycleCost(
      result,
      iso(10, 30),
      Date.parse(iso(10, 30)),
    );
    expect(estimate?.recorded).toBe(30);
    expect(estimate?.total).toBe(60);
    expect(estimate?.elapsedFraction).toBe(0.5);
  });
  it("使用最后同步时刻，避免离线后金额预测随时间错误下降", () => {
    const result = aggregateQuotaCycle([usage()], cycle());
    expect(
      forecastCycleCost(result, iso(10, 20), Date.parse(iso(10, 40)))?.total,
    ).toBe(90);
  });
  it("历史、空记录及无效时间不伪造金额；部分计价保留提示", () => {
    const result = aggregateQuotaCycle(
      [usage({ costLowerBound: true })],
      cycle(),
    );
    expect(
      forecastCycleCost(result, iso(10, 30), Date.parse(iso(10, 30)))
        ?.partialPricing,
    ).toBe(true);
    expect(forecastCycleCost(result, iso(11), Date.parse(iso(11)))).toBeNull();
    expect(
      forecastCycleCost(result, "invalid", Date.parse(iso(10, 30))),
    ).toBeNull();
    expect(
      forecastCycleCost(
        aggregateQuotaCycle([], cycle()),
        iso(10, 30),
        Date.parse(iso(10, 30)),
      ),
    ).toBeNull();
  });
});

describe("周期选择与完整窗口", () => {
  it("同一重置时间的调整片段和秒级漂移只展示最新一项", () => {
    const old = cycle({ closedAt: iso(10, 20), lastObservedAt: iso(10, 20) });
    const latest = cycle({
      resetsAt: iso(11, 0, 1),
      segment: 2,
      firstObservedAt: iso(10, 30),
    });
    expect(displayQuotaCycles([old, latest])).toEqual([latest]);
    expect(cycleBounds(fullQuotaWindow(latest))).toEqual({
      from: Date.parse(iso(10, 0, 1)),
      to: Date.parse(iso(11, 0, 1)),
    });
  });
  it("不混合不同账号或不同重置窗口，并优先最新观测", () => {
    const old = cycle({ resetsAt: iso(12), lastObservedAt: iso(10, 10) });
    const current = cycle();
    const other = cycle({ accountKey: "another" });
    expect(displayQuotaCycles([old, current, other])).toEqual([
      current,
      other,
      old,
    ]);
  });
});
