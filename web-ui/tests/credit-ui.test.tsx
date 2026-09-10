import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "../src/components/FilterBar";
import { Guide } from "../src/views/Guide";
import { DisclosureSection } from "../src/components/ui";
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
        vendor: ["OpenAI"],
        routeProvider: [],
        routeType: [],
        rawProvider: [],
        tier: [],
      }}
    />
  );
}
describe("紧凑工作区导航", () => {
  it("常用筛选始终可见，收起额外条件后保留范围与保存视图", () => {
    render(<Filters />);
    fireEvent.change(screen.getByLabelText("筛选设备"), {
      target: { value: "Mac" },
    });
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    fireEvent.change(screen.getByLabelText("筛选模型厂商"), {
      target: { value: "OpenAI" },
    });
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    expect((screen.getByLabelText("筛选设备") as HTMLSelectElement).value).toBe(
      "Mac",
    );
    expect(screen.queryByLabelText("筛选模型厂商")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "管理 / 保存视图" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /设备：Mac/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    expect((screen.getByLabelText("筛选设备") as HTMLSelectElement).value).toBe(
      "Mac",
    );
    expect(
      screen.getByRole("button", { name: "管理 / 保存视图" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("筛选模型厂商") as HTMLSelectElement).value,
    ).toBe("OpenAI");
  });
  it("收起状态可以移除额外条件，并重置可见筛选与时间范围", () => {
    render(<Filters />);
    fireEvent.change(screen.getByLabelText("筛选设备"), {
      target: { value: "Mac" },
    });
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    fireEvent.change(screen.getByLabelText("筛选模型厂商"), {
      target: { value: "OpenAI" },
    });
    fireEvent.click(screen.getByRole("button", { name: /筛选与视图/ }));
    fireEvent.click(screen.getByRole("button", { name: /模型厂商：OpenAI/ }));
    expect(
      screen.queryByRole("button", { name: /模型厂商：OpenAI/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-09-01T09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect((screen.getByLabelText("筛选设备") as HTMLSelectElement).value).toBe(
      "all",
    );
    expect(screen.queryByLabelText("开始时间")).toBeNull();
    expect(screen.queryByRole("button", { name: /设备：Mac/ })).toBeNull();
  });
  it("辅助分析按需挂载，关闭后释放内容", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function ExpensiveContent() {
      React.useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <p>周期对比内容</p>;
    }
    render(
      <DisclosureSection title="周期对比与数据检查">
        <ExpensiveContent />
      </DisclosureSection>,
    );
    const toggle = screen.getByRole("button", { name: "周期对比与数据检查" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(mounted).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("周期对比内容")).toBeTruthy();
    expect(
      document.getElementById(toggle.getAttribute("aria-controls")!),
    ).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    expect(screen.queryByText("周期对比内容")).toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(1);
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
