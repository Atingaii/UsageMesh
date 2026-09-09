import { useState } from "react";
import { number } from "../lib/analytics";
import { Section } from "./ui";

/** A user-calibrated scenario, deliberately separate from provider quota facts. */
export function QuotaCapacityScenario({
  usedPercent,
}: {
  usedPercent: number;
}) {
  const [tokens, setTokens] = useState("");
  const [points, setPoints] = useState("");
  const count = Number(tokens),
    delta = Number(points);
  const valid =
    tokens.trim() !== "" &&
    points.trim() !== "" &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    Number.isFinite(delta) &&
    delta >= 1 &&
    delta <= 100 &&
    Number.isFinite(usedPercent) &&
    usedPercent >= 0 &&
    usedPercent <= 100;
  const capacity = valid ? (count / delta) * 100 : null;
  return (
    <Section
      title="Tokens 容量情景估算"
      subtitle="用自己核对过的一段消耗作参考，不代表官方固定总额度"
    >
      <div className="settings-body">
        <details>
          <summary>按我的历史任务结构估算还能使用多少 Tokens</summary>
          <p>
            填入同一账号、同一额度类别、同一时间段内已核对的 Tokens
            与官方消耗百分点。切换模型、推理强度或任务结构后，换算关系可能明显变化。页面不会自动拿未归属的跨设备用量来校准。
          </p>
          <label style={{ display: "grid", gap: 8, marginBottom: 16 }}>
            已核对的 Tokens 数
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              placeholder="例如 1000000"
              value={tokens}
              onChange={(event) => setTokens(event.target.value)}
              style={{ width: "100%", minWidth: 0 }}
            />
          </label>
          <label style={{ display: "grid", gap: 8, marginBottom: 16 }}>
            同期消耗的额度百分点
            <input
              type="number"
              inputMode="decimal"
              min="1"
              max="100"
              step="0.1"
              placeholder="例如从 20% 到 25%，填 5"
              value={points}
              onChange={(event) => setPoints(event.target.value)}
              style={{ width: "100%", minWidth: 0 }}
            />
          </label>
          <div aria-live="polite">
            {capacity !== null ? (
              <>
                <p>
                  100% 容量参考：
                  <strong>约 {number(Math.round(capacity))} Tokens</strong>
                </p>
                <p>
                  按最后观测已用 {usedPercent.toFixed(1)}%，剩余参考：
                  <strong>
                    约{" "}
                    {number(Math.round((capacity * (100 - usedPercent)) / 100))}{" "}
                    Tokens
                  </strong>
                </p>
                <p className="muted small">
                  仅为输入条件下的线性情景估算，不是官方保证、置信区间或计费金额。建议用至少
                  5 个百分点的观测减少取整误差。
                </p>
              </>
            ) : (
              <p className="muted small">
                输入正整数 Tokens 和 1–100
                个百分点后显示参考。输入只用于当前页面，关闭后不保留。
              </p>
            )}
          </div>
        </details>
      </div>
    </Section>
  );
}
