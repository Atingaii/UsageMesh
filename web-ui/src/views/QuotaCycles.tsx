import { useMemo, useState } from "react";
import {
  AlertCircle,
  Download,
  Gauge,
  History,
  Layers3,
  Monitor,
} from "lucide-react";
import {
  compact,
  dateTime,
  downloadCsv,
  money,
  number,
} from "../lib/analytics";
import {
  aggregateQuotaCycle,
  formatWindowDuration,
  type CycleGroup,
} from "../lib/quotaCycles";
import type { DashboardDataset, OfficialQuotaCycle } from "../lib/types";
import { Badge, EmptyState, Section } from "../components/ui";
import { QuotaCapacityScenario } from "../components/QuotaCapacityScenario";
import {
  forecastQuotaCycle,
  type QuotaForecast,
} from "../../../rust-cli/local-web/quota-forecast.js";

function cycleLabel(cycle: OfficialQuotaCycle): string {
  const reset = new Date(cycle.resetsAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${accountLabel(cycle.account, cycle.accountKey)} · ${cycle.limitName} · ${cycle.windowName}（${formatWindowDuration(cycle.windowMinutes)}）· ${reset} 重置`;
}

function accountLabel(account: string, accountKey: string): string {
  const suffix = accountKey.replace(/[^a-z0-9]/gi, "").slice(-6);
  return suffix ? `${account} · ${suffix}` : account;
}

function usageStatus(status: "observed" | "stale" | "unavailable") {
  if (status === "observed")
    return { label: "已观测", tone: "success" as const };
  if (status === "stale")
    return { label: "过期快照", tone: "warning" as const };
  return { label: "暂不可用", tone: "warning" as const };
}

function cycleValue(cycle: OfficialQuotaCycle): string {
  return JSON.stringify([
    cycle.accountKey,
    cycle.limitId,
    cycle.windowName,
    cycle.windowMinutes,
    cycle.resetsAt,
    cycle.segment,
  ]);
}

function exportCycleCsv(
  cycle: OfficialQuotaCycle,
  rows: ReturnType<typeof aggregateQuotaCycle>["rows"],
): void {
  const columns = [
    "口径",
    "周期 ID",
    "账户",
    "额度类别",
    "窗口",
    "桶开始时间",
    "设备",
    "模型",
    "Tokens",
    "请求数",
    "估算费用 USD",
  ];
  downloadCsv(
    `usagemesh-official-cycle-${cycle.id}.csv`,
    columns,
    rows.map((row) => [
      "同期官方订阅用量",
      cycle.id,
      accountLabel(cycle.account, cycle.accountKey),
      cycle.limitName,
      cycle.windowName,
      new Date(row.timestampMs).toISOString(),
      row.device,
      row.model,
      row.totalTokens,
      row.requestsCount,
      row.cost,
    ]),
  );
}

function Ranking({ title, rows }: { title: string; rows: CycleGroup[] }) {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return (
    <Section
      title={title}
      action={<span className="muted small">按 Tokens 排序</span>}
    >
      {rows.length ? (
        <div className="cycle-ranking">
          {rows.slice(0, 10).map((row) => (
            <div className="cycle-ranking-row" key={row.name}>
              <span title={row.name}>{row.name}</span>
              <div className="progress-track">
                <div
                  style={{
                    width: `${total ? (row.tokens / total) * 100 : 0}%`,
                  }}
                />
              </div>
              <strong>{compact(row.tokens)}</strong>
              <small>
                {total ? ((row.tokens / total) * 100).toFixed(1) : "0.0"}%
              </small>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="这个周期暂无已确认分钟桶"
          description="已读取设备中没有落在完整窗口内的官方订阅分钟数据。"
        />
      )}
    </Section>
  );
}

const FORECAST_REASON: Record<string, string> = {
  "no-samples": "等待第一个非零官方观测",
  "one-sample": "至少需要两个不同时间的观测才能计算速度",
  "zero-span": "观测时间跨度不足",
  "early-window": "窗口尚处早期，趋势可能快速变化",
  "flat-usage": "近段官方比例没有明显增长",
  "stale-snapshot": "官方快照已超过 15 分钟，当前耗尽预测已隐藏",
  "invalid-window": "窗口时间或时长无效",
  "short-span": "观测跨度不足 10 分钟",
  "insufficient-change": "官方比例增长不足 1 个百分点",
  "rapid-jump": "检测到短时突增，保留样本但降低趋势评分",
  "low-confidence": "样本拟合或覆盖不足，暂按低评分趋势展示",
};

function percent(value: number | null, digits = 1): string {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

function forecastState(forecast: QuotaForecast): string {
  if (forecast.state === "ready") return "趋势可用";
  if (forecast.state === "expired") return "历史周期";
  if (forecast.state === "invalid") return "窗口无效";
  return forecast.reason
    ? FORECAST_REASON[forecast.reason] || "样本不足"
    : "样本不足";
}

function linePoints(series: QuotaForecast["series"]): string {
  return series
    .map(
      (point) =>
        `${40 + point.progress * 620},${150 - point.usedPercent * 1.2}`,
    )
    .join(" ");
}

function ForecastPanel({ forecast }: { forecast: QuotaForecast }) {
  const projection = forecast.projection;
  const latest = forecast.series.at(-1);
  const projectionEndProgress =
    latest &&
    projection.usedPercentAtReset != null &&
    projection.usedPercentAtReset > 100 &&
    projection.usedPercentAtReset > latest.usedPercent
      ? latest.progress +
        (1 - latest.progress) *
          ((100 - latest.usedPercent) /
            (projection.usedPercentAtReset - latest.usedPercent))
      : 1;
  const projectionPoints =
    latest && projection.usedPercentAtReset != null
      ? `${40 + latest.progress * 620},${150 - latest.usedPercent * 1.2} ${40 + projectionEndProgress * 620},${150 - Math.min(100, projection.usedPercentAtReset) * 1.2}`
      : "";
  const cards = [
    [
      "近段消耗速度",
      forecast.recent.ratePercentPerHour == null
        ? "—"
        : forecast.recent.ratePercentPerHour.toFixed(2),
      forecast.recent.spanMs == null
        ? "等待更多观测"
        : `覆盖 ${Math.round(forecast.recent.spanMs / 60_000)} 分钟 · 趋势评分 ${(forecast.recent.confidence * 100).toFixed(0)}/100`,
      "百分点 / 小时",
    ],
    [
      "预计重置时已用",
      percent(projection.usedPercentAtReset),
      "线性外推可超过 100%，表示可能提前耗尽",
    ],
    [
      "预计耗尽时间",
      projection.reaches100AtMs == null
        ? "—"
        : projection.exhaustsBeforeReset
          ? dateTime(projection.reaches100AtMs)
          : "重置后",
      forecast.latest.isStale
        ? "快照过期，当前耗尽预测已隐藏"
        : "仅按当前近段速度估算",
    ],
    [
      "剩余额度可持续速度",
      projection.sustainableRatePercentPerHour == null
        ? "—"
        : projection.sustainableRatePercentPerHour.toFixed(2),
      projection.speedRatio == null
        ? "以最新官方比例与重置时间计算"
        : `当前约为可持续速度的 ${projection.speedRatio.toFixed(2)}×`,
      "百分点 / 小时",
    ],
  ];
  return (
    <Section
      title="额度节奏与耗尽预测"
      subtitle="以官方已用比例的观测序列计算；不使用未归属的跨设备 Tokens 推导额度。"
      action={
        <Badge
          tone={
            forecast.state === "ready"
              ? "success"
              : forecast.state === "invalid"
                ? "warning"
                : ""
          }
        >
          {forecastState(forecast)}
        </Badge>
      }
    >
      <div className="analysis-stats" style={{ padding: "0 20px 18px" }}>
        {cards.map(([label, value, note, unit]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            {unit && <small>{unit}</small>}
            <small>{note}</small>
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          padding: "14px 20px 18px",
        }}
      >
        <svg
          viewBox="0 0 700 180"
          width="100%"
          role="img"
          aria-label="当前周期官方比例、理想节奏和线性预测"
          style={{ display: "block", minHeight: 190 }}
        >
          {[0, 25, 50, 75, 100].map((value) => (
            <g key={value}>
              <line
                x1="40"
                x2="660"
                y1={150 - value * 1.2}
                y2={150 - value * 1.2}
                stroke="var(--border-subtle)"
              />
              <text
                x="32"
                y={154 - value * 1.2}
                textAnchor="end"
                fill="var(--text-muted)"
                fontSize="10"
              >
                {value}%
              </text>
            </g>
          ))}
          <line
            x1="40"
            y1="150"
            x2="660"
            y2="30"
            stroke="var(--text-muted)"
            strokeDasharray="5 5"
            opacity="0.65"
          />
          {forecast.series.length > 1 ? (
            <polyline
              points={linePoints(forecast.series)}
              fill="none"
              stroke="var(--primary)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
          ) : null}
          {latest ? (
            <circle
              cx={40 + latest.progress * 620}
              cy={150 - latest.usedPercent * 1.2}
              r="4"
              fill="var(--primary)"
            />
          ) : null}
          {projectionPoints ? (
            <polyline
              points={projectionPoints}
              fill="none"
              stroke="var(--amber)"
              strokeWidth="2"
              strokeDasharray="7 5"
            />
          ) : null}
          <text x="40" y="174" fill="var(--text-muted)" fontSize="10">
            周期起点
          </text>
          <text
            x="660"
            y="174"
            textAnchor="end"
            fill="var(--text-muted)"
            fontSize="10"
          >
            重置
          </text>
        </svg>
        <p className="muted small">
          实线为官方观测，灰色虚线为均匀节奏，黄色虚线为近段速度外推。
          {forecast.reason ? ` ${FORECAST_REASON[forecast.reason] || ""}` : ""}
          {forecast.recent.spanMs != null
            ? " 趋势评分由样本数量、时间覆盖和线性拟合共同计算，是启发式评分。"
            : ""}
        </p>
      </div>
    </Section>
  );
}

function HistoricalPaceChart({
  cycles,
  selected,
}: {
  cycles: OfficialQuotaCycle[];
  selected: OfficialQuotaCycle;
}) {
  const comparable = cycles
    .filter(
      (cycle) =>
        cycle.accountKey === selected.accountKey &&
        cycle.limitId === selected.limitId &&
        cycle.windowName === selected.windowName &&
        cycle.windowMinutes === selected.windowMinutes,
    )
    .slice(0, 6)
    .map((cycle) => ({ cycle, forecast: forecastQuotaCycle(cycle) }));
  return (
    <Section
      title="历史周期节奏"
      subtitle="按周期进度对齐最近观测；历史末次观测不代表最终值。"
      action={
        <span className="muted small">{comparable.length} 个可比周期</span>
      }
    >
      <div style={{ padding: "8px 20px 18px" }}>
        <svg
          viewBox="0 0 700 180"
          width="100%"
          role="img"
          aria-label="历史周期官方额度节奏"
          style={{ display: "block", minHeight: 190 }}
        >
          <line
            x1="40"
            y1="150"
            x2="660"
            y2="30"
            stroke="var(--text-muted)"
            strokeDasharray="5 5"
            opacity="0.55"
          />
          {comparable.map(({ cycle, forecast }, index) =>
            forecast.series.length > 1 ? (
              <polyline
                key={`${cycle.id}:${cycle.segment}`}
                points={linePoints(forecast.series)}
                fill="none"
                stroke={
                  cycle.id === selected.id && cycle.segment === selected.segment
                    ? "var(--primary)"
                    : "var(--text-muted)"
                }
                strokeWidth={
                  cycle.id === selected.id && cycle.segment === selected.segment
                    ? 3
                    : 1.5
                }
                opacity={
                  cycle.id === selected.id && cycle.segment === selected.segment
                    ? 1
                    : Math.max(0.2, 0.65 - index * 0.07)
                }
              />
            ) : null,
          )}
          <text x="40" y="174" fill="var(--text-muted)" fontSize="10">
            0%
          </text>
          <text
            x="660"
            y="174"
            textAnchor="end"
            fill="var(--text-muted)"
            fontSize="10"
          >
            100% 周期时间
          </text>
        </svg>
      </div>
    </Section>
  );
}

function LatestQuotaList({ dataset }: { dataset: DashboardDataset }) {
  const latest = dataset.officialQuota?.latest || [];
  return (
    <div className="view-stack">
      <p className="notice">
        官方额度已同步，尚无非零消耗周期。0%
        滑动窗口只保留最新事实，不生成预测历史。
      </p>
      <Section title="最新官方额度" subtitle="来自 Codex App Server 的最近观测">
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="最新官方额度"
        >
          <table>
            <thead>
              <tr>
                <th>账户</th>
                <th>额度类别</th>
                <th>窗口</th>
                <th className="numeric">已用</th>
                <th>重置时间</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {latest.flatMap((snapshot) =>
                snapshot.windows.map((window) => (
                  <tr
                    key={`${snapshot.accountKey}:${snapshot.limitId}:${window.name}`}
                  >
                    <td>
                      {accountLabel(snapshot.account, snapshot.accountKey)}
                    </td>
                    <td>{snapshot.limitName}</td>
                    <td>
                      {window.name} ·{" "}
                      {formatWindowDuration(window.windowMinutes)}
                    </td>
                    <td className="numeric">
                      {window.usedPercent.toFixed(1)}%
                    </td>
                    <td>{window.resetsAt ? dateTime(window.resetsAt) : "—"}</td>
                    <td>{dateTime(snapshot.updatedAt)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

export function QuotaCycles({ dataset }: { dataset: DashboardDataset }) {
  const cycles = dataset.officialQuota?.cycles || [];
  const [selectedId, setSelectedId] = useState(() =>
    cycles[0] ? cycleValue(cycles[0]) : "",
  );
  const selected =
    cycles.find((cycle) => cycleValue(cycle) === selectedId) || cycles[0];
  const result = useMemo(
    () => (selected ? aggregateQuotaCycle(dataset.records, selected) : null),
    [dataset.records, selected],
  );
  const forecast = useMemo(
    () => (selected ? forecastQuotaCycle(selected) : null),
    [selected],
  );
  if (!dataset.officialQuota) {
    return (
      <EmptyState
        title="尚未读取到官方订阅周期"
        description="请至少在一台设备升级 UsageMesh CLI 后执行 sync。周期元数据出现后，本页会同时汇总其他已读取设备已有的官方订阅分钟数据。"
      />
    );
  }
  if (!cycles.length) {
    if (dataset.officialQuota.latest.length)
      return <LatestQuotaList dataset={dataset} />;
    return (
      <EmptyState
        title="官方额度已同步，暂无可展示窗口"
        description="当前同步结果没有有效的官方窗口或非零消耗周期，请稍后再次同步。"
      />
    );
  }
  if (!selected || !result) return null;
  const exactSnapshot = dataset.officialQuota.latest
    .filter(
      (snapshot) =>
        snapshot.accountKey === selected.accountKey &&
        snapshot.limitId === selected.limitId,
    )
    .flatMap((snapshot) =>
      snapshot.windows
        .filter(
          (window) =>
            window.name === selected.windowName &&
            window.resetsAt === selected.resetsAt,
        )
        .map((window) => ({ snapshot, window })),
    )
    .sort(
      (a, b) =>
        Date.parse(b.snapshot.updatedAt) - Date.parse(a.snapshot.updatedAt),
    )[0];
  const expired = result.bounds.to <= Date.now();
  const stats = [
    {
      label: "同期官方订阅 Tokens",
      value: compact(result.totalTokens),
      note: `${number(result.rows.length)} 个完整分钟桶`,
      icon: Layers3,
    },
    {
      label: "请求数",
      value: number(result.requests),
      note: "来自分钟账本，不使用截断的请求明细",
      icon: History,
    },
    {
      label: "估算费用",
      value: `${result.costLowerBound ? "≥ " : ""}${money(result.cost)}`,
      note: "设备端账本估算",
      icon: Gauge,
    },
    {
      label: "参与设备",
      value: number(result.deviceCount),
      note: `已读取 ${dataset.devices.length} / ${dataset.expectedDevices} 台`,
      icon: Monitor,
    },
  ];
  return (
    <div className="view-stack quota-cycles">
      <Section
        title="选择官方额度周期"
        subtitle="周期来自 Codex 官方服务的实际窗口时长；本页不继承概览页时间筛选。"
        action={
          <label className="inline-select cycle-select">
            周期
            <select
              aria-label="官方订阅周期"
              value={cycleValue(selected)}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {cycles.map((cycle) => (
                <option key={cycleValue(cycle)} value={cycleValue(cycle)}>
                  {cycleLabel(cycle)}
                </option>
              ))}
            </select>
          </label>
        }
      >
        <div className="cycle-scope">
          <div>
            <span className="eyebrow">AGGREGATION SCOPE</span>
            <strong>
              {accountLabel(selected.account, selected.accountKey)} ·{" "}
              {selected.limitName} · {selected.windowName}
            </strong>
            <p>
              {dateTime(result.bounds.from)} 至 {dateTime(result.bounds.to)}
              （含起点，不含结束时刻）
            </p>
          </div>
          <div className="cycle-observation">
            <Badge tone={expired ? "warning" : "success"}>
              {expired ? "周期已结束" : "周期观测中"}
            </Badge>
            {exactSnapshot ? (
              <>
                <strong>
                  {exactSnapshot.window.usedPercent.toFixed(1)}% 已使用
                </strong>
                <small>
                  官方快照 · 更新于 {dateTime(exactSnapshot.snapshot.updatedAt)}
                </small>
              </>
            ) : (
              <>
                <strong>{selected.lastUsedPercent.toFixed(1)}% 末次观测</strong>
                <small>
                  历史末次观测不是周期最终值 ·{" "}
                  {dateTime(selected.lastObservedAt)}
                </small>
              </>
            )}
          </div>
        </div>
      </Section>

      <p className="notice cycle-explanation">
        所有已读取设备的 Codex
        官方订阅记录，按此窗口的时间范围聚合；起点由重置时间减去窗口时长推算。这些记录未证明归属此账号或此额度类别，因此不做请求归属推断，也不按模型猜测额度类别。
      </p>

      {(dataset.warnings.length > 0 ||
        dataset.devices.length < dataset.expectedDevices) && (
        <div className="notice warning" role="alert">
          <AlertCircle size={18} />
          <p>
            有{" "}
            {Math.max(
              dataset.warnings.length,
              dataset.expectedDevices - dataset.devices.length,
            )}{" "}
            台设备未成功读取，本周期汇总可能不完整。
          </p>
        </div>
      )}

      <div className="kpi-grid cycle-kpis">
        {stats.map((stat) => (
          <section className="kpi-card" key={stat.label}>
            <div className="kpi-top">
              <span>{stat.label}</span>
              <span className="kpi-icon violet">
                <stat.icon size={17} />
              </span>
            </div>
            <div className="kpi-value">{stat.value}</div>
            <div className="kpi-note">{stat.note}</div>
          </section>
        ))}
      </div>

      {(result.boundaryBuckets > 0 || result.legacyBuckets > 0) && (
        <div className="cycle-verification-grid">
          <div className="notice warning">
            <AlertCircle size={18} />
            <div>
              <strong>
                边界待核对：{number(result.boundaryTokens)} Tokens
              </strong>
              <p>
                {number(result.boundaryBuckets)}{" "}
                个分钟桶跨越周期边界，未计入上方总量。
              </p>
            </div>
          </div>
          <div className="notice">
            <History size={18} />
            <div>
              <strong>
                日期精度记录已排除：{number(result.legacyTokens)} Tokens
              </strong>
              <p>
                {number(result.legacyBuckets)}{" "}
                个旧桶缺少分钟时间，无法推测具体小时。
              </p>
            </div>
          </div>
        </div>
      )}

      {forecast && <ForecastPanel forecast={forecast} />}
      <QuotaCapacityScenario
        key={selected.accountKey + selected.limitId}
        usedPercent={selected.lastUsedPercent}
      />
      <HistoricalPaceChart
        cycles={dataset.officialQuota.cycles}
        selected={selected}
      />

      <div className="cycle-ranking-grid">
        <Ranking title="按设备排行" rows={result.devices} />
        <Ranking title="按模型排行" rows={result.models} />
      </div>

      {dataset.officialQuota.officialUsage.length > 0 && (
        <Section
          title="官方账户用量快照"
          subtitle="独立展示 Codex 官方账户用量；同账号同日期采用更新较晚的设备快照，不跨设备相加。"
        >
          <div className="official-usage-list">
            {dataset.officialQuota.officialUsage.map((usage) => {
              const account = dataset.officialQuota!.latest.find(
                (snapshot) => snapshot.accountKey === usage.accountKey,
              )?.account;
              const latestBucket = usage.dailyUsageBuckets?.at(-1);
              const status = usageStatus(usage.status);
              return (
                <div className="official-usage-row" key={usage.accountKey}>
                  <div>
                    <strong>
                      {accountLabel(account || "Codex 账户", usage.accountKey)}
                    </strong>
                    <small>更新于 {dateTime(usage.updatedAt)}</small>
                  </div>
                  <div>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <strong>
                      {latestBucket ? number(latestBucket.tokens) : "—"}
                    </strong>
                    <small>
                      {latestBucket
                        ? `${latestBucket.startDate} Tokens`
                        : "暂无每日 Tokens"}
                    </small>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <div className="cycle-export">
        <span>
          CSV 仅包含完整落入此周期的官方订阅分钟桶；含起点，不含结束时刻。
        </span>
        <button
          className="button"
          disabled={!result.rows.length}
          onClick={() => exportCycleCsv(selected, result.rows)}
        >
          <Download size={16} />
          导出同期官方订阅 CSV
        </button>
      </div>
    </div>
  );
}
