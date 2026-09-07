import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  comparisonRanges,
  compareUsage,
  changeLabel,
  dataQuality,
} from "../src/lib/insights";
import { DEFAULT_FILTERS } from "../src/lib/analytics";
import { PeriodComparison } from "../src/components/PeriodComparison";
import { dataset, record, request } from "./fixtures";

const now = new Date(2026, 8, 7, 12);
const dated = (date: string, cost = 1, model = "A") =>
  record({ date, timestampMs: 0, cost, model });
describe("完整周期对比", () => {
  it("排除今日，以当地自然日建立连续不重叠的 7 天窗口", () => {
    expect(comparisonRanges("7d", now)).toMatchObject({
      start: "2026-08-31",
      end: "2026-09-07",
      previous: "2026-08-24",
    });
    const result = compareUsage(
      [
        dated("2026-08-24", 2),
        dated("2026-08-30", 3),
        dated("2026-08-31", 8),
        dated("2026-09-06", 4),
        dated("2026-09-07", 99),
        dated("2026-08-23", 99),
      ],
      DEFAULT_FILTERS,
      "7d",
      now,
    );
    expect(result.current.cost).toBe(12);
    expect(result.previous.cost).toBe(5);
  });
  it("跨年与闰年自然月不会发生月底溢出", () => {
    expect(comparisonRanges("month", new Date(2024, 2, 31))).toMatchObject({
      start: "2024-02-01",
      end: "2024-03-01",
      previous: "2024-01-01",
      currentLabel: "2024-02-01 — 2024-02-29",
    });
    expect(comparisonRanges("month", new Date(2026, 0, 31)).previous).toBe(
      "2025-11-01",
    );
    expect(comparisonRanges("30d", now).start).toBe("2026-08-08");
  });
  it("保留维度筛选，独立于顶部时间，并包含消失模型的减少", () => {
    const result = compareUsage(
      [
        dated("2026-08-25", 20, "old"),
        dated("2026-09-01", 5, "new"),
        record({ ...dated("2026-09-01", 99), tool: "Other" }),
      ],
      { ...DEFAULT_FILTERS, timeRange: "today", tool: "Codex" },
      "7d",
      now,
    );
    expect(result.current.cost).toBe(5);
    expect(result.changes[0]).toMatchObject({ name: "old", delta: -20 });
  });
  it("缺失、零基数和下界不会输出误导百分比", () => {
    expect(changeLabel(1, 0, true, false)).toContain("记录不足");
    expect(changeLabel(1, 0, true, true)).toContain("前期为 0");
    expect(changeLabel(0, 0, true, true)).toContain("持平");
    expect(changeLabel(5, 10, true, true)).toBe("减少 50.0%");
    expect(changeLabel(5, 10, true, true, true)).toContain("下界");
  });
  it("部分设备失败时隐藏百分比与模型归因", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    render(
      React.createElement(PeriodComparison, {
        dataset: dataset({
          records: [dated("2026-08-25", 1), dated("2026-09-01", 4)],
          warnings: ["设备读取失败"],
          expectedDevices: 1,
        }),
        filters: DEFAULT_FILTERS,
      }),
    );
    expect(screen.getAllByText("账本未完整读取，暂不比较")).toHaveLength(3);
    expect(screen.queryByText("费用变化最大的模型")).toBeNull();
  });
});
describe("数据完整性证据", () => {
  it("区分缺失账本、休眠心跳、过期账本和定价下界", () => {
    const device = {
      id: "a",
      name: "Mac",
      platform: "macOS",
      architecture: "arm64",
      lastSync: "2026-09-01T00:00:00Z",
      presenceAt: "",
      appVersion: "2.5",
      costLowerBound: false,
      totalTokens: 0,
      cost: 0,
      requestsCount: 0,
      sharePercentage: 0,
      status: "offline" as const,
    };
    const result = dataQuality(
      dataset({
        expectedDevices: 2,
        devices: [device],
        records: [dated("2026-09-01"), record({ costLowerBound: true })],
        requests: [
          request({ timestampMs: 100 }),
          request({ timestampMs: 500 }),
        ],
      }),
      now.getTime(),
    );
    expect(result).toMatchObject({
      missing: 1,
      unresolved: 1,
      dated: 1,
      earliest: 100,
      latest: 500,
    });
    expect(result.delayed).toHaveLength(1);
    expect(result.stale).toHaveLength(1);
  });
  it("没有明细时不制造历史覆盖范围", () => {
    expect(dataQuality(dataset({ requests: [] }))).toMatchObject({
      earliest: null,
      latest: null,
    });
  });
});
