import { describe, expect, it, vi } from "vitest";
import {
  dashboardSessionExpired,
  forgetDashboardSession,
  rememberDashboardSession,
  restoreDashboardSession,
} from "../src/lib/session";
const key = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url");
const storageKey = "usagemesh:dashboard-session:v2";

describe("加密浏览器会话", () => {
  it("会话不持久化明文工作区密钥，能恢复且锁定后失效", async () => {
    await rememberDashboardSession("test/repo", key);
    expect(sessionStorage.getItem(storageKey)).not.toContain(key);
    await expect(restoreDashboardSession("test/repo")).resolves.toBe(key);
    await forgetDashboardSession();
    await expect(restoreDashboardSession("test/repo")).resolves.toBeNull();
  });
  it("不能在另一个仓库恢复", async () => {
    await rememberDashboardSession("test/repo", key);
    await expect(restoreDashboardSession("other/repo")).resolves.toBeNull();
  });
  it("闲置达到30分钟失效", async () => {
    await rememberDashboardSession("test/repo", key);
    const session = JSON.parse(sessionStorage.getItem(storageKey)!);
    vi.spyOn(Date, "now").mockReturnValue(session.lastActivityAt + 30 * 60_000);
    expect(dashboardSessionExpired()).toBe(true);
    await expect(restoreDashboardSession("test/repo")).resolves.toBeNull();
  });
  it("持续活动也不能越过12小时绝对期限", async () => {
    await rememberDashboardSession("test/repo", key);
    const session = JSON.parse(sessionStorage.getItem(storageKey)!);
    const now = session.createdAt + 12 * 60 * 60_000;
    session.lastActivityAt = now - 1000;
    sessionStorage.setItem(storageKey, JSON.stringify(session));
    vi.spyOn(Date, "now").mockReturnValue(now);
    await expect(restoreDashboardSession("test/repo")).resolves.toBeNull();
  });
  it("损坏的密文或时间不能恢复", async () => {
    await rememberDashboardSession("test/repo", key);
    const session = JSON.parse(sessionStorage.getItem(storageKey)!);
    session.ciphertext = "AAAA";
    sessionStorage.setItem(storageKey, JSON.stringify(session));
    await expect(restoreDashboardSession("test/repo")).resolves.toBeNull();
    await rememberDashboardSession("test/repo", key);
    const second = JSON.parse(sessionStorage.getItem(storageKey)!);
    delete second.createdAt;
    sessionStorage.setItem(storageKey, JSON.stringify(second));
    await expect(restoreDashboardSession("test/repo")).resolves.toBeNull();
  });
});
