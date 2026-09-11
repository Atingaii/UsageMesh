import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Overview } from "../src/views/Overview";

describe("概览费用提醒", () => {
  it("只显示用户已启用的提醒，进度独立于页面筛选且保留费用下界", () => {
    const onNavigate = vi.fn();
    const props = {
      records: [],
      onNavigate,
      monthlyCost: 125,
      lowerBound: true,
    };
    const { rerender } = render(<Overview {...props} budget={0} />);
    expect(screen.queryByText(/费用提醒/)).toBeNull();

    rerender(<Overview {...props} budget={100} />);
    expect(screen.getByText("本月费用提醒 · ≥ $125.00 / $100.00")).toBeTruthy();
    expect(screen.getByText(/已达到提醒阈值的 125.0%/)).toBeTruthy();
    expect(
      screen.getByText(/按本月全部设备估算，不受页面筛选影响/),
    ).toBeTruthy();
    expect(screen.getByText(/已达到设定阈值/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "调整提醒" }));
    expect(onNavigate).toHaveBeenCalledWith("settings");

    rerender(<Overview {...props} budget={200} />);
    expect(screen.getByText(/已达到提醒阈值的 62.5%/)).toBeTruthy();
    expect(screen.queryByText(/已达到设定阈值/)).toBeNull();

    rerender(<Overview {...props} budget={0} />);
    expect(screen.queryByText(/费用提醒/)).toBeNull();
    expect(screen.queryByRole("button", { name: "调整提醒" })).toBeNull();
  });
});
