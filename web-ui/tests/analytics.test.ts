import { describe, expect, it } from "vitest";
import {
  csvCell,
  DEFAULT_FILTERS,
  filterError,
  groupRows,
  inTimeRange,
  makeCsv,
  matchesFilters,
  totals,
  trend,
} from "../src/lib/analytics";
import { record, request } from "./fixtures";

describe("本地日期与一致筛选", () => {
  const now = new Date(2026, 8, 7, 10);
  it("时间戳优先，聚合和请求使用同一本地日边界", () => {
    const timestampMs = new Date(2026, 8, 7, 0, 10).getTime();
    const row = record({ timestampMs, date: "2026-09-06" });
    expect(
      inTimeRange(row, { ...DEFAULT_FILTERS, timeRange: "today" }, now),
    ).toBe(true);
    expect(
      inTimeRange(
        request(row),
        { ...DEFAULT_FILTERS, timeRange: "today" },
        now,
      ),
    ).toBe(true);
    expect(trend([row])[0].date).toBe("2026-09-07");
  });
  it("7天范围包含今天与前6天，排除未来数据", () => {
    const filters = { ...DEFAULT_FILTERS, timeRange: "7d" as const };
    expect(
      inTimeRange(record({ timestampMs: 0, date: "2026-09-01" }), filters, now),
    ).toBe(true);
    expect(
      inTimeRange(record({ timestampMs: 0, date: "2026-08-31" }), filters, now),
    ).toBe(false);
    expect(
      inTimeRange(record({ timestampMs: 0, date: "2026-09-08" }), filters, now),
    ).toBe(false);
  });
  it("自定义范围包含结束分钟的最后一毫秒", () => {
    const filters = {
      ...DEFAULT_FILTERS,
      timeRange: "custom" as const,
      customStartDate: "2026-09-07T10:00",
      customEndDate: "2026-09-07T10:01",
    };
    const end = new Date(filters.customEndDate).getTime();
    expect(inTimeRange(record({ timestampMs: end + 59_999 }), filters)).toBe(
      true,
    );
    expect(inTimeRange(record({ timestampMs: end + 60_000 }), filters)).toBe(
      false,
    );
    expect(inTimeRange(record({ timestampMs: end - 60_001 }), filters)).toBe(
      false,
    );
  });
  it("拒绝不完整和逆序的自定义范围，旧账本按日回退", () => {
    const filters = {
      ...DEFAULT_FILTERS,
      timeRange: "custom" as const,
      customStartDate: "2026-09-08T12:00",
      customEndDate: "2026-09-07T10:00",
    };
    expect(filterError(filters)).toContain("早于");
    expect(inTimeRange(record(), filters)).toBe(false);
    expect(filterError({ ...filters, customEndDate: "" })).toContain("完整");
    expect(
      inTimeRange(record({ timestampMs: 0 }), {
        ...filters,
        customStartDate: "2026-09-07T09:00",
      }),
    ).toBe(true);
  });
  it("所有维度同时应用，不改变记录本身", () => {
    const row = record();
    expect(
      matchesFilters(row, {
        ...DEFAULT_FILTERS,
        device: row.device,
        model: row.model,
      }),
    ).toBe(true);
    expect(matchesFilters(row, { ...DEFAULT_FILTERS, tier: "Fast" })).toBe(
      false,
    );
  });
});
describe("统计与费用口径", () => {
  it("集中度分母包含图表未显示的第15项", () => {
    const groups = groupRows(
      Array.from({ length: 15 }, (_, index) =>
        record({ model: String(index), totalTokens: 100 }),
      ),
      "model",
    );
    expect(
      groups.slice(0, 3).reduce((sum, row) => sum + row.share, 0),
    ).toBeCloseTo(20);
  });
  it("缓存命中率包含缓存写入，并传播费用下界", () => {
    const result = totals([record({ costLowerBound: true })]);
    expect(result.cacheRate).toBeCloseTo((200 / 350) * 100);
    expect(result.cost).toBe(0.45);
    expect(result.lowerBound).toBe(true);
    expect(totals([]).cacheRate).toBe(0);
  });
});
describe("可安全打开的CSV", () => {
  it.each([
    "=SUM(A1)",
    "+cmd",
    "-cmd",
    "@data",
    '  =HYPERLINK("x")',
    "\t=cmd",
    "\r=cmd",
  ])("阻止字符串公式解释 %s", (value) => {
    expect(csvCell(value).startsWith("\"'")).toBe(true);
  });
  it("保留负数数值，转义双引号换行，并包含Excel UTF-8标记", () => {
    expect(csvCell(-1)).toBe('"-1"');
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(makeCsv(["中文"], [["设备"]])).toBe('\uFEFF"中文"\r\n"设备"');
  });
});

describe("批量筛选", () => {
  it("批量谓词沿用本地日期、所有维度和自定义结束分钟规则", async () => {
    const { createFilterPredicate, filterOptions } = await import(
      "../src/lib/analytics"
    );
    const now = new Date(2026, 8, 7, 10);
    const rows = [
      record({ timestampMs: 0, date: "2026-08-31" }),
      record({ timestampMs: new Date(2026, 8, 7, 10, 1, 59, 999).getTime() }),
      record({ timestampMs: new Date(2026, 8, 8).getTime() }),
      record({ timestampMs: 0, model: "other" }),
    ];
    for (const timeRange of [
      "all",
      "today",
      "7d",
      "30d",
      "month",
      "custom",
    ] as const) {
      const filters = {
        ...DEFAULT_FILTERS,
        timeRange,
        model: "test-model",
        customStartDate: "2026-09-07T10:00",
        customEndDate: "2026-09-07T10:01",
      };
      expect(rows.filter(createFilterPredicate(filters, now))).toEqual(
        rows.filter(
          (row) =>
            row.model === filters.model && inTimeRange(row, filters, now),
        ),
      );
    }
    const options = filterOptions(
      [record({ model: "模型10" }), record({ model: "模型2" })],
      [request({ model: "仅明细模型" })],
    );
    expect(options.model).toContain("仅明细模型");
    expect(options.model.indexOf("模型2")).toBeLessThan(
      options.model.indexOf("模型10"),
    );
  });
});
