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
  it("首屏只展示当前窗口，公式可核对，明细按需挂载", () => {
    render(<QuotaCycles dataset={subscriptionFixture()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("原定重置")).toBeNull();
    expect(screen.getByText("$1,491.23")).toBeTruthy();
    expect(screen.getByText("$850.00 ÷ 57 × 100 = $1,491.23")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "设备用量" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "用量明细与统计口径" }));
    expect(screen.getByRole("heading", { name: "设备用量" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出本周期 CSV" })).toBeTruthy();
  });
  it("历史入口独立，旧窗口只显示末次观测，不计算总额度金额", () => {
    render(<QuotaCycles dataset={subscriptionFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: "周期历史" }));
    expect(screen.queryByLabelText("当前官方额度")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /原定重置/ }));
    expect(screen.getByText(/历史记录仅用于回顾/)).toBeTruthy();
    expect(screen.queryByText("本周期总金额估算")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回周期历史" }));
    fireEvent.click(screen.getByRole("button", { name: "当前订阅" }));
    expect(screen.getByText("$1,491.23")).toBeTruthy();
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
        .getByRole("progressbar", { name: "官方额度剩余比例" })
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
    expect(screen.queryByText("$1,491.23")).toBeNull();
    missing.officialQuota = { ...missing.officialQuota!, latest: [] };
    rerender(<QuotaCycles dataset={{ ...missing }} />);
    expect(screen.getByText("尚无当前官方额度")).toBeTruthy();
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
  it("零消耗的专用额度仍可选择，但不挪用主额度金额", () => {
    const data = subscriptionFixture();
    data.officialQuota!.latest.push({
      ...data.officialQuota!.latest[0],
      limitId: "spark",
      limitName: "Spark",
    });
    render(<QuotaCycles dataset={data} />);
    fireEvent.click(screen.getByRole("button", { name: /Spark · 1 周/ }));
    expect(screen.getByText("该额度类别尚无独立金额记录")).toBeTruthy();
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
    expect(subscriptionHistory(quota, current)).toHaveLength(1);
  });
  it("定时更新仅使快照过期，不把百分比当实时值继续预测", () => {
    vi.useFakeTimers();
    try {
      render(<QuotaCycles dataset={subscriptionFixture()} />);
      act(() => vi.advanceTimersByTime(16 * 60000));
      expect(screen.getByText("官方快照已过期，等待同步")).toBeTruthy();
      expect(screen.queryByText("$1,491.23")).toBeNull();
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
    expect(screen.getByText("≈ $641.23")).toBeTruthy();
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
    ).toHaveLength(2);
  });
});
