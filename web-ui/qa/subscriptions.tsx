import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { QuotaCycles } from "../src/views/QuotaCycles";
import { subscriptionFixture } from "../tests/subscriptionFixture";
import { WorkspaceShell, NAV } from "../src/components/WorkspaceShell";
import { Overview } from "../src/views/Overview";
import { Analytics } from "../src/views/Analytics";
import type { ActiveTab } from "../src/lib/types";
import "../src/index.css";
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.documentElement.classList.add("dark");
const data = subscriptionFixture();
if (params.get("size") === "50000") {
  const source = data.records;
  data.records = Array.from({ length: 50000 }, (_, i) => ({
    ...source[i % source.length],
    id: `large-${i}`,
  }));
}
if (params.get("state") === "empty")
  data.officialQuota = {
    version: 1,
    latest: [],
    cycles: [],
    officialUsage: [],
  };
if (params.get("state") === "stale")
  data.officialQuota!.latest[0].updatedAt = new Date(
    Date.now() - 3600000,
  ).toISOString();
if (params.get("state") === "zero")
  data.officialQuota!.latest[0].windows[0].usedPercent = 0;
function QA() {
  const [active, setActive] = useState<ActiveTab>("quota-cycles");
  const [collapsed, setCollapsed] = useState(false),
    [mobile, setMobile] = useState(false),
    [dark, setDark] = useState(params.has("dark"));
  const current = NAV.find((item) => item.id === active)!;
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
      <div className="page-heading">
        <div>
          <div className="page-title">
            <h1>{current.label}</h1>
          </div>
          <p>{current.description}</p>
        </div>
      </div>
      {active === "overview" ? (
        <Overview
          records={data.records}
          onNavigate={setActive}
          monthlyCost={850}
          budget={0}
          lowerBound={false}
        />
      ) : active === "analytics" ? (
        <Analytics records={data.records} requests={data.requests} />
      ) : (
        <QuotaCycles dataset={data} />
      )}
    </main>
  );
  return params.has("shell") ? (
    <WorkspaceShell
      activeTab={active}
      onNavigate={setActive}
      collapsed={collapsed}
      onCollapse={() => setCollapsed(!collapsed)}
      mobileOpen={mobile}
      onMobile={setMobile}
      dark={dark}
      onTheme={() => {
        document.documentElement.classList.toggle("dark");
        setDark(!dark);
      }}
      repo={data.repo}
      status="synced"
      deviceCount={2}
      refreshSeconds={0}
      onRefresh={() => {}}
      onLock={() => {}}
      onAddDevice={() => {}}
    >
      {content}
    </WorkspaceShell>
  ) : (
    content
  );
}
const qaRoot =
  import.meta.hot?.data.root || createRoot(document.getElementById("root")!);
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
            records: data.records.length,
          }),
        )
      }
    >
      <QA />
    </Profiler>
  ) : (
    <QA />
  ),
);
