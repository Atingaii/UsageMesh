import "./subscriptions.css";
import { memo, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  Download,
  History,
  Layers3,
  Monitor,
  ChevronDown,
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
  forecastCycleCost,
  formatWindowDuration,
  type CycleAggregation,
  type CycleGroup,
} from "../lib/quotaCycles";
import {
  currentSubscriptions,
  hasConflictingAccounts,
  subscriptionPeriods,
  sameReset,
  type SubscriptionWindow,
} from "../lib/subscriptions";
import {
  isElapsedSubscriptionPeriod,
  type PeriodChange,
  type SubscriptionPeriod,
} from "../lib/subscriptionPeriods";
import type { DashboardDataset, OfficialQuotaCycle } from "../lib/types";
import { Badge, EmptyState } from "../components/ui";
import { forecastQuotaCycle } from "../../../rust-cli/local-web/quota-forecast.js";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zone = localZone === "Asia/Shanghai" ? "北京时间" : localZone;
function date(value: string | number | null) {
  const ms = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(ms) ? dateFormat.format(ms) : "尚未提供";
}
function countdown(value: string | null, now: number) {
  const delta = Date.parse(value || "") - now;
  if (!Number.isFinite(delta)) return "等待重置时间";
  if (delta <= 0) return "等待重置后更新";
  const minutes = Math.ceil(delta / 60000),
    days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return days
    ? `${days} 天 ${hours} 小时后重置`
    : hours
      ? `${hours} 小时 ${minutes % 60} 分钟后重置`
      : `${minutes} 分钟后重置`;
}
function windowTitle(item: SubscriptionWindow) {
  return `${item.snapshot.limitName || item.snapshot.limitId} · ${formatWindowDuration(item.window.windowMinutes)}`;
}
function Meter({ value, label }: { value: number; label: string }) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div
      className="sub-meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={bounded}
    >
      <span style={{ width: `${bounded}%` }} />
    </div>
  );
}
function exportRows(cycle: OfficialQuotaCycle, result: CycleAggregation) {
  downloadCsv(
    `subscription-${cycle.resetsAt.slice(0, 10)}.csv`,
    [
      "周期开始",
      "周期重置",
      "设备",
      "时间",
      "模型",
      "Tokens",
      "请求",
      "API 等价金额",
    ],
    result.rows.map((row) => [
      dateTime(result.bounds.from),
      dateTime(result.bounds.to),
      row.device,
      dateTime(row.timestampMs),
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
    <section className="sub-ranking">
      <h3>{title}</h3>
      {rows.length ? (
        rows.slice(0, 8).map((row) => (
          <div className="sub-rank-row" key={row.name}>
            <span title={row.name}>{row.name}</span>
            <Meter
              value={total ? (row.tokens / total) * 100 : 0}
              label={`${row.name} Tokens 占比`}
            />
            <strong>{compact(row.tokens)}</strong>
          </div>
        ))
      ) : (
        <p className="sub-muted">暂无记录</p>
      )}
    </section>
  );
}
function UsageDetails({
  result,
  cycle,
  changes = [],
}: {
  result: CycleAggregation;
  cycle: OfficialQuotaCycle;
  changes?: PeriodChange[];
}) {
  return (
    <div className="sub-detail-body">
      <div className="sub-rankings">
        <Ranking title="设备用量" rows={result.devices} />
        <Ranking title="模型用量" rows={result.models} />
      </div>
      <p className="sub-muted">
        统计范围：{dateTime(result.bounds.from)} — {dateTime(result.bounds.to)}
        。仅汇总 Codex
        官方订阅的完整分钟记录，跨设备按时间聚合，尚未核实每条记录的账号归属。
      </p>
      {(result.boundaryBuckets > 0 || result.legacyBuckets > 0) && (
        <p className="sub-muted">
          已排除 {number(result.boundaryBuckets)} 个跨边界分钟桶及{" "}
          {number(result.legacyBuckets)} 个仅有日期的记录。
        </p>
      )}
      {changes.length > 0 && (
        <section className="sub-period-changes" aria-label="本周期额度变更">
          <h3>本周期额度变更</h3>
          <p className="sub-muted">
            以下是同步时观测到的调整，归在本周期内，不单独计为历史周期。
          </p>
          <ul>
            {changes.map((change, index) => (
              <li key={`${change.at}:${index}`}>
                <time dateTime={change.at}>{date(change.at)}</time>
                <span>
                  {change.kind === "reset-time"
                    ? `重置时间：${date(String(change.before))} → ${date(String(change.after))}`
                    : `已用额度：${number(Number(change.before))}% → ${number(Number(change.after))}%`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button
        className="button secondary"
        onClick={() => exportRows(cycle, result)}
      >
        <Download size={16} />
        导出本周期 CSV
      </button>
    </div>
  );
}
function CurrentWindow({
  item,
  dataset,
  now,
  multipleAccounts,
  period,
}: {
  item: SubscriptionWindow;
  dataset: DashboardDataset;
  now: number;
  multipleAccounts: boolean;
  period?: SubscriptionPeriod;
}) {
  const [details, setDetails] = useState(false);
  const result = useMemo(
    () =>
      item.cycle ? aggregateQuotaCycle(dataset.records, item.cycle) : null,
    [dataset.records, item.cycle],
  );
  const estimate = useMemo(
    () =>
      result
        ? forecastCycleCost(
            result,
            item.window.usedPercent,
            item.snapshot.updatedAt,
            dataset.lastSync,
          )
        : null,
    [
      result,
      item.window.usedPercent,
      item.snapshot.updatedAt,
      dataset.lastSync,
    ],
  );
  const partialCoverage = useMemo(() => {
    if (!result) return false;
    const ids = new Set(result.rows.map((row) => row.deviceId));
    const asOf = Date.parse(item.snapshot.updatedAt);
    return (
      dataset.devices.length < dataset.expectedDevices ||
      dataset.devices.some(
        (device) =>
          ids.has(device.id) &&
          (!Number.isFinite(Date.parse(device.lastSync)) ||
            Date.parse(device.lastSync) < asOf - 60_000),
      )
    );
  }, [
    result,
    dataset.devices,
    dataset.expectedDevices,
    item.snapshot.updatedAt,
  ]);
  const forecast = useMemo(
    () => (item.cycle ? forecastQuotaCycle(item.cycle) : null),
    [item.cycle],
  );
  const snapshotTime = Date.parse(item.snapshot.updatedAt);
  const expired = Date.parse(item.window.resetsAt || "") <= now;
  const stale =
    !Number.isFinite(snapshotTime) ||
    now - snapshotTime > 15 * 60000 ||
    snapshotTime > now;
  const used = item.window.usedPercent,
    remaining = Math.max(0, 100 - used);
  const supported = item.snapshot.limitId === "codex";
  const quotaAdjusted = period?.changes.some(
    (change) => change.kind === "quota-adjustment",
  );
  const value =
    !stale && !expired && !multipleAccounts && supported && !quotaAdjusted
      ? estimate
      : null;
  const unavailable = expired
    ? "等待重置后的官方快照"
    : stale
      ? "官方快照已过期，等待同步"
      : used === 0
        ? "额度尚未使用，暂无法估算"
        : multipleAccounts
          ? "存在多个账号，暂不混算金额"
          : !supported
            ? "该额度类别尚无独立金额记录"
            : quotaAdjusted
              ? "周期内额度已调整，暂无法换算总金额"
              : !result?.rows.length
                ? "等待本周期用量记录"
                : Date.parse(dataset.lastSync) < snapshotTime
                  ? "等待账本同步到额度观测时刻"
                  : "暂无可用于估算的计价记录";
  const pace =
    !stale &&
    !expired &&
    forecast?.state === "ready" &&
    !forecast.latest.isStale
      ? forecast.projection.reaches100AtMs != null &&
        forecast.projection.reaches100AtMs <
          Date.parse(item.window.resetsAt || "")
        ? `按近期速度，预计 ${date(forecast.projection.reaches100AtMs)} 耗尽`
        : "按近期速度，预计可用至重置"
      : null;
  return (
    <div className="sub-current">
      <div className="sub-primary-grid">
        <section className="sub-panel sub-quota" aria-label="当前官方额度">
          <div className="sub-panel-head">
            <div>
              <p className="sub-overline">当前订阅</p>
              <h2>{windowTitle(item)}</h2>
              <p className="sub-muted">
                {item.snapshot.account} · {item.snapshot.accountKey.slice(-6)}
              </p>
            </div>
            <Badge tone={stale || expired ? "warning" : "success"}>
              {expired ? "等待更新" : stale ? "快照过期" : "已同步"}
            </Badge>
          </div>
          <div className="sub-remaining">
            <strong>
              {remaining.toFixed(0)}
              <span>%</span>
            </strong>
            <div>
              <span>{stale || expired ? "末次剩余" : "额度剩余"}</span>
              <small>已用 {used.toFixed(1)}%</small>
            </div>
          </div>
          <Meter value={remaining} label="官方额度剩余比例" />
          <div className="sub-reset">
            <Clock3 size={17} />
            <div>
              <strong>{countdown(item.window.resetsAt, now)}</strong>
              <span>
                {date(item.window.resetsAt)} · {zone}
              </span>
            </div>
          </div>
          {pace && (
            <p className="sub-pace">
              <ArrowUpRight size={16} />
              {pace}
            </p>
          )}
          <p className="sub-updated">
            官方观测于 {date(item.snapshot.updatedAt)}
            {stale ? " · 仅供历史参考" : ""}
          </p>
        </section>
        <section className="sub-panel sub-value" aria-label="周期金额估算">
          <div className="sub-panel-head">
            <div>
              <p className="sub-overline">按额度比例换算</p>
              <h2>本周期总金额估算</h2>
            </div>
            <span className="sub-unit">API 等价 · USD</span>
          </div>
          <div className="sub-value-total">
            {value ? (
              <>
                <span>≈</span> {money(value.total)}
              </>
            ) : (
              "—"
            )}
          </div>
          <p className="sub-value-caption">
            {value ? "按当前任务结构，折算到 100% 额度" : unavailable}
          </p>
          <div className="sub-value-split">
            <div>
              <span>已记录金额</span>
              <strong>
                {value
                  ? money(value.recorded)
                  : result
                    ? money(result.cost)
                    : "—"}
              </strong>
            </div>
            <div>
              <span>剩余额度估算</span>
              <strong>{value ? `≈ ${money(value.remaining)}` : "—"}</strong>
            </div>
          </div>
          <div className="sub-formula">
            {value
              ? `${money(value.recorded)} ÷ ${number(value.usedPercent)} × 100 = ${money(value.total)}`
              : "总金额 = 已用金额 ÷ 已用额度百分点 × 100"}
          </div>
          <p className="sub-muted sub-value-note">
            {value?.partialPricing ? "部分记录未完成计价。" : ""}
            {used > 0 && used < 5 ? "额度用量较少，估算波动可能较大。" : ""}
            金额按工作区同期官方订阅记录估算，非实际账单。
            {partialCoverage && "部分设备账本未齐，估算可能偏低。"}
            {value && <>金额截止 {date(value.asOf)}。</>}
          </p>
        </section>
      </div>
      <section className="sub-panel sub-activity">
        <div className="sub-panel-head">
          <div>
            <h2>本周期用量</h2>
            <p className="sub-muted">
              跨设备汇总 ·{" "}
              {item.cycle
                ? `${date(item.cycle.nominalStartAt)} — ${date(item.cycle.resetsAt)}`
                : "等待官方周期范围"}
            </p>
          </div>
          <span className="sub-device-status">
            <Monitor size={16} />
            {dataset.devices.length} / {dataset.expectedDevices} 台已读取
          </span>
        </div>
        <div className="sub-stat-grid">
          <div>
            <span>Tokens</span>
            <strong>{result ? compact(result.totalTokens) : "—"}</strong>
          </div>
          <div>
            <span>请求次数</span>
            <strong>{result ? number(result.requests) : "—"}</strong>
          </div>
          <div>
            <span>参与设备</span>
            <strong>{result ? number(result.deviceCount) : "—"}</strong>
          </div>
        </div>
        {result && item.cycle && (
          <>
            <button
              className="sub-disclosure"
              aria-expanded={details}
              onClick={() => setDetails(!details)}
            >
              <Layers3 size={16} />
              用量明细与统计口径
              <ChevronDown size={16} className={details ? "is-open" : ""} />
            </button>
            {details && (
              <UsageDetails
                result={result}
                cycle={item.cycle}
                changes={period?.changes}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
function HistoryView({
  dataset,
  periods,
  now,
}: {
  dataset: DashboardDataset;
  periods: SubscriptionPeriod[];
  now: number;
}) {
  const history = useMemo(
    () => periods.filter((period) => isElapsedSubscriptionPeriod(period, now)),
    [periods, now],
  );
  const [page, setPage] = useState(0),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = history.find((period) => period.id === selectedId);
  const result = useMemo(
    () => (selected ? aggregateQuotaCycle(dataset.records, selected) : null),
    [dataset.records, selected],
  );
  const count = Math.max(1, Math.ceil(history.length / 12));
  const safePage = Math.min(page, count - 1);
  if (!history.length)
    return (
      <EmptyState
        title="暂无历史周期"
        description="当前周期到期后会归档到这里。周期内的额度调整保留在对应周期的用量明细中。"
      />
    );
  if (selected && result)
    return (
      <section className="sub-panel sub-history-detail">
        <button
          className="button secondary"
          onClick={() => setSelectedId(null)}
        >
          <ArrowLeft size={16} />
          返回周期历史
        </button>
        <h2>
          {selected.limitName} · {formatWindowDuration(selected.windowMinutes)}
        </h2>
        <p className="sub-muted">
          {selected.account} · {dateTime(selected.nominalStartAt)} —{" "}
          {dateTime(selected.resetsAt)} · 末次已用{" "}
          {number(selected.lastUsedPercent)}%
        </p>
        <p className="sub-history-notice">
          额度最后观测于 {dateTime(selected.lastObservedAt)}
          ，不代表完整周期的最终用量。下方账本按该周期范围汇总。
        </p>
        <UsageDetails
          result={result}
          cycle={selected}
          changes={selected.changes}
        />
      </section>
    );
  return (
    <section className="sub-panel sub-history">
      <div className="sub-panel-head">
        <div>
          <h2>周期历史</h2>
          <p className="sub-muted">
            按官方重置时间归档，每个周期一条；额度调整保留在周期内。
          </p>
        </div>
        <Badge>{history.length} 条记录</Badge>
      </div>
      <div className="sub-history-list">
        {history.slice(safePage * 12, safePage * 12 + 12).map((cycle) => (
          <button
            className="sub-history-row"
            key={`${cycle.id}:${cycle.resetsAt}:${cycle.segment}`}
            onClick={() => setSelectedId(cycle.id)}
          >
            <div>
              <strong>
                {cycle.limitName} · {formatWindowDuration(cycle.windowMinutes)}
              </strong>
              <span>
                {cycle.account} · {cycle.accountKey.slice(-6)}
              </span>
            </div>
            <div>
              <span>周期范围</span>
              <strong>
                {date(cycle.nominalStartAt)} — {date(cycle.resetsAt)}
              </strong>
            </div>
            <div>
              <span>末次已用</span>
              <strong>{number(cycle.lastUsedPercent)}%</strong>
            </div>
            <Badge>已到期</Badge>
            <ArrowUpRight size={16} />
          </button>
        ))}
      </div>
      {count > 1 && (
        <div className="sub-pagination">
          <button
            className="button secondary"
            disabled={!safePage}
            onClick={() => setPage(safePage - 1)}
          >
            上一页
          </button>
          <span>
            {safePage + 1} / {count}
          </span>
          <button
            className="button secondary"
            disabled={safePage + 1 >= count}
            onClick={() => setPage(safePage + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
export const QuotaCycles = memo(function QuotaCycles({
  dataset,
}: {
  dataset: DashboardDataset;
}) {
  const [view, setView] = useState<"current" | "history">("current");
  const [selectedKey, setSelectedKey] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const current = useMemo(
    () => currentSubscriptions(dataset.officialQuota),
    [dataset.officialQuota],
  );
  const periods = useMemo(
    () => subscriptionPeriods(dataset.officialQuota, current),
    [dataset.officialQuota, current],
  );
  const selected =
    current.find((item) => item.key === selectedKey) || current[0];
  const accountCount = useMemo(
    () => new Set(current.map((item) => item.snapshot.accountKey)).size,
    [current],
  );
  return (
    <div className="subscriptions">
      <div className="sub-toolbar">
        <div className="sub-tabs" aria-label="订阅视图">
          <button
            className={view === "current" ? "active" : ""}
            aria-pressed={view === "current"}
            onClick={() => setView("current")}
          >
            当前订阅
          </button>
          <button
            className={view === "history" ? "active" : ""}
            aria-pressed={view === "history"}
            onClick={() => setView("history")}
          >
            <History size={16} />
            周期历史
          </button>
        </div>
        <span className="sub-toolbar-note">Codex 官方渠道</span>
      </div>
      {view === "history" ? (
        <HistoryView
          dataset={dataset}
          periods={periods}
          now={Math.max(now, Date.now())}
        />
      ) : (
        <>
          {current.length > 1 && (
            <div className="sub-window-switcher" aria-label="选择当前额度窗口">
              {current.map((item) => (
                <button
                  key={item.key}
                  aria-pressed={item.key === selected?.key}
                  onClick={() => setSelectedKey(item.key)}
                >
                  <strong>{windowTitle(item)}</strong>
                  <span>
                    {accountCount > 1
                      ? `${item.snapshot.account} · ${item.snapshot.accountKey.slice(-6)} · `
                      : ""}
                    剩余 {number(Math.max(0, 100 - item.window.usedPercent))}%
                  </span>
                </button>
              ))}
            </div>
          )}
          {selected ? (
            <CurrentWindow
              key={selected.key}
              item={selected}
              dataset={dataset}
              now={Math.max(now, Date.now())}
              multipleAccounts={hasConflictingAccounts(
                dataset.officialQuota,
                selected,
              )}
              period={periods.find(
                (period) =>
                  period.accountKey === selected.snapshot.accountKey &&
                  period.limitId === selected.snapshot.limitId &&
                  period.windowName === selected.window.name &&
                  period.windowMinutes === selected.window.windowMinutes &&
                  sameReset(period.resetsAt, selected.window.resetsAt),
              )}
            />
          ) : (
            <EmptyState
              title="尚无当前官方额度"
              description="在已登录 Codex 的设备上同步 UsageMesh 后，即可查看剩余额度和重置时间。旧记录可在周期历史中查看。"
            />
          )}
        </>
      )}
    </div>
  );
});
