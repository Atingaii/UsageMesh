import React, {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { AlertCircle, Download, Plus, RefreshCw } from "lucide-react";
import { useDashboard } from "./hooks/useDashboard";
import {
  DEFAULT_FILTERS,
  FILTER_LABELS,
  matchesFilters,
  money,
  number,
  totals,
  TIME_LABELS,
  type Dimension,
} from "./lib/analytics";
import {
  readPreference,
  readPreferences,
  writePreference,
  type Preferences,
} from "./lib/preferences";
import type { ActiveTab, DynamicFilterOptions, FilterState } from "./lib/types";
import { UnlockScreen } from "./components/UnlockScreen";
import { NAV, WorkspaceShell } from "./components/WorkspaceShell";
import { FilterBar } from "./components/FilterBar";
import { Badge, EmptyState } from "./components/ui";
import { exportRows, UsageTable } from "./components/UsageTable";
import { ConnectDevice } from "./components/ConnectDevice";
import "./index.css";

const Overview = lazy(() =>
  import("./views/Overview").then((module) => ({ default: module.Overview })),
);
const Analytics = lazy(() =>
  import("./views/Analytics").then((module) => ({ default: module.Analytics })),
);
const Devices = lazy(() =>
  import("./views/Devices").then((module) => ({ default: module.Devices })),
);
const Settings = lazy(() =>
  import("./views/Settings").then((module) => ({ default: module.Settings })),
);

function readTab(): ActiveTab {
  const tab = location.hash.slice(1);
  return NAV.some((item) => item.id === tab) ? (tab as ActiveTab) : "overview";
}
function parseSaved(repo: string): FilterState | null {
  try {
    const value = JSON.parse(
      readPreference(`usagemesh:view:${repo}`) || "null",
    );
    if (
      !value ||
      !Object.prototype.hasOwnProperty.call(TIME_LABELS, value.timeRange)
    )
      return null;
    const filters = { ...DEFAULT_FILTERS, timeRange: value.timeRange };
    for (const key of Object.keys(FILTER_LABELS) as Dimension[])
      if (typeof value[key] === "string") filters[key] = value[key];
    if (typeof value.customStartDate === "string")
      filters.customStartDate = value.customStartDate;
    if (typeof value.customEndDate === "string")
      filters.customEndDate = value.customEndDate;
    return filters;
  } catch {
    return null;
  }
}
function App() {
  const [preferences, setPreferences] = useState(readPreferences),
    [activeTab, setActiveTab] = useState(readTab);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark =
    preferences.theme === "dark" ||
    (preferences.theme === "system" && systemDark);
  const [collapsed, setCollapsed] = useState(
      () => readPreference("usagemesh:sidebar") === "collapsed",
    ),
    [mobileOpen, setMobileOpen] = useState(false),
    [connectOpen, setConnectOpen] = useState(false);
  const [filters, setFilters] = useState<FilterState>({ ...DEFAULT_FILTERS }),
    [savedView, setSavedView] = useState<FilterState | null>(null);
  const dashboard = useDashboard(preferences.refreshSeconds);
  const { dataset, error, syncStatus, checking, checkedAt, sessionNotice } =
    dashboard;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => {
    writePreference("usagemesh:preferences:v1", JSON.stringify(preferences));
  }, [preferences]);
  useEffect(() => {
    writePreference("usagemesh:sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);
  useEffect(() => {
    const update = () => setActiveTab(readTab());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const unlocked = Boolean(dataset);
  useEffect(() => {
    if (unlocked) {
      heading.current?.focus();
      window.scrollTo(0, 0);
    }
  }, [activeTab, unlocked]);
  useEffect(() => {
    if (dataset?.repo) setSavedView(parseSaved(dataset.repo));
  }, [dataset?.repo]);
  const navigate = (tab: ActiveTab) => {
    location.hash = tab;
    setActiveTab(tab);
  };
  const options = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(FILTER_LABELS) as Dimension[]).map((key) => [
          key,
          [
            ...new Set(
              [...(dataset?.records || []), ...(dataset?.requests || [])]
                .map((row) => row[key])
                .filter(Boolean),
            ),
          ].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
        ]),
      ) as unknown as DynamicFilterOptions,
    [dataset],
  );
  const records = useMemo(
    () =>
      (dataset?.records || []).filter((row) => matchesFilters(row, filters)),
    [dataset, filters],
  );
  const requests = useMemo(
    () =>
      (dataset?.requests || []).filter((row) => matchesFilters(row, filters)),
    [dataset, filters],
  );
  const month = useMemo(
    () =>
      totals(
        (dataset?.records || []).filter((row) =>
          matchesFilters(row, { ...DEFAULT_FILTERS, timeRange: "month" }),
        ),
      ),
    [dataset],
  );
  const current = NAV.find((item) => item.id === activeTab)!;
  const hasFilters =
    activeTab === "overview" ||
    activeTab === "analytics" ||
    activeTab === "aggregated";
  if (checking)
    return (
      <div className="loading-screen" role="status">
        <RefreshCw size={22} className="spinning" />
        <p>正在恢复加密工作区…</p>
      </div>
    );
  if (!dataset)
    return (
      <UnlockScreen
        onUnlock={dashboard.unlock}
        error={error}
        notice={sessionNotice}
      />
    );
  return (
    <WorkspaceShell
      activeTab={activeTab}
      onNavigate={navigate}
      collapsed={collapsed}
      onCollapse={() => setCollapsed(!collapsed)}
      mobileOpen={mobileOpen}
      onMobile={setMobileOpen}
      dark={dark}
      onTheme={() =>
        setPreferences({ ...preferences, theme: dark ? "light" : "dark" })
      }
      repo={dataset.repo}
      status={syncStatus}
      deviceCount={dataset.devices.length}
      refreshSeconds={preferences.refreshSeconds}
      onRefresh={() => void dashboard.refresh()}
      onLock={() => {
        setConnectOpen(false);
        setMobileOpen(false);
        dashboard.lock();
      }}
      onAddDevice={() => setConnectOpen(true)}
    >
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading">
          <div>
            <div className="eyebrow">{current.eyebrow}</div>
            <div className="page-title">
              <h1 ref={heading} tabIndex={-1}>
                {current.label}
              </h1>
              {activeTab === "overview" && <Badge>个人工作区</Badge>}
            </div>
            <p>{current.description}</p>
          </div>
          <div className="page-actions">
            {activeTab === "devices" ? (
              <button
                className="button primary"
                onClick={() => setConnectOpen(true)}
              >
                <Plus size={16} />
                接入新设备
              </button>
            ) : hasFilters ? (
              <button
                className="button"
                disabled={!records.length}
                onClick={() => exportRows(records)}
              >
                <Download size={16} />
                导出当前数据
              </button>
            ) : null}
          </div>
        </div>
        {(error || dataset.warnings.length > 0) && (
          <div className="notice warning" role="alert">
            <AlertCircle size={18} />
            <div>
              <strong>
                {error
                  ? "刷新失败，正在显示上一次成功快照"
                  : `${dataset.expectedDevices - dataset.devices.length} 台设备读取失败，当前总量不完整`}
              </strong>
              <p>
                {error ||
                  "已读取的设备可以继续查看，请在设备管理中检查失败详情。"}
              </p>
            </div>
            <button
              className="button"
              disabled={syncStatus === "syncing"}
              onClick={() => void dashboard.refresh()}
            >
              重试
            </button>
          </div>
        )}
        {sessionNotice && (
          <p role="status" className="notice">
            {sessionNotice}
          </p>
        )}
        {preferences.monthlyBudget > 0 &&
          month.cost >= preferences.monthlyBudget && (
            <div className="notice warning">
              <AlertCircle size={18} />
              <p>
                本月全部设备估算{month.lowerBound ? "至少 " : ""}
                {money(month.cost)}，已达到 {money(preferences.monthlyBudget)}{" "}
                的费用提醒阈值。
              </p>
              <button
                className="text-button"
                onClick={() => navigate("settings")}
              >
                调整提醒
              </button>
            </div>
          )}
        {hasFilters && (
          <>
            <FilterBar
              filters={filters}
              options={options}
              onChange={setFilters}
              saved={Boolean(savedView)}
              onSave={() => {
                setSavedView({ ...filters });
                writePreference(
                  `usagemesh:view:${dataset.repo}`,
                  JSON.stringify(filters),
                );
              }}
              onRestore={() => {
                if (savedView) setFilters({ ...savedView });
              }}
              onDelete={() => {
                setSavedView(null);
                writePreference(`usagemesh:view:${dataset.repo}`, "null");
              }}
            />
            <div className="scope-line">
              <span>
                {TIME_LABELS[filters.timeRange]}
                <span className="footer-dot">·</span>
                {number(records.length)} 个聚合桶
                <span className="footer-dot">·</span>
                {new Set(records.map((row) => row.deviceId)).size} 台设备
              </span>
              <span>
                {checkedAt
                  ? `成功检查于 ${new Date(checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                  : ""}
              </span>
            </div>
            {filters.timeRange !== "all" &&
              records.some((row) => !row.timestampMs) && (
                <p className="notice">
                  部分旧账本只有日期，暂按设备记录的日期筛选；升级设备端并同步后可精确到分钟。
                </p>
              )}
          </>
        )}
        {!dataset.records.length &&
        dataset.devices.length === 0 &&
        hasFilters ? (
          <EmptyState
            title="工作区已就绪，等待第一台设备"
            description="接入设备并完成首次同步，真实用量会在这里出现。"
            action={
              <button
                className="button primary"
                onClick={() => setConnectOpen(true)}
              >
                <Plus size={16} />
                接入新设备
              </button>
            }
          />
        ) : (
          <Suspense
            fallback={
              <div className="loading-view" role="status">
                正在加载页面…
              </div>
            }
          >
            {activeTab === "overview" && (
              <Overview
                records={records}
                onNavigate={navigate}
                monthlyCost={month.cost}
                budget={preferences.monthlyBudget}
                lowerBound={month.lowerBound}
              />
            )}
            {activeTab === "analytics" && (
              <Analytics records={records} requests={requests} />
            )}
            {activeTab === "aggregated" && <UsageTable rows={records} />}
            {activeTab === "devices" && (
              <Devices
                dataset={dataset}
                onConnect={() => setConnectOpen(true)}
                onInspect={(device) => {
                  setFilters({ ...DEFAULT_FILTERS, device });
                  navigate("analytics");
                }}
              />
            )}
            {activeTab === "settings" && (
              <Settings
                preferences={preferences}
                onChange={(value: Preferences) => setPreferences(value)}
                dataset={dataset}
                checkedAt={checkedAt}
                monthlyCost={month.cost}
              />
            )}
          </Suspense>
        )}
        {connectOpen && <ConnectDevice onClose={() => setConnectOpen(false)} />}
      </main>
    </WorkspaceShell>
  );
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="loading-screen" role="alert">
        <AlertCircle size={24} />
        <h1>页面暂时无法显示</h1>
        <p>刷新页面以重新加载工作区。</p>
        <button className="button primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
