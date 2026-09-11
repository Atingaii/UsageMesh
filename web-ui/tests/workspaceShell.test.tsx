import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NAV, WorkspaceShell } from "../src/components/WorkspaceShell";
import type { ActiveTab } from "../src/lib/types";

HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};

function Shell() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("quota-cycles");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <WorkspaceShell
      activeTab={activeTab}
      onNavigate={setActiveTab}
      collapsed={collapsed}
      onCollapse={() => setCollapsed(!collapsed)}
      mobileOpen={mobileOpen}
      onMobile={setMobileOpen}
      dark={false}
      onTheme={vi.fn()}
      repo="example/UsageMesh"
      status="synced"
      deviceCount={2}
      refreshSeconds={30}
      onRefresh={vi.fn()}
      onLock={vi.fn()}
      onAddDevice={vi.fn()}
    >
      <main id="main-content" tabIndex={-1}>
        <h1>{NAV.find((item) => item.id === activeTab)!.label}</h1>
      </main>
    </WorkspaceShell>
  );
}

describe("精简工作区外壳", () => {
  it("折叠侧栏后仍能识别工作区并访问全部页面和费用口径", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "折叠侧边栏" }));
    expect(
      screen
        .getByRole("link", { name: "example/UsageMesh" })
        .getAttribute("href"),
    ).toBe("https://github.com/example/UsageMesh");
    const nav = screen.getByRole("navigation", { name: "工作区导航" });
    for (const item of NAV) {
      const button = within(nav).getByRole("button", { name: item.label });
      fireEvent.click(button);
      expect(button.getAttribute("aria-current")).toBe("page");
      expect(
        screen.getByRole("heading", { level: 1, name: item.label }),
      ).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: "费用口径" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "接入新设备" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开侧边栏" }));
    expect(screen.getByRole("button", { name: "折叠侧边栏" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "跳转到主要内容" }));
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("移动菜单选中页面或取消后关闭，主内容仍保留对应导航状态", () => {
    render(<Shell />);
    const open = screen.getByRole("button", { name: "打开导航菜单" });
    fireEvent.click(open);
    const menu = screen.getByRole("dialog", { name: "导航菜单" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(menu).getByRole("button", { name: "设备管理" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("heading", { name: "设备管理", level: 1 }),
    ).toBeTruthy();
    fireEvent.click(open);
    fireEvent(
      screen.getByRole("dialog", { name: "导航菜单" }),
      new Event("cancel"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
  });
});
