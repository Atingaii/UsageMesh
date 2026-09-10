import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { dataset, record } from "./fixtures";
import { QuotaCycles } from "../src/views/QuotaCycles";

it("重复调整仅显示一个周期，未来重置不显示已结束，完整周期金额仍可预测", () => {
  const now = Date.now(),
    iso = (t: number) => new Date(t).toISOString();
  const base = {
    id: "qa",
    accountKey: "qa",
    account: "Pro",
    limitId: "codex",
    limitName: "Codex",
    windowName: "primary",
    windowMinutes: 10080,
    resetsAt: iso(now + 5 * 86400000),
    nominalStartAt: iso(now - 2 * 86400000),
    firstObservedAt: iso(now - 86400000),
    lastObservedAt: iso(now),
    firstUsedPercent: 40,
    lastUsedPercent: 56,
    samples: [],
    closedAt: null,
    closureReason: null,
    segment: 0,
  };
  render(
    <QuotaCycles
      dataset={dataset({
        lastSync: iso(now),
        records: [
          record({
            timestampMs: now - 7200000,
            billingChannel: "official-subscription",
            cost: 500,
          }),
        ],
        officialQuota: {
          version: 1,
          latest: [
            {
              provider: "codex",
              source: "codex-app-server",
              accountKey: "qa",
              account: "Pro",
              limitId: "codex",
              limitName: "Codex",
              planType: "pro",
              status: "observed",
              updatedAt: iso(now),
              windows: [
                {
                  name: "primary",
                  windowMinutes: 10080,
                  resetsAt: base.resetsAt,
                  usedPercent: 56,
                  remainingPercent: 44,
                },
              ],
            },
          ],
          officialUsage: [],
          cycles: [
            {
              ...base,
              closedAt: iso(now - 3600000),
              lastObservedAt: iso(now - 3600000),
            },
            { ...base, segment: 6 },
            {
              ...base,
              id: "replaced",
              resetsAt: iso(now + 4 * 86400000),
              lastObservedAt: iso(now - 7200000),
              closedAt: iso(now - 3600000),
            },
          ],
        },
      })}
    />,
  );
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.queryByText(/已于 .*重置/)).toBeNull();
  expect(screen.queryByText("周期已结束，不再预测")).toBeNull();
  expect(screen.getByText("≈ $1,750.00")).toBeTruthy();
  expect(screen.getByRole("option", { name: /^当前 ·/ })).toBeTruthy();
  const old = screen.getByRole("option", {
    name: /^历史（已替换）/,
  }) as HTMLOptionElement;
  fireEvent.change(screen.getByLabelText("官方订阅周期"), {
    target: { value: old.value },
  });
  expect(screen.getByText("旧窗口已替换")).toBeTruthy();
  expect(screen.getByText(/旧记录原定重置/)).toBeTruthy();
  expect(screen.queryByText("当前官方快照")).toBeNull();
  expect(screen.getByText("旧窗口已替换，不再预测")).toBeTruthy();
});
