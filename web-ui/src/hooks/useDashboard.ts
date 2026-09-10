import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDashboardLoadCache,
  loadDashboardWithKey,
  repoFromLocation,
  workspaceKey,
  WorkspacePasswordError,
} from "../lib/data";
import {
  dashboardSessionExpired,
  forgetDashboardSession,
  rememberDashboardSession,
  restoreDashboardSession,
  touchDashboardSession,
} from "../lib/session";
import type { DashboardDataset, SyncStatus } from "../lib/types";

export function useDashboard(refreshSeconds: number) {
  const [dataset, setDataset] = useState<DashboardDataset | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("synced");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [passwordInvalid, setPasswordInvalid] = useState(false);
  const key = useRef("");
  const cache = useRef(createDashboardLoadCache());
  const generation = useRef(0);
  const busy = useRef(false);
  // Serialize persistence so a pending save cannot undo a subsequent lock.
  const sessionWrite = useRef<Promise<void>>(Promise.resolve());
  const sessionTimes = useRef({ created: Date.now(), active: Date.now() });

  const publish = useCallback((next: DashboardDataset) => {
    setDataset(next);
    setError(null);
    setCheckedAt(Date.now());
    setSyncStatus(next.warnings.length ? "partial" : "synced");
  }, []);
  const lock = useCallback(() => {
    generation.current += 1;
    key.current = "";
    cache.current = createDashboardLoadCache();
    busy.current = false;
    setDataset(null);
    setError(null);
    setVerified(false);
    setPasswordInvalid(false);
    setChecking(false);
    setCheckedAt(null);
    setSyncStatus("synced");
    setSessionNotice("工作区已锁定，请重新输入密码。");
    sessionWrite.current = sessionWrite.current
      .catch(() => undefined)
      .then(() => forgetDashboardSession())
      .catch(() => undefined);
  }, []);
  const refresh = useCallback(async () => {
    if (!key.current || busy.current) return;
    const run = generation.current;
    busy.current = true;
    setSyncStatus("syncing");
    try {
      const next = await loadDashboardWithKey(
        repoFromLocation(),
        key.current,
        cache.current,
      );
      if (run === generation.current) publish(next);
    } catch (error) {
      if (run === generation.current) {
        setSyncStatus("error");
        setError(error instanceof Error ? error.message : "暂时无法读取数据");
      }
    } finally {
      if (run === generation.current) busy.current = false;
    }
  }, [publish]);
  useEffect(() => {
    const run = ++generation.current;
    busy.current = true;
    void (async () => {
      try {
        const restored = await restoreDashboardSession(repoFromLocation());
        if (!restored || run !== generation.current) return;
        key.current = restored;
        setVerified(true);
        setPasswordInvalid(false);
        setChecking(false);
        setSyncStatus("syncing");
        sessionTimes.current = { created: Date.now(), active: Date.now() };
        const next = await loadDashboardWithKey(
          repoFromLocation(),
          restored,
          cache.current,
        );
        if (run === generation.current) publish(next);
      } catch (error) {
        if (run === generation.current) {
          setSyncStatus("error");
          setError(
            key.current
              ? error instanceof Error
                ? error.message
                : "暂时无法读取数据，请重试。"
              : "暂时无法恢复加密会话，请重新输入密码。",
          );
        }
      } finally {
        if (run === generation.current) {
          busy.current = false;
          setChecking(false);
        }
      }
    })();
    return () => {
      generation.current += 1;
      key.current = "";
      busy.current = false;
      cache.current = createDashboardLoadCache();
    };
  }, [publish]);

  const unlock = async (password: string): Promise<boolean> => {
    if (busy.current) return false;
    const run = ++generation.current;
    busy.current = true;
    key.current = "";
    setVerified(false);
    setPasswordInvalid(false);
    setError(null);
    setSyncStatus("syncing");
    setSessionNotice(null);
    cache.current = createDashboardLoadCache();
    try {
      const authenticatedKey = await workspaceKey(repoFromLocation(), password);
      if (run !== generation.current) return false;
      key.current = authenticatedKey;
      setVerified(true);
      sessionTimes.current = { created: Date.now(), active: Date.now() };
      try {
        const save = sessionWrite.current
          .catch(() => undefined)
          .then(async () => {
            if (run === generation.current)
              await rememberDashboardSession(
                repoFromLocation(),
                authenticatedKey,
              );
          });
        sessionWrite.current = save;
        await save;
      } catch {
        if (run === generation.current)
          setSessionNotice("当前浏览器无法保存加密会话，刷新后需要重新解锁。");
      }
      if (run !== generation.current) return false;
      const next = await loadDashboardWithKey(
        repoFromLocation(),
        authenticatedKey,
        cache.current,
      );
      if (run !== generation.current) return false;
      publish(next);
      return true;
    } catch (error) {
      if (run === generation.current) {
        setPasswordInvalid(
          !key.current && error instanceof WorkspacePasswordError,
        );
        setSyncStatus("error");
        setError(error instanceof Error ? error.message : "工作区解锁失败");
        return Boolean(key.current);
      }
      return false;
    } finally {
      if (run === generation.current) busy.current = false;
    }
  };

  useEffect(() => {
    if (!verified) return;
    const expired = () =>
      dashboardSessionExpired() ||
      Date.now() - sessionTimes.current.created >= 12 * 60 * 60_000 ||
      Date.now() - sessionTimes.current.active >= 30 * 60_000;
    const activity = () => {
      if (expired()) {
        lock();
        return;
      }
      sessionTimes.current.active = Date.now();
      touchDashboardSession();
    };
    const visible = () => {
      if (document.visibilityState === "visible") {
        if (expired()) lock();
        else if (refreshSeconds) void refresh();
      }
    };
    const events = ["pointerdown", "keydown", "focus"] as const;
    events.forEach((event) =>
      window.addEventListener(event, activity, { passive: true }),
    );
    document.addEventListener("visibilitychange", visible);
    const expiryTimer = window.setInterval(() => {
      if (expired()) lock();
    }, 15_000);
    const pollTimer = refreshSeconds
      ? window.setInterval(() => {
          if (document.visibilityState !== "hidden") {
            if (expired()) lock();
            else void refresh();
          }
        }, refreshSeconds * 1000)
      : undefined;
    return () => {
      events.forEach((event) => window.removeEventListener(event, activity));
      document.removeEventListener("visibilitychange", visible);
      clearInterval(expiryTimer);
      clearInterval(pollTimer);
    };
  }, [verified, refresh, refreshSeconds, lock]);
  return {
    dataset,
    checking,
    error,
    syncStatus,
    checkedAt,
    sessionNotice,
    verified,
    passwordInvalid,
    unlock,
    refresh,
    lock,
  };
}
