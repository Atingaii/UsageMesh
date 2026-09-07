import { describe, expect, it, vi } from "vitest";
import { readPreferences, writePreference } from "../src/lib/preferences";

describe("阅读偏好兼容", () => {
  it("迁移旧设置时保留主题与预算并默认清晰字号", () => {
    writePreference(
      "usagemesh:preferences:v1",
      JSON.stringify({ theme: "dark", monthlyBudget: 100, refreshSeconds: 30 }),
    );
    expect(readPreferences()).toEqual({
      theme: "dark",
      monthlyBudget: 100,
      refreshSeconds: 30,
      textSize: "standard",
    });
  });
  it("保留大字选择并拒绝未知字号", () => {
    writePreference(
      "usagemesh:preferences:v1",
      JSON.stringify({ textSize: "large" }),
    );
    expect(readPreferences().textSize).toBe("large");
    writePreference(
      "usagemesh:preferences:v1",
      JSON.stringify({ textSize: "huge" }),
    );
    expect(readPreferences().textSize).toBe("standard");
  });
  it("存储不可用时仍可启动", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPreferences().textSize).toBe("standard");
    vi.restoreAllMocks();
  });
});
