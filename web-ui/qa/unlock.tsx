import React from "react";
import { createRoot } from "react-dom/client";
import { UnlockScreen } from "../src/components/UnlockScreen";
import { useDashboard } from "../src/hooks/useDashboard";
import {
  unlockFixture,
  UNLOCK_QA_REPO,
  type UnlockScenario,
} from "./unlockFixture";
import "../src/index.css";
export function UnlockQA() {
  const dashboard = useDashboard(0);
  return (
    <>
      <p role="note" style={{ padding: "12px 24px", margin: 0 }}>
        QA · 模拟网络故障 · 演示密码 demo · 不连接真实工作区。
      </p>
      {dashboard.checking ? (
        <p role="status">正在检查演示会话…</p>
      ) : dashboard.dataset ? (
        <main style={{ padding: 32 }}>
          <h1>工作区已解锁</h1>
          <p>
            {dashboard.dataset.devices.length} 台演示设备 ·{" "}
            {dashboard.dataset.records.length} 条用量记录
          </p>
          <button className="button" onClick={dashboard.lock}>
            锁定演示工作区
          </button>
        </main>
      ) : (
        <UnlockScreen
          onUnlock={dashboard.unlock}
          error={dashboard.error}
          notice={dashboard.sessionNotice}
          verified={dashboard.verified}
          passwordInvalid={dashboard.passwordInvalid}
          loading={dashboard.syncStatus === "syncing"}
          onRetry={dashboard.refresh}
          onReset={dashboard.lock}
        />
      )}
    </>
  );
}
const root = document.getElementById("root");
if (root && import.meta.env.DEV) {
  const params = new URLSearchParams(location.search);
  params.set("repo", UNLOCK_QA_REPO);
  history.replaceState(null, "", `${location.pathname}?${params}`);
  const scenario = params.get("scenario") || "data-timeout";
  if (!["access-timeout", "data-timeout", "raw-unavailable"].includes(scenario))
    throw new Error("Unknown QA scenario");
  void unlockFixture(scenario as UnlockScenario).then(({ fetcher }) => {
    window.fetch = fetcher;
    createRoot(root).render(<UnlockQA />);
  });
}
