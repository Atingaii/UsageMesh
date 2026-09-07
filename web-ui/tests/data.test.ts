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
