import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboard } from "../src/hooks/useDashboard";
import { dataset } from "./fixtures";
import * as data from "../src/lib/data";
import * as session from "../src/lib/session";

vi.mock("../src/lib/data", () => ({
  repoFromLocation: () => "test/repo",
  createDashboardLoadCache: () => ({ ledgers: new Map() }),
  unlockDashboard: vi.fn(),
  loadDashboardWithKey: vi.fn(),
}));
vi.mock("../src/lib/session", () => ({
  restoreDashboardSession: vi.fn(),
  rememberDashboardSession: vi.fn(),
  forgetDashboardSession: vi.fn(),
  touchDashboardSession: vi.fn(),
  dashboardSessionExpired: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(session.restoreDashboardSession).mockResolvedValue(null);
  vi.mocked(session.rememberDashboardSession).mockResolvedValue();
  vi.mocked(session.forgetDashboardSession).mockResolvedValue();
  vi.mocked(session.dashboardSessionExpired).mockReturnValue(false);
  vi.mocked(data.unlockDashboard).mockResolvedValue({
    dataset: dataset(),
    key: "fixture-key",
  });
});

describe("刷新和锁定并发", () => {
  it("锁定后晚到的刷新不能恢复数据", async () => {
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    await act(() => result.current.unlock("test"));
    let resolve!: (value: ReturnType<typeof dataset>) => void;
    vi.mocked(data.loadDashboardWithKey).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    act(() => result.current.lock());
    await act(async () => {
      resolve(dataset());
      await pending;
    });
    expect(result.current.dataset).toBeNull();
  });
  it("失败保留上一快照并显式显示异常，恢复后清除异常", async () => {
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    await act(() => result.current.unlock("test"));
    vi.mocked(data.loadDashboardWithKey).mockRejectedValueOnce(
      new Error("网络错误"),
    );
    await act(() => result.current.refresh());
    expect(result.current.dataset).not.toBeNull();
    expect(result.current.syncStatus).toBe("error");
    vi.mocked(data.loadDashboardWithKey).mockResolvedValueOnce(
      dataset({ warnings: ["设备失败"] }),
    );
    await act(() => result.current.refresh());
    expect(result.current.syncStatus).toBe("partial");
    expect(result.current.error).toBeNull();
  });
  it("重复点击刷新只启动一个读取", async () => {
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    await act(() => result.current.unlock("test"));
    let resolve!: (value: ReturnType<typeof dataset>) => void;
    vi.mocked(data.loadDashboardWithKey)
      .mockClear()
      .mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
    let one!: Promise<void>, two!: Promise<void>;
    act(() => {
      one = result.current.refresh();
      two = result.current.refresh();
    });
    expect(data.loadDashboardWithKey).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(dataset());
      await Promise.all([one, two]);
    });
  });
});

it("锁定再解锁使用新的内存缓存，旧请求不会写回新会话", async () => {
  const { result } = renderHook(() => useDashboard(0));
  await waitFor(() => expect(result.current.checking).toBe(false));
  await act(() => result.current.unlock("first"));
  const first = vi.mocked(data.unlockDashboard).mock.calls.at(-1)?.[1];
  act(() => result.current.lock());
  await act(() => result.current.unlock("second"));
  const second = vi.mocked(data.unlockDashboard).mock.calls.at(-1)?.[1];
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(second).not.toBe(first);
});
