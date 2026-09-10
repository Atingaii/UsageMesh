import React, { Profiler, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download } from "lucide-react";
import { QuotaCycles } from "../src/views/QuotaCycles";
import { subscriptionFixture } from "../tests/subscriptionFixture";
import { WorkspaceShell, NAV } from "../src/components/WorkspaceShell";
import { Overview } from "../src/views/Overview";
import { Analytics } from "../src/views/Analytics";
import { Devices } from "../src/views/Devices";
import { Settings } from "../src/views/Settings";
import { Guide } from "../src/views/Guide";
import { FilterBar } from "../src/components/FilterBar";
import { UsageTable, exportRows } from "../src/components/UsageTable";
import { ConnectDevice } from "../src/components/ConnectDevice";
import { UnlockScreen } from "../src/components/UnlockScreen";
import { DataQuality } from "../src/components/DataQuality";
import { DisclosureSection } from "../src/components/ui";
import { PeriodComparison } from "../src/components/PeriodComparison";
import {
  DEFAULT_FILTERS,
  createFilterPredicate,
  filterOptions,
  number,
  localDate,
  totals,
  TIME_LABELS,
} from "../src/lib/analytics";
import { DEFAULT_PREFERENCES, type Preferences } from "../src/lib/preferences";
import type {
  ActiveTab,
  DashboardDataset,
  FilterState,
  OfficialQuotaCycle,
  SyncStatus,
} from "../src/lib/types";
import "../src/index.css";

// This entry never loads a real workspace or persists account/preferences data.
// All quota percentages, amounts and device records below are synthetic.
export function createQADataset(
  params = new URLSearchParams(),
  now = Date.now(),
): DashboardDataset {
  const data = subscriptionFixture(now);
  const iso = (ms: number) => new Date(ms).toISOString();
  const official = data.officialQuota!;
  const weekly = official.cycles[0];
  const short: OfficialQuotaCycle = {
    ...weekly,
    id: "demo-session",
    windowName: "secondary",
    windowMinutes: 300,
    resetsAt: iso(now + 3 * 3600000),
    nominalStartAt: iso(now - 2 * 3600000),
    firstObservedAt: iso(now - 3600000),
    firstUsedPercent: 22,
    lastUsedPercent: 28,
    samples: [
      { at: iso(now - 3600000), usedPercent: 22 },
      { at: iso(now - 1800000), usedPercent: 25 },
      { at: iso(now), usedPercent: 28 },
    ],
  };
  official.cycles.push(short);
  official.latest[0].windows.push({
    name: short.windowName,
    windowMinutes: short.windowMinutes,
    resetsAt: short.resetsAt,
    usedPercent: 28,
    remainingPercent: 72,
  });
  const spark = {
    ...official.latest[0],
    limitId: "gpt-5.3-codex-spark",
    limitName: "GPT-5.3-Codex-Spark",
    windows: official.latest[0].windows.map((window) => ({
      ...window,
      usedPercent: 0,
      remainingPercent: 100,
    })),
  };
  official.latest.push(spark);
  official.cycles.push(
    ...[weekly, short].map((cycle) => ({
      ...cycle,
      id: `demo-spark-${cycle.id}`,
      limitId: spark.limitId,
      limitName: spark.limitName,
      firstUsedPercent: 0,
      lastUsedPercent: 0,
      samples: cycle.samples.map((sample) => ({ ...sample, usedPercent: 0 })),
    })),
  );

  // Keep all QA totals internally consistent instead of mixing unrelated
  // device and request defaults from the small unit-test fixture.
  data.repo = "qa/UsageMesh";
  data.records = data.records.map((row, index) => ({
    ...row,
    platform: row.deviceId === "mac" ? "macOS" : "Linux",
    architecture: row.deviceId === "mac" ? "Apple Silicon" : "x86_64",
    inputTokens: 400000 + index * 500,
    cacheReadTokens: 5800000 - index * 500,
    cacheWriteTokens: 0,
    outputTokens: 80000,
    reasoningTokens: 20000,
    storedCost: row.cost,
    updatedAt: iso(now),
  }));
  data.records.push(
    ...Array.from({ length: 56 }, (_, index) => {
      const dayOffset = 3 + Math.floor(index / 2);
      const template = data.records[index % 2];
      const timestampMs = now - dayOffset * 86400000;
      const multiplier = 1 + (dayOffset % 7) / 4;
      const cost = (index % 2 ? 1.8 : 2.4) * multiplier;
      return {
        ...template,
        id: `history-${index}`,
        date: localDate(new Date(timestampMs)),
        timestampMs,
        inputTokens: 10000 * multiplier,
        cacheReadTokens: 336000 * multiplier,
        cacheWriteTokens: 0,
        outputTokens: 3000 * multiplier,
        reasoningTokens: 1000 * multiplier,
        totalTokens: 350000 * multiplier,
        requestsCount: 6 + (dayOffset % 5),
        cost,
        storedCost: cost,
      };
    }),
  );
  if (params.get("size") === "50000") {
    const source = data.records;
    data.records = Array.from({ length: 50000 }, (_, i) => ({
      ...source[i % source.length],
      id: `large-${i}`,
    }));
  }
  data.requests = data.records.slice(0, 120).map((row, index) => ({
    ...row,
    id: `request-${index}`,
    requestCount: 1,
    reasoningEffort: index % 2 ? "high" : "medium",
    agent: index % 2 ? "review" : "implementation",
    durationMs: 1400 + index * 65,
  }));
  const total = totals(data.records);
  data.devices = data.devices.map((device, index) => {
    const usage = totals(
      data.records.filter((row) => row.deviceId === device.id),
    );
    return {
      ...device,
      platform: index ? "Linux" : "macOS",
      architecture: index ? "x86_64" : "Apple Silicon",
      totalTokens: usage.totalTokens,
      cost: usage.cost,
      requestsCount: usage.requestsCount,
      sharePercentage: total.totalTokens
        ? (usage.totalTokens / total.totalTokens) * 100
        : 0,
      presenceAt: iso(now - (index ? 6 * 60000 : 30000)),
    };
  });
  data.pricing.resolvedRows = data.records.length;
  if (params.get("state") === "history") {
    const shift = (at: string) => iso(Date.parse(at) - 7 * 86400000);
    official.cycles.push({
      ...weekly,
      id: "completed-week",
      resetsAt: shift(weekly.resetsAt),
      nominalStartAt: shift(weekly.nominalStartAt),
      firstObservedAt: shift(weekly.firstObservedAt),
      lastObservedAt: shift(weekly.lastObservedAt),
      samples: weekly.samples.map((sample) => ({
        ...sample,
        at: shift(sample.at),
      })),
      closedAt: weekly.firstObservedAt,
      closureReason: "window-changed",
    });
  }
  if (params.get("state") === "empty") {
    data.records = [];
    data.requests = [];
    data.devices = [];
    data.expectedDevices = 0;
    data.pricing.resolvedRows = 0;
    data.officialQuota = {
      version: 1,
      latest: [],
      cycles: [],
      officialUsage: [],
    };
  }
  if (params.get("state") === "stale") {
    for (const snapshot of official.latest)
      snapshot.updatedAt = iso(now - 3600000);
  }
  if (params.get("state") === "zero") {
    for (const snapshot of official.latest)
      for (const window of snapshot.windows) {
        window.usedPercent = 0;
        window.remainingPercent = 100;
      }
  }
  return data;
}

const initialTab = (params: URLSearchParams): ActiveTab => {
  const tab = location.hash.slice(1) || params.get("tab");
  return NAV.some((item) => item.id === tab)
    ? (tab as ActiveTab)
    : "quota-cycles";
};

export function WorkspaceQA({
  params = new URLSearchParams(location.search),
  dataset,
}: {
  params?: URLSearchParams;
  dataset?: DashboardDataset;
}) {
  const [data] = useState(() => dataset || createQADataset(params));
  const [active, setActive] = useState<ActiveTab>(() => initialTab(params));
  const [filters, setFilters] = useState<FilterState>({ ...DEFAULT_FILTERS });
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [locked, setLocked] = useState(params.get("tab") === "unlock");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("synced");
  const [preferences, setPreferences] = useState<Preferences>({
    ...DEFAULT_PREFERENCES,
    theme: params.has("dark") ? "dark" : "light",
    textSize: params.has("large") ? "large" : "standard",
    refreshSeconds: 0,
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches || false,
  );
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dark =
    preferences.theme === "dark" ||
    (preferences.theme === "system" && systemDark);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.textSize = preferences.textSize;
  }, [dark, preferences.textSize]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const refresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    setSyncStatus("syncing");
    refreshTimer.current = setTimeout(() => {
      setCheckedAt(Date.now());
      setSyncStatus("synced");
    }, 180);
  };
  useEffect(() => {
    if (!preferences.refreshSeconds || locked) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, preferences.refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [preferences.refreshSeconds, locked]);
  const navigate = (tab: ActiveTab) => {
    setActive(tab);
    setMobile(false);
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#${tab}`,
    );
  };
  const hasFilters = ["overview", "analytics", "aggregated"].includes(active);
  const options = useMemo(
    () => (hasFilters ? filterOptions(data.records, data.requests) : null),
    [data, hasFilters],
  );
  const predicate = useMemo(() => createFilterPredicate(filters), [filters]);
  const records = useMemo(
    () => (hasFilters ? data.records.filter(predicate) : []),
    [data, predicate, hasFilters],
  );
  const requests = useMemo(
    () => (active === "analytics" ? data.requests.filter(predicate) : []),
    [data, predicate, active],
  );
  const month = useMemo(
    () =>
      totals(
        data.records.filter(
          createFilterPredicate({
            ...DEFAULT_FILTERS,
            timeRange: "month",
          }),
        ),
      ),
    [data],
  );
  const current = NAV.find((item) => item.id === active)!;
  const banner = (
    <p className="muted small" role="note" style={{ margin: "0 0 16px" }}>
      QA · 模拟数据 · 设置仅在本页生效，刷新仅模拟检查，不连接真实工作区。
    </p>
  );
  if (locked)
    return (
      <>
        <div style={{ padding: "12px 24px 0" }}>{banner}</div>
        <UnlockScreen
          notice="模拟工作区已锁定。输入 demo 预览解锁流程。"
          error={unlockError}
          onUnlock={async (password) => {
            if (password !== "demo") {
              setUnlockError("这是模拟工作区，请输入演示密码 demo。");
              return;
            }
            setUnlockError(null);
            setLocked(false);
          }}
        />
      </>
    );
  const content = (
    <main
      id="main-content"
      className={params.has("shell") ? "main-content" : undefined}
      style={
        params.has("shell")
          ? undefined
          : { maxWidth: 1184, margin: "0 auto", padding: "28px 20px" }
      }
    >
      {banner}
      <div className="page-heading">
        <div>
          <div className="page-title">
            <h1>{current.label}</h1>
          </div>
          <p>{current.description}</p>
        </div>
        {hasFilters && active !== "aggregated" && (
          <button
            className="button"
            disabled={!records.length}
            onClick={() => exportRows(records)}
          >
            <Download size={16} />
            导出当前数据
          </button>
        )}
      </div>
      {hasFilters && (
        <>
          <FilterBar
            filters={filters}
            options={options!}
            onChange={setFilters}
            repo={data.repo}
          />
          <div className="scope-line">
            <span>
              {TIME_LABELS[filters.timeRange]} · {number(records.length)}{" "}
              个聚合桶 · {new Set(records.map((row) => row.deviceId)).size}{" "}
              台设备
            </span>
            <span role="status">
              {checkedAt
                ? `模拟检查于 ${new Date(checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                : ""}
            </span>
          </div>
        </>
      )}
      {active === "overview" && (
        <div className="view-stack">
          <Overview
            records={records}
            onNavigate={navigate}
            monthlyCost={month.cost}
            budget={preferences.monthlyBudget}
            lowerBound={month.lowerBound}
          />
          <DisclosureSection title="周期对比与数据检查">
            <PeriodComparison dataset={data} filters={filters} />
            <DataQuality dataset={data} onInspect={() => navigate("devices")} />
          </DisclosureSection>
        </div>
      )}
      {active === "analytics" && (
        <Analytics records={records} requests={requests} />
      )}
      {active === "quota-cycles" && <QuotaCycles dataset={data} />}
      {active === "aggregated" && <UsageTable rows={records} />}
      {active === "devices" && (
        <Devices
          dataset={data}
          onConnect={() => setConnectOpen(true)}
          onInspect={(device) => {
            setFilters({ ...DEFAULT_FILTERS, device });
            navigate("analytics");
          }}
        />
      )}
      {active === "settings" && (
        <Settings
          preferences={preferences}
          onChange={setPreferences}
          dataset={data}
          checkedAt={checkedAt}
          monthlyCost={month.cost}
        />
      )}
      {active === "guide" && <Guide onBack={() => navigate("overview")} />}
      {connectOpen && <ConnectDevice onClose={() => setConnectOpen(false)} />}
    </main>
  );
  return params.has("shell") ? (
    <WorkspaceShell
      activeTab={active}
      onNavigate={navigate}
      collapsed={collapsed}
      onCollapse={() => setCollapsed(!collapsed)}
      mobileOpen={mobile}
      onMobile={setMobile}
      dark={dark}
      onTheme={() =>
        setPreferences({ ...preferences, theme: dark ? "light" : "dark" })
      }
      repo={data.repo}
      status={syncStatus}
      checkedAt={checkedAt}
      deviceCount={data.devices.length}
      refreshSeconds={preferences.refreshSeconds}
      onRefresh={refresh}
      onLock={() => {
        setConnectOpen(false);
        setMobile(false);
        setLocked(true);
      }}
      onAddDevice={() => setConnectOpen(true)}
    >
      {content}
    </WorkspaceShell>
  ) : (
    content
  );
}

const params = new URLSearchParams(location.search);
const rootElement = document.getElementById("root");
if (rootElement) {
  const dataset = createQADataset(params);
  const qaRoot = import.meta.hot?.data.root || createRoot(rootElement);
  if (import.meta.hot) import.meta.hot.data.root = qaRoot;
  qaRoot.render(
    params.has("profile") ? (
      <Profiler
        id="dashboard-qa"
        onRender={(id, phase, duration) =>
          console.info(
            "[QA render]",
            JSON.stringify({
              id,
              phase,
              durationMs: Math.round(duration * 100) / 100,
              records: dataset.records.length,
            }),
          )
        }
      >
        <WorkspaceQA params={params} dataset={dataset} />
      </Profiler>
    ) : (
      <WorkspaceQA params={params} dataset={dataset} />
    ),
  );
}
