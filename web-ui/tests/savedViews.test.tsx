import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS } from "../src/lib/analytics";
import { readSavedViews, saveViews } from "../src/lib/savedViews";
import { SavedViews } from "../src/components/SavedViews";

HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
describe("命名视图", () => {
  it("兼容旧视图、仓库隔离，删除后不复活旧视图", () => {
    localStorage.setItem(
      "usagemesh:view:a/b",
      JSON.stringify({ ...DEFAULT_FILTERS, model: "old" }),
    );
    expect(readSavedViews("a/b")[0].filters.model).toBe("old");
    expect(readSavedViews("a/c")).toEqual([]);
    saveViews("a/b", []);
    expect(readSavedViews("a/b")).toEqual([]);
  });
  it("过滤损坏条目和重复 ID", () => {
    localStorage.setItem(
      "usagemesh:views:v2:a/b",
      JSON.stringify([
        null,
        { id: "1", name: "valid", filters: DEFAULT_FILTERS },
        { id: "1", name: "duplicate", filters: DEFAULT_FILTERS },
        {
          id: "2",
          name: "bad",
          filters: { ...DEFAULT_FILTERS, timeRange: "custom" },
        },
      ]),
    );
    expect(readSavedViews("a/b")).toHaveLength(1);
  });
  it("创建、重命名、应用与删除都持久化", () => {
    const onChange = vi.fn();
    render(
      <SavedViews
        repo="a/b"
        filters={{ ...DEFAULT_FILTERS, model: "model-a" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "管理 / 保存视图" }));
    fireEvent.change(screen.getByLabelText("新视图名称"), {
      target: { value: "工作电脑" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存当前筛选" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名 工作电脑" }));
    fireEvent.change(screen.getByLabelText("修改视图名称"), {
      target: { value: "个人项目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(readSavedViews("a/b")[0].name).toBe("个人项目");
    fireEvent.click(screen.getByRole("button", { name: "应用 个人项目" }));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      model: "model-a",
    });
    fireEvent.click(screen.getByRole("button", { name: "管理 / 保存视图" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 个人项目" }));
    expect(readSavedViews("a/b")).toEqual([]);
  });
  it("同名视图与数量上限不会覆盖已有筛选", () => {
    saveViews(
      "a/b",
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        name: `view-${i}`,
        filters: DEFAULT_FILTERS,
      })),
    );
    render(
      <SavedViews
        repo="a/b"
        filters={{ ...DEFAULT_FILTERS, model: "new" }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "管理 / 保存视图" }));
    fireEvent.change(screen.getByLabelText("新视图名称"), {
      target: { value: "view-0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存当前筛选" }));
    expect(screen.getByRole("status").textContent).toContain("同名");
    fireEvent.change(screen.getByLabelText("新视图名称"), {
      target: { value: "new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存当前筛选" }));
    expect(screen.getByRole("status").textContent).toContain("20 个");
    expect(readSavedViews("a/b")).toHaveLength(20);
    expect(readSavedViews("a/b")[0].filters.model).toBe("all");
  });
  it("存储失败明确说明仅本次有效", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    render(
      <SavedViews repo="a/b" filters={DEFAULT_FILTERS} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "管理 / 保存视图" }));
    fireEvent.change(screen.getByLabelText("新视图名称"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存当前筛选" }));
    expect(screen.getByRole("status").textContent).toContain("存储不可用");
    spy.mockRestore();
  });
});
