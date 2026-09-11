import "./subscriptions.css";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  Download,
  History,
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
function QuotaRow({
  item,
  now,
  selected,
  onSelect,
}: {
  item: SubscriptionWindow;
  now: number;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const observed = Date.parse(item.snapshot.updatedAt);
  const expired = Date.parse(item.window.resetsAt || "") <= now;
  const sourceStale = item.snapshot.status === "stale";
  const stale =
    sourceStale ||
    !Number.isFinite(observed) ||
    now - observed > 15 * 60000 ||
    observed > now;
  const remaining = Math.max(0, 100 - item.window.usedPercent);
  const forecast = useMemo(
    () => (item.cycle ? forecastQuotaCycle(item.cycle) : null),
    [item.cycle],
  );
  const exhaustsAt =
    !stale &&
    !expired &&
    forecast?.state === "ready" &&
    !forecast.latest.isStale &&
    forecast.projection.reaches100AtMs != null &&
    forecast.projection.reaches100AtMs < Date.parse(item.window.resetsAt || "")
      ? forecast.projection.reaches100AtMs
      : null;
  return (
    <div
      className={`sub-quota-row${selected ? " is-selected" : ""}${onSelect ? " is-selectable" : ""}`}
    >
      <div className="sub-quota-heading">
        {onSelect ? (
          <button
            className="sub-window-choice"
            aria-label={`查看${quotaTitle(item)}用量`}
            aria-pressed={selected}
            onClick={onSelect}
          >
            {quotaTitle(item)}
            <span aria-hidden="true">{selected ? "正在查看" : "查看用量"}</span>
          </button>
        ) : (
          <strong>{quotaTitle(item)}</strong>
        )}
        <strong className="sub-remaining">
          {number(remaining)}%{" "}
          <span>{stale || expired ? "末次剩余" : "剩余"}</span>
        </strong>
      </div>
      <Meter
        value={remaining}
        label={`${item.snapshot.limitName || item.snapshot.limitId} ${quotaTitle(item)}剩余比例`}
      />
      <div className="sub-quota-meta">
        <time
          dateTime={item.window.resetsAt || undefined}
          title={
            item.window.resetsAt
              ? `${dateTime(item.window.resetsAt)} · ${zone}`
              : undefined
          }
          aria-label={
            item.window.resetsAt
              ? `${dateTime(item.window.resetsAt)} · ${zone}重置`
              : undefined
          }
        >
          <Clock3 size={13} />
          {item.window.resetsAt && <>{date(item.window.resetsAt)} · </>}
          {countdown(item.window.resetsAt, now)}
        </time>
        {stale || expired ? (
          <span className="sub-warning">
            {expired ? "等待更新" : sourceStale ? "暂未更新" : "快照过期"}
          </span>
        ) : (
          exhaustsAt && (
            <span className="sub-warning">预计 {date(exhaustsAt)} 耗尽</span>
          )
        )}
      </div>
    </div>
  );
}
function AccountQuotas({
  items,
  now,
  selectedKey,
  onSelect,
  children,
}: {
  items: SubscriptionWindow[];
  now: number;
  selectedKey?: string;
  onSelect: (key: string) => void;
  children: ReactNode;
}) {
  const primary = items.filter((item) => item.snapshot.limitId === "codex");
  const extraGroups = new Map<string, SubscriptionWindow[]>();
  for (const item of items.filter(
    (item) => item.snapshot.limitId !== "codex",
  )) {
    const group = extraGroups.get(item.snapshot.limitId) || [];
    group.push(item);
    extraGroups.set(item.snapshot.limitId, group);
  }
  const account = items[0].snapshot;
  return (
    <section className="sub-panel sub-account" aria-label="当前官方额度">
      <header className="sub-panel-head">
        <div>
          <h2>
            Codex <span className="sub-account-plan">{account.account}</span>
          </h2>
          <span className="sub-account-id">
            账号 {account.accountKey.slice(-6)}
          </span>
        </div>
        <time
          className="sub-updated"
          dateTime={account.updatedAt}
          title={`${dateTime(account.updatedAt)} · ${zone}`}
        >
          额度更新于 {date(account.updatedAt)}
        </time>
      </header>
      <div className="sub-primary-windows">
        {primary.map((item) => (
          <QuotaRow
            key={item.key}
            item={item}
            now={now}
            selected={primary.length > 1 && item.key === selectedKey}
            onSelect={primary.length > 1 ? () => onSelect(item.key) : undefined}
          />
        ))}
      </div>
      {children}
      {[...extraGroups.entries()].map(([limitId, windows]) => (
        <section
          className="sub-extra"
          key={limitId}
          aria-label={windows[0].snapshot.limitName || limitId}
        >
          <h3>{windows[0].snapshot.limitName || limitId}</h3>
          <div className="sub-extra-windows">
            {windows.map((item) => (
              <QuotaRow key={item.key} item={item} now={now} />
            ))}
          </div>
        </section>
      ))}
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
  const sourceStale = item.snapshot.status === "stale";
  const stale =
    sourceStale ||
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
    : sourceStale
      ? "官方额度暂未更新，显示上次记录"
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
    <section className="sub-activity" aria-label="本周期用量">
      <header className="sub-activity-head">
        <h3>
          {item.window.windowMinutes === 10080
            ? "本周用量"
            : `${formatWindowDuration(item.window.windowMinutes)}用量`}
        </h3>
        <span
          className="sub-period-range"
          title={
            item.cycle
              ? `${dateTime(item.cycle.nominalStartAt)} — ${dateTime(item.cycle.resetsAt)} · ${zone}`
              : undefined
          }
        >
          {item.cycle
            ? `${date(item.cycle.nominalStartAt)} — ${date(item.cycle.resetsAt)}`
            : "等待官方周期范围"}
        </span>
      </header>
      <dl className="sub-costs">
        <div>
          <dt>已记录金额</dt>
          <dd>
            {value ? money(value.recorded) : result ? money(result.cost) : "—"}
          </dd>
        </div>
        <div className="sub-total" aria-label="周期金额估算">
          <dt>本周期总金额估算</dt>
          <dd>{value ? `≈ ${money(value.total)}` : "—"}</dd>
        </div>
      </dl>
      {value ? (
        <p className="sub-formula">
          {money(value.recorded)} ÷ {number(value.usedPercent)} × 100 ={" "}
          {money(value.total)}
        </p>
      ) : (
        <p className="sub-unavailable">{unavailable}</p>
      )}
      <div className="sub-usage-inline">
        <span>
          <strong>{result ? compact(result.totalTokens) : "—"}</strong> Tokens
        </span>
        <span>
          <strong>{result ? number(result.requests) : "—"}</strong> 次请求
        </span>
        <span>{result?.deviceCount || 0} 台设备</span>
      </div>
      <div className="sub-activity-footer">
        <span>
          API 等价估算，非账单{value && <> · 截止 {date(value.asOf)}</>}
        </span>
        {result && item.cycle && (
          <button
            className="sub-text-button"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            统计口径
            <ChevronDown size={14} className={details ? "is-open" : ""} />
          </button>
        )}
      </div>
      {(partialCoverage || partialPricing || (value && used < 5)) && (
        <p className="sub-coverage-note">
          {partialPricing && "部分记录未完成计价，金额可能偏低。"}
          {dataset.retainedDeviceIds?.length
            ? "部分设备沿用上次成功快照，估算可能偏低。"
            : partialCoverage && "部分设备账本未齐，估算可能偏低。"}
          {value && used < 5 && "额度用量较少，估算波动可能较大。"}
        </p>
      )}
      {details && result && item.cycle && (
        <div className="sub-details">
          <p className="sub-muted">
            剩余额度估算 {value ? `≈ ${money(value.remaining)}` : "—"}
            。按当前任务结构换算，并非官方固定金额额度。
          </p>
          <UsageDetails
            result={result}
            cycle={item.cycle}
            changes={period?.changes}
          />
        </div>
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
          ，不代表完整周期的最终用量。
          {selected.limitId === "codex" && "下方账本按该周期范围汇总。"}
        </p>
        {selected.limitId === "codex" ? (
          <>
            <div className="sub-history-stats">
              <span>{money(result.cost)} API 等价</span>
              <span>{compact(result.totalTokens)} Tokens</span>
              <span>{number(result.requests)} 次请求</span>
            </div>
            <UsageDetails
              result={result}
              cycle={selected}
              changes={selected.changes}
            />
          </>
        ) : (
          <p className="sub-muted">该专用额度尚无独立用量记录。</p>
        )}
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
  const activity = selected ? (
    <CurrentWindow
      key={selected.key}
      item={selected}
      dataset={dataset}
      now={Math.max(now, Date.now())}
      multipleAccounts={hasConflictingAccounts(dataset.officialQuota, selected)}
      period={periods.find(
        (period) =>
          period.accountKey === selected.snapshot.accountKey &&
          period.limitId === selected.snapshot.limitId &&
          period.windowName === selected.window.name &&
          period.windowMinutes === selected.window.windowMinutes &&
          sameReset(period.resetsAt, selected.window.resetsAt),
      )}
    />
  ) : null;
  return (
    <div className="subscriptions">
      {(accounts.length > 1 || view === "history") && (
        <div className="sub-toolbar">
          {view === "history" && (
            <button
              className="sub-text-button"
              onClick={() => setView("current")}
            >
              <ArrowLeft size={16} />
              当前订阅
            </button>
          )}
          {accounts.length > 1 && (
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
          )}
        </div>
      )}
      {view === "history" ? (
        <HistoryView
          dataset={dataset}
          periods={visiblePeriods}
          now={Math.max(now, Date.now())}
        />
      ) : (
        <>
          {accountWindows.length ? (
            <AccountQuotas
              items={accountWindows}
              now={Math.max(now, Date.now())}
              selectedKey={selected?.key}
              onSelect={setSelectedKey}
            >
              {activity}
            </AccountQuotas>
          ) : (
            <EmptyState
              title="尚无当前官方额度"
              description="在已登录 Codex 的设备上同步 UsageMesh，即可查看额度与用量。"
            />
          )}
          <div className="sub-history-link">
            <button
              className="sub-text-button"
              onClick={() => setView("history")}
            >
              <History size={15} />
              周期历史
            </button>
          </div>
        </>
      )}
    </div>
  );
});
