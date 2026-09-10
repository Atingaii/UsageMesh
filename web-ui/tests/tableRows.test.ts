import { describe, expect, it, vi } from "vitest";
import { sortTableRows } from "../src/lib/tableRows";

describe("大账本排序", () => {
  it("自然数文本排序保留稳定ID次序，不修改原始顺序，键只读取一次", () => {
    const rows = [
      { id: "b", model: "模型2" },
      { id: "a", model: "模型2" },
      { id: "c", model: "模型10" },
    ];
    const value = vi.fn((row: (typeof rows)[number]) => row.model);
    expect(sortTableRows(rows, value, true).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(value).toHaveBeenCalledTimes(rows.length);
    expect(
      sortTableRows(rows, (row) => row.model, false).map((row) => row.id),
    ).toEqual(["c", "a", "b"]);
    expect(rows.map((row) => row.id)).toEqual(["b", "a", "c"]);
  });
  it("数值排序保留负数与零", () => {
    const rows = [-1, 10, 2, 0].map((cost) => ({ id: String(cost), cost }));
    expect(
      sortTableRows(rows, (row) => row.cost, true).map((row) => row.cost),
    ).toEqual([-1, 0, 2, 10]);
  });
});
