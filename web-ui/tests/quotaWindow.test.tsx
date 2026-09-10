import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuotaCycles } from "../src/views/QuotaCycles";
import { subscriptionFixture } from "./subscriptionFixture";
import {
  currentSubscriptions,
  subscriptionHistory,
} from "../src/lib/subscriptions";

describe("订阅工作台", () => {
  it("首屏先展示官方额度与四项用量，公式和明细按需挂载", () => {
    render(<QuotaCycles dataset={subscriptionFixture()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("原定重置")).toBeNull();
    expect(screen.getByText("≈ $1,491.23")).toBeTruthy();
    expect(screen.queryByText("$850.00 ÷ 57 × 100 = $1,491.23")).toBeNull();
    expect(screen.queryByRole("heading", { name: "设备用量" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "用量明细与统计口径" }));
    expect(screen.getByRole("heading", { name: "设备用量" })).toBeTruthy();
    expect(screen.getByText("$850.00 ÷ 57 × 100 = $1,491.23")).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出本周期 CSV" })).toBeTruthy();
  });
  it("历史只归档实际到期周期，保留末次观测而非结算值", () => {
    const data = subscriptionFixture();
    const cycle = data.officialQuota!.cycles[0];
    const reset = Date.parse(cycle.nominalStartAt);
    data.officialQuota!.cycles.push({
      ...cycle,
      id: "elapsed",
      resetsAt: new Date(reset).toISOString(),
      nominalStartAt: new Date(reset - 7 * 86400000).toISOString(),
      firstObservedAt: new Date(reset - 86400000).toISOString(),
      lastObservedAt: new Date(reset - 60000).toISOString(),
      samples: [{ at: new Date(reset - 60000).toISOString(), usedPercent: 57 }],
      closedAt: cycle.firstObservedAt,
      closureReason: "window-changed",
    });
    render(<QuotaCycles dataset={data} />);
    fireEvent.click(screen.getByRole("button", { name: "周期历史" }));
    expect(screen.queryByLabelText("当前官方额度")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /周期范围/ }));
    expect(screen.getByText(/不代表完整周期的最终用量/)).toBeTruthy();
    expect(screen.queryByText("本周期总金额估算")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回周期历史" }));
    fireEvent.click(screen.getByRole("button", { name: "当前订阅" }));
    expect(screen.getByText("≈ $1,491.23")).toBeTruthy();
  });
  it("已退出账号的真实到期周期仍可从历史账号选择查看", () => {
    const data = subscriptionFixture();
    const cycle = data.officialQuota!.cycles[0];
    const reset = Date.parse(cycle.nominalStartAt);
    data.officialQuota!.cycles.push({
      ...cycle,
      id: "past-account",
      accountKey: "past-account",
      account: "旧订阅",
      resetsAt: new Date(reset).toISOString(),
      nominalStartAt: new Date(reset - 7 * 86400000).toISOString(),
      firstObservedAt: new Date(reset - 86400000).toISOString(),
      lastObservedAt: new Date(reset - 60000).toISOString(),
      samples: [{ at: new Date(reset - 60000).toISOString(), usedPercent: 57 }],
      closedAt: cycle.firstObservedAt,
      closureReason: "window-changed",
    });
    render(<QuotaCycles dataset={data} />);
    expect(screen.queryByRole("combobox", { name: "订阅账号" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "周期历史" }));
    fireEvent.change(screen.getByRole("combobox", { name: "订阅账号" }), {
      target: { value: "past-account" },
    });
    expect(
      screen.getByRole("button", { name: /旧订阅.*周期范围/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "当前订阅" }));
    expect(screen.getByLabelText("当前官方额度")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "订阅账号" })).toBeNull();
  });
  it("重置时自动跟随最新 0% 窗口，不被历史记录掩盖", () => {
    const original = subscriptionFixture();
    const { rerender } = render(<QuotaCycles dataset={original} />);
    const next = subscriptionFixture();
    next.officialQuota!.latest[0].windows[0] = {
      ...next.officialQuota!.latest[0].windows[0],
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    rerender(<QuotaCycles dataset={next} />);
    expect(
      screen
        .getByRole("progressbar", { name: "Codex 每周额度剩余比例" })
        .getAttribute("aria-valuenow"),
    ).toBe("100");
    expect(screen.getByText("额度尚未使用，暂无法估算")).toBeTruthy();
    expect(
      currentSubscriptions(next.officialQuota)[0].cycle!.samples.at(-1)!
        .usedPercent,
    ).toBe(0);
  });
  it("过期/未知时长/无当前快照时不展示伪造估算", () => {
    const data = subscriptionFixture();
    data.officialQuota!.latest[0].updatedAt = new Date(
      Date.now() - 3600000,
    ).toISOString();
    const { rerender } = render(<QuotaCycles dataset={data} />);
    expect(screen.getByText("官方快照已过期，等待同步")).toBeTruthy();
    const missing = subscriptionFixture();
    missing.officialQuota!.latest[0].windows[0].windowMinutes = null;
    rerender(<QuotaCycles dataset={missing} />);
    expect(screen.queryByText("≈ $1,491.23")).toBeNull();
    missing.officialQuota = { ...missing.officialQuota!, latest: [] };
    rerender(<QuotaCycles dataset={{ ...missing }} />);
    expect(screen.getByText("尚无当前官方额度")).toBeTruthy();
  });
  it("未完整计价与低消耗估算的限制在首屏可见", () => {
    const data = subscriptionFixture();
    data.records[0].costLowerBound = true;
    data.officialQuota!.latest[0].windows[0].usedPercent = 3;
    data.officialQuota!.cycles[0].samples = [
      { at: data.officialQuota!.latest[0].updatedAt, usedPercent: 3 },
    ];
    render(<QuotaCycles dataset={data} />);
    expect(screen.getByText(/部分记录未完成计价，金额可能偏低/)).toBeTruthy();
    expect(screen.getByText(/额度用量较少，估算波动可能较大/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "用量明细与统计口径" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
  it("多个账号不得把工作区全部金额除以某个账号的比例", () => {
    const data = subscriptionFixture();
    data.officialQuota!.latest.push({
      ...data.officialQuota!.latest[0],
      accountKey: "second-account",
      account: "Team",
    });
    render(<QuotaCycles dataset={data} />);
    expect(screen.getByText("存在多个账号，暂不混算金额")).toBeTruthy();
  });
  it("同一账号的主额度按行展示，Spark 收入附加区域且不能挪用主额度金额", () => {
    const data = subscriptionFixture();
    data.officialQuota!.latest[0].windows.push({
      ...data.officialQuota!.latest[0].windows[0],
      name: "secondary",
      windowMinutes: 300,
      usedPercent: 30,
    });
    data.officialQuota!.latest.push({
      ...data.officialQuota!.latest[0],
      limitId: "spark",
      limitName: "Spark",
      windows: [
        { ...data.officialQuota!.latest[0].windows[0], usedPercent: 0 },
      ],
    });
    render(<QuotaCycles dataset={data} />);
    expect(screen.getAllByLabelText("当前官方额度")).toHaveLength(1);
    expect(
      screen
        .getByRole("progressbar", { name: "Codex 每周额度剩余比例" })
        .getAttribute("aria-valuenow"),
    ).toBe("43");
    expect(
      screen.getByRole("progressbar", { name: "Codex 5 小时额度剩余比例" }),
    ).toBeTruthy();
    const extra = screen.getByText("其他模型额度").closest("details")!;
    expect(extra.open).toBe(false);
    expect(screen.queryByRole("button", { name: /Spark/ })).toBeNull();
    const select = screen.getByRole("combobox", { name: "统计周期" });
    expect(select.querySelectorAll("option")).toHaveLength(2);
    expect(screen.getByText("≈ $1,491.23")).toBeTruthy();
  });
  it("最新快照覆盖同账号旧快照，秒级漂移合并样本并保留历史隔离", () => {
    const data = subscriptionFixture();
    const quota = data.officialQuota!;
    quota.latest.push({
      ...quota.latest[0],
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      windows: [{ ...quota.latest[0].windows[0], usedPercent: 99 }],
    });
    quota.cycles.push({
      ...quota.cycles[0],
      id: "drift",
      resetsAt: new Date(
        Date.parse(quota.cycles[0].resetsAt) + 1000,
      ).toISOString(),
    });
    const current = currentSubscriptions(quota);
    expect(current).toHaveLength(1);
    expect(current[0].window.usedPercent).toBe(57);
    expect(subscriptionHistory(quota, current)).toHaveLength(0);
  });
  it("定时更新仅使快照过期，不把百分比当实时值继续预测", () => {
    vi.useFakeTimers();
    try {
      render(<QuotaCycles dataset={subscriptionFixture()} />);
      act(() => vi.advanceTimersByTime(16 * 60000));
      expect(screen.getByText("官方快照已过期，等待同步")).toBeTruthy();
      expect(screen.queryByText("≈ $1,491.23")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("切换账号后旧账号从 latest 消失也不能混算", () => {
    const data = subscriptionFixture();
    data.officialQuota!.cycles.push({
      ...data.officialQuota!.cycles[0],
      accountKey: "previous-account",
      id: "previous",
    });
    render(<QuotaCycles dataset={data} />);
    expect(screen.getByText("存在多个账号，暂不混算金额")).toBeTruthy();
  });
  it("观测后新增消费不改变金额卡三项的相同截止时点", () => {
    const data = subscriptionFixture();
    data.records.push({
      ...data.records[0],
      id: "later",
      timestampMs: Date.parse(data.lastSync),
      cost: 30,
    });
    render(<QuotaCycles dataset={data} />);
    expect(screen.getByText("$850.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "用量明细与统计口径" }));
    expect(screen.getByText(/剩余额度估算 ≈ \$641.23/)).toBeTruthy();
    expect(screen.queryByText("$880.00")).toBeNull();
  });
  it("未同步设备标明覆盖不全；已结束但未刷新的周期可在历史找到", () => {
    const data = subscriptionFixture();
    data.devices[1].lastSync = new Date(Date.now() - 3600000).toISOString();
    const { unmount } = render(<QuotaCycles dataset={data} />);
    expect(screen.getByText(/部分设备账本未齐/)).toBeTruthy();
    unmount();
    const current = currentSubscriptions(data.officialQuota);
    expect(
      subscriptionHistory(
        data.officialQuota,
        current,
        Date.parse(current[0].window.resetsAt!) + 1,
      ),
    ).toHaveLength(1);
  });
});

describe("周期归档与周期内变更", () => {
  it("提前改期留在当前明细中，不独立成为历史周期", () => {
    render(<QuotaCycles dataset={subscriptionFixture()} />);
    expect(screen.queryByText("本周期额度变更")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "用量明细与统计口径" }));
    expect(
      screen.getByRole("heading", { name: "本周期额度变更" }),
    ).toBeTruthy();
    expect(screen.getByText(/重置时间：.*→/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "周期历史" }));
    expect(screen.getByText("暂无历史周期")).toBeTruthy();
    expect(screen.queryByText("已替换")).toBeNull();
  });
  it("额度下降后不拿调整前消费反推新比例对应的总金额", () => {
    const data = subscriptionFixture();
    data.officialQuota!.cycles[0].samples[0].usedPercent = 80;
    render(<QuotaCycles dataset={data} />);
    expect(screen.getByText("周期内额度已调整，暂无法换算总金额")).toBeTruthy();
    expect(screen.queryByText("≈ $1,491.23")).toBeNull();
  });
});
