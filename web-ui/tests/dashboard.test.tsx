import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboard } from "../src/hooks/useDashboard";
import { dataset } from "./fixtures";
import * as data from "../src/lib/data";
import * as session from "../src/lib/session";

vi.mock("../src/lib/data", () => ({
  repoFromLocation: () => "test/repo",
  createDashboardLoadCache: () => ({ ledgers: new Map() }),
  workspaceKey: vi.fn(),
  WorkspacePasswordError: class extends Error {
    constructor() {
      super("Dashboard 密码不正确");
    }
  },
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
  vi.resetAllMocks();
  vi.mocked(session.restoreDashboardSession).mockResolvedValue(null);
  vi.mocked(session.rememberDashboardSession).mockResolvedValue();
  vi.mocked(session.forgetDashboardSession).mockResolvedValue();
  vi.mocked(session.dashboardSessionExpired).mockReturnValue(false);
  vi.mocked(data.workspaceKey).mockResolvedValue("fixture-key");
  vi.mocked(data.loadDashboardWithKey).mockResolvedValue(dataset());
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
  const first = vi.mocked(data.loadDashboardWithKey).mock.calls.at(-1)?.[2];
  act(() => result.current.lock());
  await act(() => result.current.unlock("second"));
  const second = vi.mocked(data.loadDashboardWithKey).mock.calls.at(-1)?.[2];
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(second).not.toBe(first);
});

describe("认证成功与首次账本读取独立", () => {
  it("密码已验证后读取超时保留密钥，重试不再认证也不重复保存会话", async () => {
    vi.mocked(data.loadDashboardWithKey).mockRejectedValueOnce(
      new Error("数据读取超时"),
    );
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    let authenticated = false;
    await act(async () => {
      authenticated = await result.current.unlock("test");
    });
    expect(authenticated).toBe(true);
    expect(result.current.verified).toBe(true);
    expect(result.current.dataset).toBeNull();
    expect(result.current.passwordInvalid).toBe(false);
    expect(result.current.error).toBe("数据读取超时");
    expect(result.current.syncStatus).toBe("error");
    const previousCache = vi.mocked(data.loadDashboardWithKey).mock.calls[0][2];
    await act(() => result.current.refresh());
    expect(result.current.dataset).not.toBeNull();
    expect(result.current.error).toBeNull();
    expect(data.workspaceKey).toHaveBeenCalledTimes(1);
    expect(session.rememberDashboardSession).toHaveBeenCalledTimes(1);
    expect(data.loadDashboardWithKey).toHaveBeenLastCalledWith(
      "test/repo",
      "fixture-key",
      previousCache,
    );
  });

  it("已恢复的加密会话遇到网络失败时可直接重试", async () => {
    vi.mocked(session.restoreDashboardSession).mockResolvedValue(
      "restored-key",
    );
    vi.mocked(data.loadDashboardWithKey).mockRejectedValueOnce(
      new Error("网络读取失败"),
    );
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.syncStatus).toBe("error"));
    expect(result.current.checking).toBe(false);
    expect(result.current.verified).toBe(true);
    expect(result.current.passwordInvalid).toBe(false);
    expect(result.current.error).toBe("网络读取失败");
    await act(() => result.current.refresh());
    expect(result.current.dataset).not.toBeNull();
    expect(data.workspaceKey).not.toHaveBeenCalled();
    expect(session.rememberDashboardSession).not.toHaveBeenCalled();
    expect(data.loadDashboardWithKey).toHaveBeenLastCalledWith(
      "test/repo",
      "restored-key",
      expect.anything(),
    );
  });

  it.each([
    ["密码错误", () => new data.WorkspacePasswordError(), true],
    ["访问配置超时", () => new Error("数据读取超时"), false],
  ] as const)(
    "%s 与密码字段状态一致，未验证时不能重试账本",
    async (_, failure, invalid) => {
      vi.mocked(data.workspaceKey).mockRejectedValueOnce(failure());
      const { result } = renderHook(() => useDashboard(0));
      await waitFor(() => expect(result.current.checking).toBe(false));
      let authenticated = true;
      await act(async () => {
        authenticated = await result.current.unlock("test");
      });
      expect(authenticated).toBe(false);
      expect(result.current.verified).toBe(false);
      expect(result.current.passwordInvalid).toBe(invalid);
      expect(session.rememberDashboardSession).not.toHaveBeenCalled();
      await act(() => result.current.refresh());
      expect(data.loadDashboardWithKey).not.toHaveBeenCalled();
      await act(() => result.current.unlock("correct"));
      expect(result.current.passwordInvalid).toBe(false);
      expect(result.current.verified).toBe(true);
    },
  );

  it("加密会话存储不可用时仍可在本标签页解锁及重试", async () => {
    vi.mocked(session.rememberDashboardSession).mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    vi.mocked(data.loadDashboardWithKey).mockRejectedValueOnce(
      new Error("网络读取失败"),
    );
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    await act(() => result.current.unlock("test"));
    expect(result.current.verified).toBe(true);
    expect(result.current.sessionNotice).toContain("无法保存加密会话");
    await act(() => result.current.refresh());
    expect(result.current.dataset).not.toBeNull();
  });

  it("认证阶段防止重复提交，锁定后晚到认证不能保存或读取", async () => {
    let resolve!: (value: string) => void;
    vi.mocked(data.workspaceKey).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.unlock("test");
    });
    let second = true;
    await act(async () => {
      second = await result.current.unlock("duplicate");
    });
    expect(second).toBe(false);
    expect(data.workspaceKey).toHaveBeenCalledTimes(1);
    act(() => result.current.lock());
    let authenticated = true;
    await act(async () => {
      resolve("late-key");
      authenticated = await pending;
    });
    expect(authenticated).toBe(false);
    expect(result.current.verified).toBe(false);
    expect(session.rememberDashboardSession).not.toHaveBeenCalled();
    expect(data.loadDashboardWithKey).not.toHaveBeenCalled();
  });

  it("锁定后晚到首次账本不能重新打开工作区", async () => {
    let resolve!: (value: ReturnType<typeof dataset>) => void;
    vi.mocked(data.loadDashboardWithKey).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.unlock("test");
    });
    await waitFor(() =>
      expect(data.loadDashboardWithKey).toHaveBeenCalledOnce(),
    );
    expect(result.current.verified).toBe(true);
    act(() => result.current.lock());
    let authenticated = true;
    await act(async () => {
      resolve(dataset());
      authenticated = await pending;
    });
    expect(authenticated).toBe(false);
    expect(result.current.verified).toBe(false);
    expect(result.current.dataset).toBeNull();
  });

  it("锁定排在待完成的加密会话保存之后，晚保存无法恢复会话", async () => {
    const calls: string[] = [];
    let finishSave!: () => void;
    vi.mocked(session.rememberDashboardSession).mockImplementation(async () => {
      calls.push("save-start");
      await new Promise<void>((done) => {
        finishSave = done;
      });
      calls.push("save-finish");
    });
    vi.mocked(session.forgetDashboardSession).mockImplementation(async () => {
      calls.push("forget");
    });
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.unlock("test");
    });
    await waitFor(() => expect(calls).toEqual(["save-start"]));
    act(() => result.current.lock());
    await act(async () => {
      finishSave();
      await pending;
    });
    expect(calls).toEqual(["save-start", "save-finish", "forget"]);
    expect(result.current.verified).toBe(false);
    expect(data.loadDashboardWithKey).not.toHaveBeenCalled();
  });

  it("恢复会话途中锁定后，晚到密钥不会恢复状态", async () => {
    let resolve!: (value: string) => void;
    vi.mocked(session.restoreDashboardSession).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result } = renderHook(() => useDashboard(0));
    let accepted = true;
    await act(async () => {
      accepted = await result.current.unlock("duplicate");
    });
    expect(accepted).toBe(false);
    expect(data.workspaceKey).not.toHaveBeenCalled();
    act(() => result.current.lock());
    await act(async () => {
      resolve("late-key");
    });
    expect(result.current.checking).toBe(false);
    expect(result.current.verified).toBe(false);
    expect(data.loadDashboardWithKey).not.toHaveBeenCalled();
  });

  it("待重试的已验证密钥也会在30分钟无操作后锁定", async () => {
    vi.mocked(data.loadDashboardWithKey).mockRejectedValueOnce(
      new Error("数据读取超时"),
    );
    const { result } = renderHook(() => useDashboard(0));
    await waitFor(() => expect(result.current.checking).toBe(false));
    vi.useFakeTimers();
    await act(() => result.current.unlock("test"));
    expect(result.current.verified).toBe(true);
    expect(result.current.dataset).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    expect(result.current.verified).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.sessionNotice).toContain("已锁定");
    await act(() => result.current.refresh());
    expect(data.loadDashboardWithKey).toHaveBeenCalledTimes(1);
    expect(session.forgetDashboardSession).toHaveBeenCalledOnce();
  });
});
