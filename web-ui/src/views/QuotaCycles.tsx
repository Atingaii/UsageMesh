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
  cycleCostSyncPending,
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
function quotaTitle(item: SubscriptionWindow) {
  const duration = item.window.windowMinutes;
  return duration === 10080
    ? "每周额度"
    : `${formatWindowDuration(duration)}额度`;
}
function QuotaRow({ item, now }: { item: SubscriptionWindow; now: number }) {
  const observed = Date.parse(item.snapshot.updatedAt);
  const expired = Date.parse(item.window.resetsAt || "") <= now;
  const stale =
    !Number.isFinite(observed) || now - observed > 15 * 60000 || observed > now;
  const remaining = Math.max(0, 100 - item.window.usedPercent);
  const forecast = useMemo(
    () => (item.cycle ? forecastQuotaCycle(item.cycle) : null),
    [item.cycle],
  );
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
    <div className="sub-quota-row">
      <div className="sub-quota-label">
        <strong>{quotaTitle(item)}</strong>
        <span>{stale || expired ? "末次观测" : "官方额度"}</span>
      </div>
      <div className="sub-quota-progress">
        <div>
          <strong>
            {number(remaining)}% <span>剩余</span>
          </strong>
          <span>已用 {number(item.window.usedPercent)}%</span>
        </div>
        <Meter
          value={remaining}
          label={`${item.snapshot.limitName || item.snapshot.limitId} ${quotaTitle(item)}剩余比例`}
        />
        {pace && <p className="sub-muted sub-pace">{pace}</p>}
      </div>
      <div className="sub-quota-reset">
        <span>
          <Clock3 size={14} />
          {countdown(item.window.resetsAt, now)}
        </span>
        <time
          dateTime={item.window.resetsAt || undefined}
          title={
            item.window.resetsAt ? dateTime(item.window.resetsAt) : undefined
          }
        >
          {date(item.window.resetsAt)} · {zone}
        </time>
        {(stale || expired) && (
          <Badge tone="warning">{expired ? "等待更新" : "快照过期"}</Badge>
        )}
      </div>
    </div>
  );
}
function AccountQuotas({
  items,
  now,
}: {
  items: SubscriptionWindow[];
  now: number;
}) {
  const primary = items.filter((item) => item.snapshot.limitId === "codex");
  const extra = items.filter((item) => item.snapshot.limitId !== "codex");
  const extraGroups = new Map<string, SubscriptionWindow[]>();
  for (const item of extra) {
    const group = extraGroups.get(item.snapshot.limitId) || [];
    group.push(item);
    extraGroups.set(item.snapshot.limitId, group);
  }
  const account = items[0].snapshot;
  return (
    <section className="sub-panel sub-account" aria-label="当前官方额度">
      <div className="sub-panel-head">
        <div>
          <h2>
            Codex <span className="sub-account-plan">{account.account}</span>
          </h2>
          <p className="sub-muted">
            账号 {account.accountKey.slice(-6)} · 官方观测于{" "}
            {date(account.updatedAt)}
          </p>
        </div>
        <span className="sub-source">ChatGPT 订阅</span>
      </div>
      {primary.map((item) => (
        <QuotaRow key={item.key} item={item} now={now} />
      ))}
      {!!extra.length && (
        <details className="sub-extra">
          <summary>
            其他模型额度{" "}
            <span>
              {[
                ...new Set(
                  extra.map(
                    (item) => item.snapshot.limitName || item.snapshot.limitId,
                  ),
                ),
              ].join("、")}
            </span>
            <ChevronDown size={16} />
          </summary>
          <div>
            {[...extraGroups.entries()].map(([limitId, windows]) => (
              <section
                key={limitId}
                aria-label={windows[0].snapshot.limitName || limitId}
              >
                {extraGroups.size > 1 && (
                  <p className="sub-extra-name">
                    {windows[0].snapshot.limitName || limitId}
                  </p>
                )}
                {windows.map((item) => (
                  <QuotaRow key={item.key} item={item} now={now} />
                ))}
              </section>
            ))}
          </div>
        </details>
      )}
    </section>
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
      Boolean(dataset.retainedDeviceIds?.length) ||
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
    dataset.retainedDeviceIds,
    item.snapshot.updatedAt,
  ]);
  const snapshotTime = Date.parse(item.snapshot.updatedAt);
  const expired = Date.parse(item.window.resetsAt || "") <= now;
  const stale =
    !Number.isFinite(snapshotTime) ||
    now - snapshotTime > 15 * 60000 ||
    snapshotTime > now;
  const used = item.window.usedPercent;
  const supported = item.snapshot.limitId === "codex";
  const quotaAdjusted = period?.changes.some(
    (change) => change.kind === "quota-adjustment",
  );
  const partialPricing = Boolean(
    estimate?.partialPricing || result?.costLowerBound,
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
                : cycleCostSyncPending(
                      dataset.lastSync,
                      item.snapshot.updatedAt,
                    )
                  ? "等待账本同步完对应分钟"
                  : "暂无可用于估算的计价记录";
  return (
    <section className="sub-panel sub-activity" aria-label="本周期用量">
      <div className="sub-panel-head">
        <div>
          <h2>本周期用量</h2>
          <p className="sub-muted">
            {item.cycle
              ? `${date(item.cycle.nominalStartAt)} — ${date(item.cycle.resetsAt)}`
              : "等待官方周期范围"}{" "}
            · 跨设备官方订阅记录
          </p>
        </div>
        <span className="sub-device-status">
          <Monitor size={15} />
          {result?.deviceCount || 0} 台参与 · {dataset.devices.length}/
          {dataset.expectedDevices} 台已读取
        </span>
      </div>
      <div className="sub-stat-grid">
        <div>
          <span>已记录金额</span>
          <strong>
            {value ? money(value.recorded) : result ? money(result.cost) : "—"}
          </strong>
          <small>API 等价 · USD</small>
        </div>
        <div aria-label="周期金额估算">
          <span>本周期总金额估算</span>
          <strong>{value ? `≈ ${money(value.total)}` : "—"}</strong>
          <small>{value ? "按已用额度折算至 100%" : unavailable}</small>
        </div>
        <div>
          <span>Tokens</span>
          <strong>{result ? compact(result.totalTokens) : "—"}</strong>
          <small>含缓存用量</small>
        </div>
        <div>
          <span>请求次数</span>
          <strong>{result ? number(result.requests) : "—"}</strong>
          <small>按分钟记录汇总</small>
        </div>
      </div>
      <p
        className={`sub-coverage-note${partialCoverage || partialPricing ? " is-warning" : ""}`}
      >
        金额为 API 等价估算，非订阅账单。
        {partialPricing && " 部分记录未完成计价，金额可能偏低。"}
        {dataset.retainedDeviceIds?.length
          ? " 部分设备沿用上次成功快照，估算可能偏低。"
          : partialCoverage && " 部分设备账本未齐，估算可能偏低。"}
        {value && used < 5 && " 额度用量较少，估算波动可能较大。"}
        {value && <> 截止 {date(value.asOf)}。</>}
      </p>
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
            <>
              <div className="sub-estimate-detail">
                <h3>金额换算</h3>
                <p>
                  {value
                    ? `${money(value.recorded)} ÷ ${number(value.usedPercent)} × 100 = ${money(value.total)}`
                    : "总金额 = 已用金额 ÷ 已用额度百分点 × 100"}
                </p>
                <p className="sub-muted">
                  剩余额度估算 {value ? `≈ ${money(value.remaining)}` : "—"}
                  。按当前任务结构换算，不是官方固定金额额度。
                  {value?.partialPricing && "部分记录未完成计价。"}
                  {used > 0 && used < 5 && "额度用量较少，估算波动可能较大。"}
                </p>
              </div>
              <UsageDetails
                result={result}
                cycle={item.cycle}
                changes={period?.changes}
              />
            </>
          )}
        </>
      )}
    </section>
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
  const [accountKey, setAccountKey] = useState("");
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
  const accounts = useMemo(() => {
    const known = new Map(
      current.map((item) => [
        item.snapshot.accountKey,
        {
          accountKey: item.snapshot.accountKey,
          account: item.snapshot.account,
        },
      ]),
    );
    if (view === "history") {
      for (const period of periods) {
        if (!known.has(period.accountKey))
          known.set(period.accountKey, {
            accountKey: period.accountKey,
            account: period.account,
          });
      }
    }
    return [...known.values()];
  }, [current, periods, view]);
  const selectedAccount =
    accounts.find((item) => item.accountKey === accountKey) || accounts[0];
  const accountWindows = useMemo(
    () =>
      current.filter(
        (item) => item.snapshot.accountKey === selectedAccount?.accountKey,
      ),
    [current, selectedAccount],
  );
  const primary = accountWindows.filter(
    (item) => item.snapshot.limitId === "codex",
  );
  const selected =
    primary.find((item) => item.key === selectedKey) || primary[0];
  const visiblePeriods = useMemo(
    () =>
      selectedAccount
        ? periods.filter(
            (period) => period.accountKey === selectedAccount.accountKey,
          )
        : periods,
    [periods, selectedAccount],
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
        {accounts.length > 1 ? (
          <label className="sub-account-select">
            订阅账号
            <select
              aria-label="订阅账号"
              value={selectedAccount?.accountKey}
              onChange={(event) => {
                setAccountKey(event.target.value);
                setSelectedKey("");
              }}
            >
              {accounts.map((account) => (
                <option key={account.accountKey} value={account.accountKey}>
                  {account.account} · {account.accountKey.slice(-6)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="sub-toolbar-note">官方额度与本地用量</span>
        )}
      </div>
      {view === "history" ? (
        <HistoryView
          dataset={dataset}
          periods={visiblePeriods}
          now={Math.max(now, Date.now())}
        />
      ) : (
        <>
          {!!accountWindows.length && (
            <AccountQuotas
              items={accountWindows}
              now={Math.max(now, Date.now())}
            />
          )}
          {primary.length > 1 && (
            <label className="sub-period-select">
              用量统计周期
              <select
                aria-label="统计周期"
                value={selected?.key}
                onChange={(event) => setSelectedKey(event.target.value)}
              >
                {primary.map((item) => (
                  <option key={item.key} value={item.key}>
                    {quotaTitle(item)} · {date(item.window.resetsAt)} 重置
                  </option>
                ))}
              </select>
            </label>
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
              title={
                accountWindows.length
                  ? "暂无主额度用量窗口"
                  : "尚无当前官方额度"
              }
              description="在已登录 Codex 的设备上同步 UsageMesh 后，即可查看剩余额度和重置时间。旧记录可在周期历史中查看。"
            />
          )}
        </>
      )}
    </div>
  );
});
