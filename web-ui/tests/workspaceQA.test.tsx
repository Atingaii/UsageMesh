import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQADataset, WorkspaceQA } from "../qa/subscriptions";
import { NAV } from "../src/components/WorkspaceShell";

HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};

beforeEach(() => {
  history.replaceState(null, "", "/qa/subscriptions.html");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 1000,
    height: 320,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 320,
    toJSON: () => ({}),
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
function show(tab = "aggregated") {
  return render(
    <WorkspaceQA params={new URLSearchParams(`shell&tab=${tab}`)} />,
  );
}
describe("完整工作区 QA", () => {
  it("每个导航都渲染对应真实页面，设备详情会带筛选进入分析", () => {
    show();
    const nav = screen.getByRole("navigation", { name: "工作区导航" });
    for (const item of NAV) {
      fireEvent.click(within(nav).getByRole("button", { name: item.label }));
      expect(
        screen.getByRole("heading", { name: item.label, level: 1 }),
      ).toBeTruthy();
      expect(location.hash).toBe(`#${item.id}`);
    }
    fireEvent.click(within(nav).getByRole("button", { name: "设备管理" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: /MacBook Pro 的设备用量/ })[0],
    );
    expect(
      screen.getByRole("heading", { name: "分析工作台", level: 1 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /设备：MacBook Pro/ }),
    ).toBeTruthy();
    expect(screen.getByText(/108 个聚合桶 · 1 台设备/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(screen.getByText(/176 个聚合桶 · 2 台设备/)).toBeTruthy();
  });
  it("账本搜索、翻页和记录详情都在真实 UsageTable 中工作", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("显示 26–50 / 共 176 条")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索聚合明细"), {
      target: { value: "Linux 工作站" },
    });
    expect(screen.getByText("显示 1–25 / 共 68 条")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "gpt-6-astra" })[0]);
    expect(screen.getByRole("dialog", { name: "用量记录详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("设备接入打开操作说明，锁定与演示解锁可完成闭环", async () => {
    show("devices");
    fireEvent.click(screen.getAllByRole("button", { name: "接入新设备" })[0]);
    expect(screen.getByRole("dialog", { name: "接入新设备" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    fireEvent.click(screen.getByRole("button", { name: "锁定工作区" }));
    expect(screen.getByText(/输入 demo 预览解锁流程/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("工作区密码"), {
      target: { value: "demo" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "解锁工作区" }));
    });
    expect(
      screen.getByRole("heading", { name: "设备管理", level: 1 }),
    ).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });
  it("字号、主题、费用提醒与刷新设定只写演示内存", async () => {
    show("settings");
    fireEvent.change(screen.getByLabelText("阅读字号"), {
      target: { value: "large" },
    });
    expect(document.documentElement.dataset.textSize).toBe("large");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.change(screen.getByLabelText("每月提醒阈值 (USD)"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.getByText("费用提醒已保存")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("自动刷新间隔"), {
      target: { value: "30" },
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    expect(
      (screen.getByRole("button", { name: "刷新数据" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(
      (screen.getByRole("button", { name: "刷新数据" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText("尚未检查")).toBeNull();
    expect(localStorage.getItem("usagemesh:preferences:v1")).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("模拟数据");
  });
  it("设备沿用旧快照时保持用量，模拟恢复后清除标记", async () => {
    vi.useFakeTimers();
    render(
      <WorkspaceQA
        params={new URLSearchParams("shell&tab=devices&state=retained")}
      />,
    );
    expect(screen.getByText("上次快照")).toBeTruthy();
    expect(screen.getByText("部分设备未更新")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "工作区导航" });
    fireEvent.click(within(nav).getByRole("button", { name: "订阅用量" }));
    expect(screen.getByText("≈ $1,491.23")).toBeTruthy();
    expect(screen.getByText(/部分设备沿用上次成功快照/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("≈ $1,491.23")).toBeTruthy();
    expect(screen.queryByText(/部分设备沿用上次成功快照/)).toBeNull();
    expect(screen.queryByText("部分设备未更新")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "设备管理" }));
    expect(screen.queryByText("上次快照")).toBeNull();
  });
  it("样本提供同账号主额度及附加额度，设备总量与账本一致", () => {
    const data = createQADataset();
    expect(
      new Set(data.officialQuota!.latest.map((item) => item.accountKey)).size,
    ).toBe(1);
    expect(
      data.officialQuota!.latest.map((item) => item.windows.length),
    ).toEqual([2, 2]);
    expect(
      data.devices.reduce((sum, device) => sum + device.totalTokens, 0),
    ).toBe(data.records.reduce((sum, row) => sum + row.totalTokens, 0));
    expect(
      data.records.every(
        (row) =>
          row.inputTokens +
            row.cacheReadTokens +
            row.cacheWriteTokens +
            row.outputTokens +
            row.reasoningTokens ===
          row.totalTokens,
      ),
    ).toBe(true);
    expect(
      createQADataset(new URLSearchParams("size=50000")).records,
    ).toHaveLength(50000);
    const empty = createQADataset(new URLSearchParams("state=empty"));
    expect([
      empty.records.length,
      empty.requests.length,
      empty.devices.length,
      empty.officialQuota!.latest.length,
    ]).toEqual([0, 0, 0, 0]);
  });
});
