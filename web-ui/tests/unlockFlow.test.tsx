import React from "react";
import policy from "../index.html?raw";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { UnlockQA } from "../qa/unlock";
import {
  unlockFixture,
  UNLOCK_QA_REPO,
  type UnlockScenario,
} from "../qa/unlockFixture";
import { forgetDashboardSession } from "../src/lib/session";
beforeEach(async () => {
  history.replaceState(null, "", `/qa/unlock.html?repo=${UNLOCK_QA_REPO}`);
  await forgetDashboardSession();
});
afterEach(async () => {
  await forgetDashboardSession();
});
async function start(scenario: UnlockScenario) {
  const transport = await unlockFixture(scenario);
  vi.stubGlobal("fetch", vi.fn(transport.fetcher));
  render(<UnlockQA />);
  await screen.findByLabelText("工作区密码");
  return transport;
}
async function submit(password?: string) {
  if (password !== undefined)
    fireEvent.change(screen.getByLabelText("工作区密码"), {
      target: { value: password },
    });
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: "解锁工作区" }));
  });
}
describe("真实解密与解锁故障闭环（仅模拟网络）", () => {
  it("配置超时保留输入且不标错密码，重试经实际解密进入工作区", async () => {
    await start("access-timeout");
    await submit("demo");
    expect((await screen.findByRole("alert")).textContent).toContain("超时");
    const input = screen.getByLabelText("工作区密码") as HTMLInputElement;
    expect(input.value).toBe("demo");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await submit();
    expect(
      await screen.findByRole("heading", { name: "工作区已解锁" }),
    ).toBeTruthy();
    expect(screen.getByText("1 台演示设备 · 1 条用量记录")).toBeTruthy();
  });
  it("实际密码验证成功后账本超时，重试不再读取配置或输入密码", async () => {
    const transport = await start("data-timeout");
    await submit("demo");
    expect(
      await screen.findByRole("heading", { name: "工作区已验证" }),
    ).toBeTruthy();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("工作区密码")).toBeNull();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "重新读取数据",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await submit();
    expect(
      await screen.findByRole("heading", { name: "工作区已解锁" }),
    ).toBeTruthy();
    expect(
      transport.requests.filter((url) => url.includes("access.json")),
    ).toHaveLength(1);
  });
  it("RAW不可达时经官方API验证；错误密码标红，改正后加载真实加密样本", async () => {
    const transport = await start("raw-unavailable");
    await submit("wrong");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "密码不正确",
    );
    expect(
      screen.getByLabelText("工作区密码").getAttribute("aria-invalid"),
    ).toBe("true");
    await submit("demo");
    expect(
      await screen.findByRole("heading", { name: "工作区已解锁" }),
    ).toBeTruthy();
    const allowed = policy.match(/connect-src ([^;]+);/)![1].split(/\s+/);
    for (const url of transport.requests)
      expect(allowed).toContain(new URL(url).origin);
    expect(
      transport.requests.some((url) =>
        url.startsWith("https://api.github.com/"),
      ),
    ).toBe(true);
  });
});
