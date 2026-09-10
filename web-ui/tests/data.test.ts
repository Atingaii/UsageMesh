import { describe, expect, it, vi } from "vitest";
import { loadDashboardWithKey, workspaceKey } from "../src/lib/data";
import { encryptedAccess, encryptedLedger } from "./fixtures";

const repo = "test/UsageMesh",
  password = "fixture-password-only";
const key = new Uint8Array(32).fill(7),
  encoded = Buffer.from(key).toString("base64url");
function fetchResponses(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).split(`${repo}/`)[1] || String(url);
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
