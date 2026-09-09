import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotaCapacityScenario } from "../src/components/QuotaCapacityScenario";

describe("个人容量情景", () => {
  it("只在有效人工校准后显示容量，无效百分点不会保留旧预测", () => {
    render(<QuotaCapacityScenario usedPercent={40} />);
    expect(screen.queryByText(/约 .*Tokens/)).toBeNull();
    fireEvent.change(screen.getByLabelText("已核对的 Tokens 数"), {
      target: { value: "1000000" },
    });
    fireEvent.change(screen.getByLabelText("同期消耗的额度百分点"), {
      target: { value: "5" },
    });
    expect(screen.getByText("约 20,000,000 Tokens")).toBeTruthy();
    expect(screen.getByText("约 12,000,000 Tokens")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("同期消耗的额度百分点"), {
      target: { value: "0" },
    });
    expect(screen.queryByText("约 20,000,000 Tokens")).toBeNull();
    fireEvent.change(screen.getByLabelText("同期消耗的额度百分点"), {
      target: { value: "101" },
    });
    expect(screen.queryByText("约 20,000,000 Tokens")).toBeNull();
  });
});
