import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageTable } from "../src/components/UsageTable";
import { record, request } from "./fixtures";

describe("可操作的账本表格", () => {
  it("真实分页、跨页搜索与全部结果导出", () => {
    let exported: Blob | null = null;
    URL.createObjectURL = vi.fn((blob) => {
      exported = blob as Blob;
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const rows = Array.from({ length: 61 }, (_, i) =>
      record({
        id: String(i),
        model: `model-${String(i).padStart(3, "0")}`,
        timestampMs: Date.now() + i,
      }),
    );
    render(<UsageTable rows={rows} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      26,
    );
    expect(screen.getByText("显示 1–25 / 共 61 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("显示 26–50 / 共 61 条")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索聚合明细" }), {
      target: { value: "model-000" },
    });
    expect(screen.getByText("显示 1–1 / 共 1 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(exported).not.toBeNull();
    expect((exported as unknown as Blob).size).toBeGreaterThan(61 * 50);
  });
  it("请求明细保留缺失字段和费用下界，排序按钮可聚焦", () => {
    render(<UsageTable rows={[request({ costLowerBound: true })]} requests />);
    expect(screen.getByText("≥ $0.4500")).toBeTruthy();
    expect(screen.getByRole("button", { name: "总 Tokens" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部字段" }));
    expect(screen.getByRole("button", { name: "耗时 (ms)" })).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });
});
