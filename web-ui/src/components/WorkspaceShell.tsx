import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ChartNoAxesCombined,
  CircleHelp,
  Database,
  Github,
  Gauge,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import type { ActiveTab, SyncStatus } from "../lib/types";
import { Brand } from "./ui";

export const NAV = [
  {
    id: "overview",
    label: "用量概览",
    icon: LayoutDashboard,
    section: "工作空间",
    eyebrow: "WORKSPACE OVERVIEW",
    description: "查看所有设备的用量、费用与近期活动。",
  },
  {
    id: "analytics",
    label: "分析工作台",
    icon: ChartNoAxesCombined,
    eyebrow: "USAGE ANALYTICS",
    description: "比较模型与设备的用量结构，追溯请求明细。",
  },
  {
    id: "quota-cycles",
    label: "订阅用量",
    icon: Gauge,
    eyebrow: "OFFICIAL QUOTA CYCLES",
    description: "查看官方额度、周期用量与价值估算。",
  },
  {
    id: "aggregated",
    label: "数据明细",
    icon: Database,
    eyebrow: "USAGE EXPLORER",
    description: "搜索、筛选和导出设备账本。",
  },
  {
    id: "devices",
    label: "设备管理",
    icon: Monitor,
    section: "管理",
    eyebrow: "CONNECTED DEVICES",
    description: "管理已接入设备，检查心跳与账本同步状态。",
  },
  {
    id: "settings",
    label: "工作区设置",
    icon: Settings2,
    eyebrow: "WORKSPACE SETTINGS",
    description: "管理外观、自动刷新、费用提醒与会话。",
  },
  {
    id: "guide",
    label: "使用指南",
    icon: BookOpen,
    section: "文档",
    eyebrow: "GUIDE",
    description: "了解工作区的功能、数据来源与使用方式。",
  },
] as const;

interface Props {
  activeTab: ActiveTab;
  onNavigate: (tab: ActiveTab) => void;
  collapsed: boolean;
  onCollapse: () => void;
  mobileOpen: boolean;
  onMobile: (open: boolean) => void;
  dark: boolean;
  onTheme: () => void;
  repo: string;
  status: SyncStatus;
  deviceCount: number;
  refreshSeconds: number;
  checkedAt?: number | null;
  onRefresh: () => void;
  onLock: () => void;
  onAddDevice: () => void;
  children: ReactNode;
}
export function WorkspaceShell(props: Props) {
  const {
    activeTab,
    onNavigate,
    collapsed,
    onCollapse,
    mobileOpen,
    onMobile,
    dark,
    onTheme,
    repo,
    status,
    deviceCount,
    refreshSeconds,
    checkedAt,
    onRefresh,
    onLock,
    onAddDevice,
    children,
  } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (mobileOpen) el?.showModal();
    else el?.close();
  }, [mobileOpen]);
  const nav = (small = false) => (
    <>
      <div className="sidebar-brand">
        <Brand compact={small} />
        {!small && (
          <button
            className="icon-button desktop-only"
            aria-label="折叠侧边栏"
            onClick={onCollapse}
          >
            <PanelLeftClose size={17} />
          </button>
        )}
      </div>
      <div className="workspace-label">
        <span className="workspace-avatar">U</span>
        {!small && (
          <div>
            <strong>个人工作区</strong>
            <span title={repo}>{repo}</span>
          </div>
        )}
      </div>
      <nav aria-label="工作区导航">
        {NAV.map((item) => (
          <div key={item.id}>
            {"section" in item && (
              <div className="nav-section">
                {small ? <span className="nav-divider" /> : item.section}
              </div>
            )}
            <button
              className={`nav-item ${activeTab === item.id ? "active" : ""}`}
              aria-current={activeTab === item.id ? "page" : undefined}
              aria-label={item.label}
              title={small ? item.label : undefined}
              onClick={() => {
                onNavigate(item.id);
                onMobile(false);
              }}
            >
              <item.icon size={19} />
              {!small && (
                <>
                  <span>{item.label}</span>
                  {item.id === "devices" && (
                    <span className="nav-count">{deviceCount}</span>
                  )}
                </>
              )}
            </button>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="nav-item"
          onClick={() => {
            onMobile(false);
            onAddDevice();
          }}
          title="接入新设备"
          aria-label="接入新设备"
        >
          <Plus size={18} />
          {!small && <span>接入新设备</span>}
        </button>
        <a
          className="nav-item"
          href="https://github.com/Atingaii/UsageMesh/blob/main/README.zh-CN.md"
          target="_blank"
          rel="noreferrer"
          aria-label="帮助与文档"
          title={small ? "帮助与文档" : undefined}
        >
          <CircleHelp size={18} />
          {!small && (
            <>
              <span>帮助与文档</span>
              <ArrowUpRight size={14} />
            </>
          )}
        </a>
        {small && (
          <button
            className="nav-item"
            aria-label="展开侧边栏"
            onClick={onCollapse}
          >
            <PanelLeftOpen size={19} />
          </button>
        )}
        <div className="sidebar-signature">
          <span className="status-dot" />
          {!small && <span>本地解密 · 加密同步</span>}
        </div>
      </div>
    </>
  );
  const current = NAV.find((item) => item.id === activeTab)!;
  const statusText =
    status === "syncing"
      ? "正在刷新"
      : status === "error"
        ? "刷新失败"
        : status === "partial"
          ? "部分设备未读取"
          : checkedAt
            ? `已检查 ${new Date(checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
            : "尚未检查";
  return (
    <div className={`workspace ${collapsed ? "is-collapsed" : ""}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳转到主要内容
      </a>
      <aside className="sidebar" aria-label="工作区侧边栏">
        {nav(collapsed)}
      </aside>
      <dialog
        ref={dialog}
        className="mobile-sidebar"
        aria-label="导航菜单"
        onCancel={() => onMobile(false)}
        onClick={(event) => {
          if (event.target === dialog.current) onMobile(false);
        }}
      >
        <div className="mobile-sidebar-inner">
          <button
            className="icon-button mobile-close"
            aria-label="关闭导航菜单"
            onClick={() => onMobile(false)}
          >
            <X size={19} />
          </button>
          {nav()}
        </div>
      </dialog>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="打开导航菜单"
              aria-expanded={mobileOpen}
              onClick={() => onMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span className="topbar-workspace">工作区</span>
            <span className="breadcrumb-divider" aria-hidden="true">
              /
            </span>
            <span className="topbar-context">{current.label}</span>
          </div>
          <div className="topbar-actions">
            <span
              className={`sync-label ${status === "error" || status === "partial" ? "warning-text" : ""}`}
              role="status"
              aria-label={statusText}
              title={`${statusText} · ${refreshSeconds ? `每 ${refreshSeconds} 秒自动检查` : "手动刷新模式"}`}
            >
              <span
                className={`status-dot ${status === "syncing" ? "pulsing" : status === "synced" ? "" : "amber"}`}
              />
              {statusText}
            </span>
            <span className="topbar-separator" />
            <button
              className="icon-button"
              aria-label="刷新数据"
              disabled={status === "syncing"}
              onClick={onRefresh}
            >
              <RefreshCw
                size={17}
                className={status === "syncing" ? "spinning" : ""}
              />
            </button>
            <button
              className="icon-button"
              aria-label={dark ? "切换浅色模式" : "切换深色模式"}
              onClick={onTheme}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="icon-button"
              aria-label="锁定工作区"
              onClick={onLock}
            >
              <LockKeyhole size={17} />
            </button>
          </div>
        </header>
        {children}
        <footer className="workspace-footer">
          <span>
            UsageMesh <span className="footer-dot">·</span> 数据由你掌控
          </span>
          <a
            href={`https://github.com/${repo}`}
            target="_blank"
            rel="noreferrer"
          >
            <Github size={13} />
            {repo}
          </a>
          <a
            href="https://github.com/Atingaii/UsageMesh/blob/main/docs/PRICING.md"
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={13} />
            费用口径
          </a>
        </footer>
      </div>
    </div>
  );
}
