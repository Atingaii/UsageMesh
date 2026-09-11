import { describe, expect, it, vi } from "vitest";
import {
  createDashboardLoadCache,
  loadDashboardWithKey,
  sanitizeOfficialQuota,
  workspaceKey,
  WorkspacePasswordError,
} from "../src/lib/data";
import { encryptedAccess, encryptedLedger } from "./fixtures";
import { subscriptionFixture } from "./subscriptionFixture";

const repo = "test/UsageMesh",
  password = "fixture-password-only";
const key = new Uint8Array(32).fill(7),
  encoded = Buffer.from(key).toString("base64url");
function githubFilePath(url: string): string {
  const address = new URL(url);
  if (address.hostname === "api.github.com") {
    const file = address.pathname.split("/contents/")[1];
    return `${address.searchParams.get("ref")}/${file}`;
  }
  return String(url).split(`${repo}/`)[1] || String(url);
}
function fetchResponses(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const file = githubFilePath(String(url));
      const path =
        String(url).startsWith("https://api.github.com/") &&
        `api:${file}` in responses
          ? `api:${file}`
          : file;
      const value = responses[path];
      if (value instanceof Error || value instanceof DOMException) throw value;
      if (value instanceof Response) return value.clone();
      return new Response(JSON.stringify(responses[path] ?? {}), {
        status: path in responses ? 200 : 404,
      });
    }),
  );
}
describe("现有工作区与加密兼容", () => {
  it.each([310_000, 600_000])(
    "接受原有 PBKDF2 %i 次参数",
    async (iterations) => {
      fetchResponses({
        "um-dashboard/access.json": await encryptedAccess(
          repo,
          password,
          key,
          iterations,
        ),
      });
      await expect(workspaceKey(repo, password)).resolves.toBe(encoded);
      await expect(workspaceKey(repo, "wrong")).rejects.toThrow("密码不正确");
    },
  );
  it("拒绝无效KDF参数，网络异常不是密码错误", async () => {
    const access = await encryptedAccess(repo, password, key);
    fetchResponses({
      "um-dashboard/access.json": { ...access, iterations: 99_999 },
    });
    await expect(workspaceKey(repo, password)).rejects.toThrow("KDF");
    fetchResponses({});
    await expect(workspaceKey(repo, password)).rejects.toThrow("数据读取失败");
  });
  it("费用不在浏览器重算，部分失败可见，请求不额外截断", async () => {
    const ledger = await encryptedLedger("aabb", key, {
      schemaVersion: 2,
      generatedAt: "2026-09-07T02:00:00Z",
      device: { id: "one", name: "Mac", platform: "macos", arch: "aarch64" },
      rows: [
        {
          date: "2026-09-07",
          input: 100,
          cacheRead: 200,
          model: "gpt-test",
          costUsd: 12.345,
          costLowerBound: true,
        },
      ],
      requests: Array.from({ length: 5100 }, (_, index) => ({
        timestampMs: Date.now() + index,
        input: 1,
        costUsd: 0.25,
      })),
    });
    fetchResponses({
      "um-index/index.json": { branches: ["um-ledger-aabb", "um-ledger-ccdd"] },
      "um-ledger-aabb/ledger.json": ledger,
    });
    const data = await loadDashboardWithKey(repo, encoded);
    expect(data.expectedDevices).toBe(2);
    expect(data.devices).toHaveLength(1);
    expect(data.warnings[0]).toContain("um-ledger-ccdd");
    expect(data.records[0].cost).toBe(12.345);
    expect(data.pricing.fallbackRows).toBe(1);
    expect(data.requests).toHaveLength(5100);
    expect(data.requests[0].reasoningEffort).toBe("");
  });
  it("拒绝device hash与分支不匹配的账本", async () => {
    fetchResponses({
      "um-index/index.json": { branches: ["um-ledger-ccdd"] },
      "um-ledger-ccdd/ledger.json": await encryptedLedger("aabb", key, {}),
    });
    await expect(loadDashboardWithKey(repo, encoded)).rejects.toThrow(
      "格式不受支持",
    );
  });
  it("空设备索引显示真实空工作区", async () => {
    fetchResponses({ "um-index/index.json": { branches: [] } });
    const data = await loadDashboardWithKey(repo, encoded);
    expect(data.devices).toHaveLength(0);
    expect(data.warnings).toHaveLength(0);
  });
});

describe("官方额度暂时读取失败", () => {
  const observedAt = "2026-09-11T04:00:00.000Z";

  it("合法 stale 保留原额度和历史，未知状态不能冒充官方观测", () => {
    const quota = subscriptionFixture(Date.parse(observedAt)).officialQuota!;
    const snapshot = quota.latest[0];
    const stale = { ...snapshot, status: "stale" };
    const cleaned = sanitizeOfficialQuota({
      ...quota,
      latest: [
        stale,
        ...["unavailable", "fresh", "inferred", "", null].map((status) => ({
          ...snapshot,
          status,
        })),
      ],
    })!;
    expect(cleaned.latest).toEqual([stale]);
    expect(cleaned.latest[0].updatedAt).toBe(observedAt);
    expect(cleaned.latest[0].windows).toEqual(snapshot.windows);
    expect(cleaned.cycles).toEqual(quota.cycles);
  });

  it("加密账本成功读取的 fresh → stale → 新鲜快照完整保留并恢复", async () => {
    const quota = subscriptionFixture(Date.parse(observedAt)).officialQuota!;
    const snapshot = quota.latest[0];
    const cache = createDashboardLoadCache();
    const responses: Record<string, unknown> = {
      "um-index/index.json": { branches: ["um-ledger-aabb"] },
    };
    fetchResponses(responses);
    async function publish(
      status: "observed" | "stale",
      generatedAt: string,
      updatedAt = observedAt,
      usedPercent = 57,
    ) {
      responses["um-ledger-aabb/ledger.json"] = await encryptedLedger(
        "aabb",
        key,
        {
          generatedAt,
          device: { id: "official-device", name: "Official device" },
          rows: [{ date: "2026-09-11", costUsd: 7 }],
          officialQuota: {
            ...quota,
            latest: [
              {
                ...snapshot,
                status,
                updatedAt,
                windows: [
                  {
                    ...snapshot.windows[0],
                    usedPercent,
                    remainingPercent: 100 - usedPercent,
                  },
                ],
              },
            ],
          },
        },
      );
      return loadDashboardWithKey(repo, encoded, cache);
    }

    const fresh = await publish("observed", observedAt);
    expect(fresh.officialQuota!.latest[0].status).toBe("observed");
    const stale = await publish("stale", "2026-09-11T04:02:00.000Z");
    expect(stale.officialQuota!.latest).toEqual([
      { ...fresh.officialQuota!.latest[0], status: "stale" },
    ]);
    expect(stale.officialQuota!.cycles).toEqual(fresh.officialQuota!.cycles);
    expect(stale.lastSync).toBe("2026-09-11T04:02:00.000Z");
    expect(stale.records[0].cost).toBe(7);
    expect(stale.retainedDeviceIds).toBeUndefined();
    expect(stale.warnings).toEqual([]);

    const nextAt = "2026-09-11T04:04:00.000Z";
    const recovered = await publish("observed", nextAt, nextAt, 60);
    expect(recovered.officialQuota!.latest[0]).toMatchObject({
      status: "observed",
      updatedAt: nextAt,
      windows: [
        {
          usedPercent: 60,
          remainingPercent: 40,
          resetsAt: snapshot.windows[0].resetsAt,
        },
      ],
    });
    expect(recovered.officialQuota!.cycles).toEqual(
      fresh.officialQuota!.cycles,
    );
  });
});

describe("GitHub 官方备用读取", () => {
  it("正常读取不调用 API，错误密码仍由解密结果识别", async () => {
    fetchResponses({
      "um-dashboard/access.json": await encryptedAccess(
        repo,
        password,
        key,
        100_000,
      ),
    });
    await expect(workspaceKey(repo, password)).resolves.toBe(encoded);
    await expect(workspaceKey(repo, "incorrect")).rejects.toBeInstanceOf(
      WorkspacePasswordError,
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([url]) =>
          String(url).startsWith("https://raw.githubusercontent.com/"),
        ),
    ).toBe(true);
  });

  it.each([
    new TypeError("Failed to fetch"),
    new DOMException("interrupted", "TimeoutError"),
    new Response("", { status: 408 }),
    new Response("", { status: 429 }),
    new Response("", { status: 503 }),
  ])("RAW 暂时失败时，从同一仓库分支的官方 API 解锁", async (failure) => {
    fetchResponses({
      "um-dashboard/access.json": failure,
      "api:um-dashboard/access.json": await encryptedAccess(
        repo,
        password,
        key,
        100_000,
      ),
    });
    await expect(workspaceKey(repo, password)).resolves.toBe(encoded);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith(
      `https://api.github.com/repos/${repo}/contents/access.json?ref=um-dashboard`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/vnd.github.raw+json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([401, 403, 404])(
    "RAW HTTP %i 不访问其他端点掩盖错误",
    async (status) => {
      fetchResponses({
        "um-dashboard/access.json": new Response("", { status }),
      });
      await expect(workspaceKey(repo, password)).rejects.toThrow(`(${status})`);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new Response("{invalid"), { kind: "unsupported" }])(
    "RAW 内容损坏不进入备用读取，也不报告密码错误",
    async (invalid) => {
      fetchResponses({ "um-dashboard/access.json": invalid });
      await expect(workspaceKey(repo, password)).rejects.not.toBeInstanceOf(
        WorkspacePasswordError,
      );
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    },
  );

  it("索引、账本和心跳都能从备用端点读取，并保留加密账本校验", async () => {
    const envelope = await encryptedLedger("aabb", key, {
      generatedAt: "2026-09-10T12:00:00Z",
      device: { id: "aabb", name: "Mac" },
      rows: [{ costUsd: 12 }],
    });
    const responses = {
      "um-index/index.json": new TypeError("Failed to fetch"),
      "api:um-index/index.json": { branches: ["um-ledger-aabb"] },
      "um-ledger-aabb/ledger.json": new TypeError("Failed to fetch"),
      "api:um-ledger-aabb/ledger.json": envelope,
      "um-presence-aabb/presence.json": new TypeError("Failed to fetch"),
      "api:um-presence-aabb/presence.json": {
        kind: "usagemesh-device-presence",
        schemaVersion: 1,
        deviceHash: "aabb",
        updatedAt: "2026-09-10T12:01:00Z",
      },
    };
    fetchResponses(responses);
    const result = await loadDashboardWithKey(repo, encoded);
    expect(result.records[0].cost).toBe(12);
    expect(result.devices[0].presenceAt).toBe("2026-09-10T12:01:00Z");
    expect(result.warnings).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
    responses["api:um-ledger-aabb/ledger.json"] = {
      ...envelope,
      deviceHash: "ccdd",
    };
    await expect(loadDashboardWithKey(repo, encoded)).rejects.toThrow(
      "格式不受支持",
    );
  });

  it("两个端点均无响应时，8 秒后切换，合计 20 秒结束且不会无限重试", async () => {
    vi.useFakeTimers();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("timed out", "TimeoutError")),
          delay,
        );
        return controller.signal;
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(init!.signal!.reason),
              { once: true },
            );
          }),
      ),
    );
    let finished = false;
    const outcome = workspaceKey(repo, password).catch((error: unknown) => {
      finished = true;
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(7_999);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(11_999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ message: "数据读取超时" });
      expect(timeout.mock.calls.map(([delay]) => delay)).toEqual([
        8_000, 12_000,
      ]);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("索引网络失败不误报尚未同步，确认缺失仍保留接入提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(loadDashboardWithKey(repo, encoded)).rejects.toThrow(
      "工作区索引读取失败：网络读取失败，请检查网络后重试",
    );
    fetchResponses({});
    await expect(loadDashboardWithKey(repo, encoded)).rejects.toThrow(
      "暂无设备索引",
    );
  });
});

describe("暂时读取失败保留上次成功快照", () => {
  const generatedAt = "2026-09-10T12:00:00Z";
  const presenceAt = "2026-09-10T12:01:00Z";
  async function cachedWorkspace() {
    const cache = createDashboardLoadCache();
    const envelope = await encryptedLedger("aabb", key, {
      generatedAt,
      device: { id: "official-device", name: "Official device" },
      rows: [{ date: "2026-09-10", costUsd: 4 }],
      requests: [{ timestampMs: Date.parse(generatedAt), costUsd: 4 }],
      officialQuota: subscriptionFixture(Date.parse(generatedAt)).officialQuota,
    });
    const responses: Record<string, unknown> = {
      "um-index/index.json": { branches: ["um-ledger-aabb"] },
      "um-ledger-aabb/ledger.json": envelope,
      "um-presence-aabb/presence.json": {
        kind: "usagemesh-device-presence",
        schemaVersion: 1,
        deviceHash: "aabb",
        updatedAt: presenceAt,
      },
    };
    fetchResponses(responses);
    const first = await loadDashboardWithKey(repo, encoded, cache);
    return { cache, envelope, responses, first };
  }

  it("失败保留金额、官方窗口和原心跳，连续失败可重试且恢复后清除旧快照标记", async () => {
    const { cache, responses, first } = await cachedWorkspace();
    responses["um-ledger-aabb/ledger.json"] = new TypeError("Failed to fetch");
    responses["um-presence-aabb/presence.json"] = {
      ...(responses["um-presence-aabb/presence.json"] as object),
      updatedAt: "2026-09-10T12:05:00Z",
    };
    const failed = await loadDashboardWithKey(repo, encoded, cache);
    expect(failed.devices).toHaveLength(1);
    expect(failed.expectedDevices).toBe(1);
    expect(failed.records).toBe(first.records);
    expect(failed.requests).toBe(first.requests);
    expect(failed.officialQuota).toBe(first.officialQuota);
    expect(failed.officialQuota!.latest).not.toHaveLength(0);
    expect(failed.retainedDeviceIds).toEqual(["official-device"]);
    expect(failed.devices[0].lastSync).toBe(generatedAt);
    expect(failed.devices[0].presenceAt).toBe(presenceAt);
    expect(failed.lastSync).toBe(generatedAt);
    expect(failed.warnings).toEqual([
      expect.stringContaining("正在沿用上次成功快照"),
    ]);
    expect(failed.warnings[0]).toContain(generatedAt);
    const failedAgain = await loadDashboardWithKey(repo, encoded, cache);
    expect(failedAgain.records).toBe(first.records);
    expect(failedAgain.devices[0].presenceAt).toBe(presenceAt);
    responses["um-ledger-aabb/ledger.json"] = await encryptedLedger(
      "aabb",
      key,
      {
        generatedAt: "2026-09-10T12:04:00Z",
        device: { id: "official-device", name: "Official device" },
        rows: [{ date: "2026-09-10", costUsd: 7 }],
        officialQuota: subscriptionFixture(Date.parse("2026-09-10T12:04:00Z"))
          .officialQuota,
      },
    );
    const recovered = await loadDashboardWithKey(repo, encoded, cache);
    expect(recovered.records[0].cost).toBe(7);
    expect(recovered.devices[0].lastSync).toBe("2026-09-10T12:04:00Z");
    expect(recovered.devices[0].presenceAt).toBe("2026-09-10T12:05:00Z");
    expect(recovered.retainedDeviceIds).toBeUndefined();
    expect(recovered.warnings).toEqual([]);
  });

  it("独立保留失败设备，成功设备继续更新，从未读取的设备仍缺失", async () => {
    const { cache, responses } = await cachedWorkspace();
    responses["um-index/index.json"] = {
      branches: ["um-ledger-aabb", "um-ledger-ccdd", "um-ledger-eeff"],
    };
    responses["um-ledger-aabb/ledger.json"] = new Response("", { status: 503 });
    responses["um-ledger-ccdd/ledger.json"] = await encryptedLedger(
      "ccdd",
      key,
      {
        generatedAt: "2026-09-10T12:05:00Z",
        device: { id: "fresh-device" },
        rows: [{ date: "2026-09-10", costUsd: 3 }],
      },
    );
    responses["um-ledger-eeff/ledger.json"] = new Response("", { status: 503 });
    const result = await loadDashboardWithKey(repo, encoded, cache);
    expect(result.devices).toHaveLength(2);
    expect(result.expectedDevices).toBe(3);
    expect(result.records.reduce((sum, row) => sum + row.cost, 0)).toBe(7);
    expect(result.retainedDeviceIds).toEqual(["official-device"]);
    expect(result.warnings).toHaveLength(2);
    expect(
      result.warnings.find((line) => line.startsWith("um-ledger-eeff")),
    ).not.toContain("沿用");
    expect(result.lastSync).toBe("2026-09-10T12:05:00Z");
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "HTTP %i 可保留成功快照",
    async (status) => {
      const { cache, responses } = await cachedWorkspace();
      responses["um-ledger-aabb/ledger.json"] = new Response("", { status });
      const result = await loadDashboardWithKey(repo, encoded, cache);
      expect(result.retainedDeviceIds).toEqual(["official-device"]);
      expect(result.warnings[0]).toContain(`(${status})`);
    },
  );

  it.each(["TimeoutError", "AbortError"])(
    "响应体 %s 仍可保留快照",
    async (name) => {
      const { cache } = await cachedWorkspace();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (githubFilePath(String(url)).endsWith("/index.json"))
            return new Response(
              JSON.stringify({ branches: ["um-ledger-aabb"] }),
            );
          if (githubFilePath(String(url)).endsWith("/ledger.json"))
            return {
              ok: true,
              json: async () => {
                throw new DOMException("interrupted", name);
              },
            };
          return new Response("", { status: 404 });
        }),
      );
      const result = await loadDashboardWithKey(repo, encoded, cache);
      expect(result.retainedDeviceIds).toEqual(["official-device"]);
      expect(result.warnings[0]).toContain("读取超时");
    },
  );

  it.each([401, 403, 404])("HTTP %i 不沿用旧快照", async (status) => {
    const { cache, responses } = await cachedWorkspace();
    responses["um-ledger-aabb/ledger.json"] = new Response("", { status });
    await expect(loadDashboardWithKey(repo, encoded, cache)).rejects.toThrow(
      `(${status})`,
    );
  });

  it.each([401, 403, 404])(
    "RAW 暂时失败但 API 返回 HTTP %i 时，不沿用旧快照掩盖永久失败",
    async (status) => {
      const { cache, responses } = await cachedWorkspace();
      responses["um-ledger-aabb/ledger.json"] = new TypeError(
        "Failed to fetch",
      );
      responses["api:um-ledger-aabb/ledger.json"] = new Response("", {
        status,
      });
      await expect(loadDashboardWithKey(repo, encoded, cache)).rejects.toThrow(
        `(${status})`,
      );
    },
  );

  it("备用 API 的无效 JSON 不能沿用旧快照", async () => {
    const { cache, responses } = await cachedWorkspace();
    responses["um-ledger-aabb/ledger.json"] = new TypeError("Failed to fetch");
    responses["api:um-ledger-aabb/ledger.json"] = new Response("{invalid");
    await expect(loadDashboardWithKey(repo, encoded, cache)).rejects.toThrow();
  });

  it("JSON、格式、AAD 和密文校验失败不能冒充缓存成功，也不能覆盖成功源", async () => {
    const { cache, responses, envelope, first } = await cachedWorkspace();
    for (const invalid of [
      new Response("{invalid-json"),
      { ...envelope, algorithm: "unsupported" },
      { ...envelope, deviceHash: "ccdd" },
      { ...envelope, ciphertext: "broken" },
      await encryptedLedger("aabb", key, { rows: "not-an-array" }),
    ]) {
      responses["um-ledger-aabb/ledger.json"] = invalid;
      await expect(
        loadDashboardWithKey(repo, encoded, cache),
      ).rejects.toThrow();
      expect(cache.snapshot?.dataset).toBe(first);
      expect(cache.ledgers.get("um-ledger-aabb")?.envelope).toEqual(envelope);
    }
    responses["um-ledger-aabb/ledger.json"] = new TypeError("Failed to fetch");
    const retained = await loadDashboardWithKey(repo, encoded, cache);
    expect(retained.records).toBe(first.records);
    expect(retained.records[0].cost).toBe(4);
    expect(retained.retainedDeviceIds).toEqual(["official-device"]);
  });

  it("新 cache、换 key、换 repo 均不能取到旧会话快照", async () => {
    const { cache, responses } = await cachedWorkspace();
    responses["um-ledger-aabb/ledger.json"] = new TypeError("Failed to fetch");
    await expect(
      loadDashboardWithKey(repo, encoded, createDashboardLoadCache()),
    ).rejects.toThrow("网络读取失败");
    await expect(
      loadDashboardWithKey(repo, "other-key", cache),
    ).rejects.toThrow("网络读取失败");
    expect(cache.ledgers.size).toBe(0);
    expect(cache.snapshot).toBeUndefined();
    const workspace = await cachedWorkspace();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/index.json"))
          return new Response(JSON.stringify({ branches: ["um-ledger-aabb"] }));
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      loadDashboardWithKey("other/repo", encoded, workspace.cache),
    ).rejects.toThrow("网络读取失败");
    expect(workspace.cache.ledgers.size).toBe(0);
    expect(workspace.cache.snapshot).toBeUndefined();
  });

  it("切换 scope 后晚到的旧读取不能写入新 repo 的 cache", async () => {
    const { cache, envelope } = await cachedWorkspace();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let started = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const address = String(url);
        if (address.endsWith("/index.json"))
          return new Response(JSON.stringify({ branches: ["um-ledger-aabb"] }));
        if (address.includes(`${repo}/`) && address.endsWith("/ledger.json")) {
          started = true;
          return pending;
        }
        return new Response("", { status: 503 });
      }),
    );
    const original = loadDashboardWithKey(repo, encoded, cache);
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      await expect(
        loadDashboardWithKey("other/repo", encoded, cache),
      ).rejects.toThrow("503");
    } finally {
      release(new Response(JSON.stringify(envelope)));
    }
    await original;
    expect(cache.scope).toBe(`other/repo:${encoded}`);
    expect(cache.ledgers.size).toBe(0);
    expect(cache.snapshot).toBeUndefined();
  });

  it("仅解密成功但尚未构建成有效工作区的数据不能作为回退来源", async () => {
    const cache = createDashboardLoadCache();
    const responses: Record<string, unknown> = {
      "um-index/index.json": { branches: ["um-ledger-aabb"] },
      "um-ledger-aabb/ledger.json": await encryptedLedger("aabb", key, {
        device: { id: "invalid" },
        rows: "not-an-array",
      }),
    };
    fetchResponses(responses);
    await expect(loadDashboardWithKey(repo, encoded, cache)).rejects.toThrow();
    expect(cache.ledgers.size).toBe(0);
    responses["um-ledger-aabb/ledger.json"] = new TypeError("Failed to fetch");
    await expect(loadDashboardWithKey(repo, encoded, cache)).rejects.toThrow(
      "网络读取失败",
    );
    expect(cache.snapshot).toBeUndefined();
  });
});

it("路由筛选在聚合与请求中使用同一规范值", async () => {
  const row = {
    routeProvider: "MixedCase-Relay",
    routeType: "relay",
    input: 100,
    costUsd: 1,
    costLowerBound: true,
  };
  const ledger = await encryptedLedger("aabb", key, {
    device: { id: "aabb" },
    rows: [row],
    requests: [{ ...row, timestampMs: Date.now() }],
  });
  fetchResponses({
    "um-index/index.json": { branches: ["um-ledger-aabb"] },
    "um-ledger-aabb/ledger.json": ledger,
  });
  const data = await loadDashboardWithKey(repo, encoded);
  expect(data.records[0].routeProvider).toBe(data.requests[0].routeProvider);
  expect(data.devices[0].costLowerBound).toBe(true);
});

describe("会话内账本缓存", () => {
  it("相同账本只解密一次，保留用量引用并继续刷新独立心跳", async () => {
    const { createDashboardLoadCache } = await import("../src/lib/data");
    const cache = createDashboardLoadCache();
    const responses: Record<string, unknown> = {
      "um-index/index.json": { branches: ["um-ledger-aabb"] },
      "um-ledger-aabb/ledger.json": await encryptedLedger("aabb", key, {
        generatedAt: "2026-09-07T02:00:00Z",
        device: { id: "one", name: "Mac" },
        rows: [{ date: "2026-09-07", costUsd: 3 }],
        requests: [{ timestampMs: 100, costUsd: 3 }],
      }),
      "um-presence-aabb/presence.json": {
        kind: "usagemesh-device-presence",
        schemaVersion: 1,
        deviceHash: "aabb",
        updatedAt: "2026-09-07T03:00:00Z",
      },
    };
    fetchResponses(responses);
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const first = await loadDashboardWithKey(repo, encoded, cache);
    responses["um-presence-aabb/presence.json"] = {
      kind: "usagemesh-device-presence",
      schemaVersion: 1,
      deviceHash: "aabb",
      updatedAt: "2026-09-07T04:00:00Z",
    };
    const second = await loadDashboardWithKey(repo, encoded, cache);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(second.records).toBe(first.records);
    expect(second.requests).toBe(first.requests);
    expect(second.pricing).toBe(first.pricing);
    expect(second.devices[0].presenceAt).toBe("2026-09-07T04:00:00Z");
    expect(first.devices[0].presenceAt).toBe("2026-09-07T03:00:00Z");

    responses["um-ledger-aabb/ledger.json"] = await encryptedLedger(
      "aabb",
      key,
      {
        device: { id: "one", name: "Mac" },
        rows: [{ costUsd: 7 }],
      },
    );
    const updated = await loadDashboardWithKey(repo, encoded, cache);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(updated.records).not.toBe(first.records);
    expect(updated.records[0].cost).toBe(7);
  });

  it("损坏更新和错误密钥不能命中旧账本，移除的设备不留在缓存", async () => {
    const { createDashboardLoadCache } = await import("../src/lib/data");
    const cache = createDashboardLoadCache();
    const envelope = await encryptedLedger("aabb", key, {
      device: { id: "one" },
    });
    const responses: Record<string, unknown> = {
      "um-index/index.json": { branches: ["um-ledger-aabb"] },
      "um-ledger-aabb/ledger.json": envelope,
    };
    fetchResponses(responses);
    await loadDashboardWithKey(repo, encoded, cache);
    responses["um-ledger-aabb/ledger.json"] = {
      ...envelope,
      ciphertext: "broken",
    };
    await expect(loadDashboardWithKey(repo, encoded, cache)).rejects.toThrow(
      "解密失败",
    );
    responses["um-ledger-aabb/ledger.json"] = envelope;
    await expect(
      loadDashboardWithKey(
        repo,
        Buffer.from(new Uint8Array(32).fill(8)).toString("base64url"),
        cache,
      ),
    ).rejects.toThrow("解密失败");
    expect(cache.ledgers.size).toBe(0);
    await loadDashboardWithKey(repo, encoded, cache);
    responses["um-index/index.json"] = { branches: [] };
    const empty = await loadDashboardWithKey(repo, encoded, cache);
    expect(empty.records).toEqual([]);
    expect(cache.ledgers.size).toBe(0);
  });
});

describe("完整周期账本与刷新延迟", () => {
  it("周期金额使用全部聚合桶，1000条近期明细不会移除早期模型和金额", async () => {
    const { aggregateQuotaCycle, forecastCycleCost } = await import(
      "../src/lib/quotaCycles"
    );
    const from = Date.parse("2026-09-08T00:00:00Z");
    const observedAt = "2026-09-10T12:00:00Z";
    const rows = Array.from({ length: 3000 }, (_, index) => {
      const timestampMs = from + index * 60_000;
      const group = Math.floor(index / 1000);
      return {
        timestampMs,
        date: new Date(timestampMs).toISOString().slice(0, 10),
        client: "codex",
        model: ["synthetic-early", "synthetic-middle", "synthetic-recent"][
          group
        ],
        routeType: "official",
        billingChannel: "official-subscription",
        input: 100,
        costUsd: [0.7, 0.3, 0.15][group],
        messages: 1,
      };
    });
    fetchResponses({
      "um-index/index.json": { branches: ["um-ledger-aabb"] },
      "um-ledger-aabb/ledger.json": await encryptedLedger("aabb", key, {
        schemaVersion: 8,
        generatedAt: observedAt,
        device: { id: "synthetic" },
        rows,
        requests: rows.slice(-1000),
      }),
    });
    const data = await loadDashboardWithKey(repo, encoded);
    expect(data.records).toHaveLength(3000);
    expect(data.requests).toHaveLength(1000);
    expect(new Set(data.requests.map((row) => row.model))).toEqual(
      new Set(["synthetic-recent"]),
    );
    const aggregation = aggregateQuotaCycle(data.records, {
      id: "synthetic-week",
      accountKey: "synthetic",
      account: "synthetic",
      limitId: "codex",
      limitName: "Codex",
      windowName: "primary",
      windowMinutes: 10080,
      resetsAt: "2026-09-15T00:00:00Z",
      nominalStartAt: "2026-09-08T00:00:00Z",
      firstObservedAt: "2026-09-08T00:00:00Z",
      lastObservedAt: observedAt,
      firstUsedPercent: 0,
      lastUsedPercent: 79,
      samples: [],
      closedAt: null,
      closureReason: null,
      segment: 0,
    });
    expect(aggregation.rows).toHaveLength(3000);
    expect(aggregation.cost).toBeCloseTo(1150);
    expect(aggregation.models).toHaveLength(3);
    expect(data.requests.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(
      150,
    );
    const value = forecastCycleCost(
      aggregation,
      79,
      observedAt,
      data.lastSync,
      Date.parse(observedAt),
    );
    expect(value?.recorded).toBeCloseTo(1150);
    expect(value?.total).toBeCloseTo(1150 / 0.79);
  });

  it("心跳读取与账本下载并行，账本迟到不阻止心跳先完成", async () => {
    const envelope = await encryptedLedger("aabb", key, {
      generatedAt: "2026-09-10T00:00:00Z",
      device: { id: "one" },
      rows: [],
    });
    let releaseLedger!: (response: Response) => void;
    const ledgerResponse = new Promise<Response>((resolve) => {
      releaseLedger = resolve;
    });
    let presenceStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.endsWith("/index.json"))
          return new Response(JSON.stringify({ branches: ["um-ledger-aabb"] }));
        if (path.endsWith("/ledger.json")) return ledgerResponse;
        presenceStarted = true;
        return new Response(
          JSON.stringify({
            kind: "usagemesh-device-presence",
            schemaVersion: 1,
            deviceHash: "aabb",
            updatedAt: "2026-09-10T00:01:00Z",
          }),
        );
      }),
    );
    const loading = loadDashboardWithKey(repo, encoded);
    try {
      await vi.waitFor(() => expect(presenceStarted).toBe(true));
    } finally {
      releaseLedger(new Response(JSON.stringify(envelope)));
    }
    expect((await loading).devices[0].presenceAt).toBe("2026-09-10T00:01:00Z");
  });
});
