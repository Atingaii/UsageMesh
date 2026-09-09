import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "../src/components/FilterBar";
import { Guide } from "../src/views/Guide";
import { DEFAULT_FILTERS } from "../src/lib/analytics";

function Filters() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  return (
    <FilterBar
      filters={filters}
      onChange={setFilters}
      repo="credit/qa"
      options={{
        device: ["Mac"],
        tool: [],
        model: [],
        vendor: [],
        routeProvider: [],
        routeType: [],
        rawProvider: [],
        tier: [],
      }}
    />
  );
}
describe("紧凑工作区导航", () => {
  it("收起详细筛选后保留条件，重新展开仍可管理保存视图", () => {
    render(<Filters />);
    fireEvent.click(screen.getByRole("button", { name: "筛选与视图" }));
    fireEvent.change(screen.getByLabelText("筛选设备"), {
      target: { value: "Mac" },
    });
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    expect(screen.queryByLabelText("筛选设备")).toBeNull();
    expect(screen.getByRole("button", { name: /设备：Mac/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    expect((screen.getByLabelText("筛选设备") as HTMLSelectElement).value).toBe(
      "Mac",
    );
    expect(
      screen.getByRole("button", { name: "管理 / 保存视图" }),
    ).toBeTruthy();
  });
  it("指南章节跳转不改写应用路由", () => {
    history.replaceState(null, "", "/#guide");
    render(<Guide onBack={vi.fn()} />);
    const section = document.getElementById("guide-local")!;
    section.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole("link", { name: /本地管理$/ }));
    expect(section.scrollIntoView).toHaveBeenCalled();
    expect(location.hash).toBe("#guide");
  });
});
