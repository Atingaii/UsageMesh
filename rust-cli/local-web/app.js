import { icons } from "./icons.js";
import { forecastQuotaCycle } from "./quota-forecast.js";
const $ = (s, root = document) => root.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (v) => "$" + Number(v || 0).toFixed(2);
const num = (v) => Number(v || 0).toLocaleString("zh-CN");
const date = (v) =>
  v && Number.isFinite(new Date(v).getTime())
    ? new Date(v).toLocaleString("zh-CN", { hour12: false })
    : "未知";
const json = (v) => esc(JSON.stringify(v, null, 2));
const getSaved = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
let token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
try {
  token ||= sessionStorage.getItem("usagemesh-local-token") || "";
  if (token) sessionStorage.setItem("usagemesh-local-token", token);
} catch {}
if (location.hash) history.replaceState(null, "", location.pathname);
let state,
  section = "overview",
  busy = false,
  officialUsageExpanded = false;
const sections = {
  overview: ["工作台", "你的 AI 工作，由你掌握。"],
  quota: ["额度中心", "查看来源、有效时间与重置窗口。"],
  projects: ["项目与会话", "从本机记录，找到每一笔用量的去向。"],
  providers: ["供应商配置", "预览变化，再应用到本机工具。"],
  quality: ["渠道质量", "分开观察主动探测和真实请求。"],
  connectors: ["代理连接器", "连接已有代理，读取账号与模型目录。"],
  notifications: ["提醒设置", "在预算、额度与费用变化时提醒。"],
  guide: ["使用指南", "了解本机工作台的功能与数据边界。"],
};
document.documentElement.dataset.theme = getSaved("um-local-theme") || "system";
document.documentElement.classList.toggle(
  "large",
  getSaved("um-local-large") === "true",
);
function button(text, action, id = "", extra = "") {
  return `<button type="button" data-action="${action}" data-id="${esc(id)}" ${extra}>${esc(text)}</button>`;
}
function empty(title, text = "") {
  return `<div class="empty"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`;
}
function field(label, name, value = "", type = "text", extra = "") {
  return `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function select(label, name, options, value) {
  return `<label>${esc(label)}<select name="${name}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}
function note(text) {
  return `<p class="note">${esc(text)}</p>`;
}
function percent(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
function percentText(value) {
  const n = percent(value);
  return n == null ? "未知" : `${n.toFixed(1)}%`;
}
function durationText(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return "时长未知";
  if (n < 60) return `${Math.round(n)} 分钟`;
  if (n % 1440 === 0) return `${n / 1440} 天`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return `${Math.floor(n / 60)} 小时 ${Math.round(n % 60)} 分钟`;
}
function countdown(value) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "重置时间未知";
  const remaining = then - Date.now();
  if (remaining <= 0) return "重置时间已过，请刷新";
  const minutes = Math.ceil(remaining / 60000);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `${hours} 小时${rest ? ` ${rest} 分钟` : ""}后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时后重置`;
}
function accountText(item = {}) {
  const key = String(item.accountKey || "");
  const account = String(item.account || (key ? "官方账号" : "账号身份未核实"));
  const suffix = key.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
  return suffix ? `${account} · 标识 …${suffix}` : account;
}
function quotaConnectionStatus(connection = {}) {
  if (connection.status !== "fresh") return connection.status || "unavailable";
  const success = new Date(connection.lastSuccessAt).getTime();
  const age = Date.now() - success;
  return Number.isFinite(age) && age >= -2 * 60000 && age <= 15 * 60000
    ? "fresh"
    : "stale";
}
function quotaConnectionCopy(connection = {}) {
  const map = {
    fresh: ["已连接", "fresh"],
    stale: ["连接已失效", "stale"],
    unavailable: ["暂时不可用", "unavailable"],
  };
  return map[quotaConnectionStatus(connection)] || ["尚未连接", "unavailable"];
}
function quotaIsCurrent(quota) {
  const recorded = new Date(quota.updatedAt).getTime();
  const age = Date.now() - recorded;
  if (!Number.isFinite(age) || age > 15 * 60000 || age < -2 * 60000)
    return false;
  if (["stale", "unavailable"].includes(quota.status)) return false;
  return (quota.windows || []).some((window) => {
    const reset = window.resetsAt && new Date(window.resetsAt).getTime();
    return (
      percent(window.usedPercent) != null && (!reset || reset > Date.now())
    );
  });
}
function cycleReason(cycle) {
  if (cycle.closureReason === "reset-adjustment") return "重置或额度调整";
  if (cycle.closureReason === "window-changed") return "额度窗口变化";
  return cycleEnded(cycle) ? "已结束（最后观测）" : "持续观测中";
}
function cycleEndAt(cycle) {
  const reset = cycle.resetsAt
    ? new Date(cycle.resetsAt).getTime()
    : Number.NaN;
  const closed = cycle.closedAt
    ? new Date(cycle.closedAt).getTime()
    : Number.NaN;
  if (Number.isFinite(reset) && Number.isFinite(closed))
    return closed < reset ? cycle.closedAt : cycle.resetsAt;
  if (Number.isFinite(closed)) return cycle.closedAt;
  return cycle.resetsAt;
}
function cycleEnded(cycle) {
  const end = new Date(cycleEndAt(cycle)).getTime();
  return Boolean(cycle.closedAt) || (Number.isFinite(end) && end <= Date.now());
}
function cycleRange(cycle) {
  const adjusted = Number(cycle.segment) > 0;
  const from = adjusted ? cycle.firstObservedAt : cycle.nominalStartAt;
  return `${adjusted ? "调整后观测范围" : "推算周期范围"}：${date(from)} — ${date(cycleEndAt(cycle))}`;
}
function sameInstant(left, right) {
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}
function matchingQuotaCycle(quota, window) {
  const minutes = Number(window.windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || !window.resetsAt)
    return null;
  return (
    (state.quotaHistory?.cycles || []).find(
      (cycle) =>
        cycle.closedAt == null &&
        cycle.accountKey === quota.accountKey &&
        cycle.limitId === quota.limitId &&
        cycle.windowName === window.name &&
        Number(cycle.windowMinutes) === minutes &&
        sameInstant(cycle.resetsAt, window.resetsAt),
    ) || null
  );
}
function forecastState(forecast) {
  if (forecast?.reason === "stale-snapshot") return ["样本已过期", "stale"];
  const states = {
    ready: ["预测可参考", "fresh"],
    partial: ["早期估计", "stale"],
    insufficient: ["样本不足", "stale"],
    expired: ["周期已结束", "stale"],
    invalid: ["数据无效", "unavailable"],
  };
  return states[forecast?.state] || ["样本不足", "stale"];
}
function forecastReason(forecast) {
  if (forecast?.reason === "stale-snapshot")
    return "最新观测已超过 15 分钟，不提供当前耗尽时间。";
  if (
    forecast?.series?.length &&
    forecast.series.every((point) => point.usedPercent === 0)
  )
    return "已同步，但尚无非零消耗观测。";
  const reasons = {
    "no-samples": "当前周期还没有可用观测点。",
    "one-sample": "至少需要两个不同时间的观测点才能计算速度。",
    "zero-span": "观测点时间跨度不足，暂时无法计算速度。",
    "early-window": "周期仍处于早期，预测会随新观测明显变化。",
    "flat-usage": "已同步，但尚无非零消耗观测。",
    "invalid-window": "窗口时长或周期边界无效，无法预测。",
    "short-span": "有效观测不足 10 分钟，先作为早期估计。",
    "insufficient-change": "观测到的变化小于 1 个百分点，趋势仍不稳定。",
    "rapid-jump": "近期突增，趋势评分已降低。",
    "low-confidence": "近期变化与线性趋势拟合度较低，趋势评分较低。",
  };
  return (
    reasons[forecast?.reason] ||
    "预测仅基于已观测的额度百分比，不代表官方承诺。"
  );
}
function paceExplanation(forecast) {
  const expected = forecast?.pace?.expectedUsedPercent;
  const delta = forecast?.pace?.deltaPercent;
  if (
    typeof expected !== "number" ||
    !Number.isFinite(expected) ||
    typeof delta !== "number" ||
    !Number.isFinite(delta)
  )
    return "";
  const stages = {
    "far-below": "明显低于均匀消耗参考",
    below: "低于均匀消耗参考",
    "on-track": "接近均匀消耗参考",
    above: "高于均匀消耗参考",
    "far-above": "明显高于均匀消耗参考",
  };
  return `按周期进度的均匀参考值为 ${expected.toFixed(1)}%，当前${stages[forecast.pace.stage] || "与参考进度存在差异"}（${delta >= 0 ? "+" : ""}${delta.toFixed(1)} 个百分点）。`;
}
function rateText(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "暂不可用";
  const digits = Math.abs(value) < 0.01 && value !== 0 ? 3 : 2;
  return `${value.toFixed(digits)} 个百分点/小时`;
}
function projectedPercentText(forecast) {
  if (forecast?.state === "expired") return "周期已结束";
  const value = forecast?.projection?.usedPercentAtReset;
  if (typeof value !== "number" || !Number.isFinite(value)) return "暂不预测";
  if (forecast.projection.exhaustsBeforeReset)
    return `${value.toFixed(1)}%（按此速度将先耗尽）`;
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}
function exhaustionText(forecast) {
  const projection = forecast?.projection || {};
  if (forecast?.state === "expired") return "周期已结束，不再提供 ETA";
  if (forecast?.latest?.isStale) return "样本已过期，暂停 ETA";
  if (!projection.exhaustsBeforeReset) {
    return projection.usedPercentAtReset == null
      ? "暂不预测"
      : "预计不会在本周期重置前耗尽";
  }
  return date(projection.reaches100AtMs);
}
function trendPath(points, width = 520, height = 160) {
  const padX = 18;
  const padY = 14;
  const innerWidth = width - padX * 2;
  const innerHeight = height - padY * 2;
  const path = points
    .map((point, index) => {
      const x = padX + point.progress * innerWidth;
      const y = padY + (1 - point.usedPercent / 100) * innerHeight;
      return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  if (points.length !== 1) return path;
  const x = padX + points[0].progress * innerWidth + 0.01;
  const y = padY + (1 - points[0].usedPercent / 100) * innerHeight;
  return `${path} L${x.toFixed(2)} ${y.toFixed(2)}`;
}
function quotaTrendSvg(forecast) {
  const series = (forecast?.series || []).filter(
    (point) =>
      point &&
      typeof point.progress === "number" &&
      Number.isFinite(point.progress) &&
      point.progress >= 0 &&
      point.progress <= 1 &&
      typeof point.usedPercent === "number" &&
      Number.isFinite(point.usedPercent) &&
      point.usedPercent >= 0 &&
      point.usedPercent <= 100,
  );
  if (!series.length)
    return empty(
      "趋势样本不足",
      "已同步当前周期，但尚无可绘制的非零消耗观测。",
    );
  const observed = trendPath(series);
  const latest = series.at(-1);
  const projected = forecast?.projection?.usedPercentAtReset;
  const canProject =
    ["ready", "partial"].includes(forecast?.state) &&
    !forecast.latest?.isStale &&
    typeof projected === "number" &&
    Number.isFinite(projected) &&
    latest.progress < 1;
  let projection = "";
  if (canProject) {
    let endProgress = 1;
    let endPercent = Math.max(0, Math.min(100, projected));
    if (projected > 100 && projected > latest.usedPercent) {
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (100 - latest.usedPercent) / (projected - latest.usedPercent),
        ),
      );
      endProgress = latest.progress + (1 - latest.progress) * fraction;
      endPercent = 100;
    }
    projection = trendPath([
      latest,
      { progress: endProgress, usedPercent: endPercent },
    ]);
  }
  return `<div class="quota-trend"><svg viewBox="0 0 520 160" width="100%" height="180" role="img" aria-label="额度周期已用百分比趋势"><path d="M18 146 L502 14" fill="none" stroke="#b7b3c7" stroke-width="1.5" stroke-dasharray="4 5"></path><path d="${observed}" fill="none" stroke="#6554f0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>${projection ? `<path d="${projection}" fill="none" stroke="#9b59d0" stroke-width="2" stroke-dasharray="7 6" stroke-linecap="round"></path>` : ""}</svg><div class="trend-legend"><span>实线：实际观测</span><span>细虚线：均匀消耗参考</span>${projection ? "<span>紫色虚线：线性预测</span>" : ""}</div></div>`;
}
function forecastMetricsHtml(forecast) {
  const [label, statusClass] = forecastState(forecast);
  const trendScore =
    forecast?.stableSampleCount >= 2 &&
    typeof forecast?.recent?.confidence === "number" &&
    Number.isFinite(forecast.recent.confidence)
      ? `${Math.round(forecast.recent.confidence * 100)}/100`
      : "未知";
  const speedRatio = forecast?.projection?.speedRatio;
  const comparison =
    typeof speedRatio === "number" && Number.isFinite(speedRatio)
      ? `当前速度约为可持续速度的 ${speedRatio.toFixed(2)} 倍。`
      : "";
  const sustainable =
    forecast?.state === "expired"
      ? "周期已结束"
      : rateText(forecast?.projection?.sustainableRatePercentPerHour);
  const capNote = forecast?.projection?.exhaustsBeforeReset
    ? "重置时预计值可超过 100% 以保留消耗节奏信息，实际额度仍以 100% 封顶。"
    : "";
  return `<section class="quota-forecast"><div class="card-head"><div><p class="quota-provider">OBSERVED FORECAST</p><h3>本周期趋势预测</h3></div><span class="badge quota-status ${statusClass}">${label}</span></div><div class="forecast-metrics"><div><span>近段消耗速度</span><strong>${rateText(forecast?.recent?.ratePercentPerHour)}</strong></div><div><span>预计重置时已用</span><strong>${projectedPercentText(forecast)}</strong></div><div><span>预计耗尽时间</span><strong>${exhaustionText(forecast)}</strong></div><div><span>可持续消耗速度</span><strong>${sustainable}</strong></div></div><p class="small">${esc(forecastReason(forecast))} 趋势评分 ${trendScore}（依据样本覆盖与拟合，不是准确率）。${esc(paceExplanation(forecast))} ${esc(comparison)} ${esc(capNote)}</p>${note("预测只使用当前账号、额度类别、窗口时长和重置时间完全一致的观测周期；跨设备完整趋势请查看云端“周期用量”。")}</section>`;
}
function currentWindowForecastHtml(quota, window) {
  const cycle = matchingQuotaCycle(quota, window);
  if (!cycle)
    return `<section class="quota-forecast">${percent(window.usedPercent) === 0 ? empty("已同步，尚无非零消耗观测", "当前窗口仍为 0%，有新的非零观测后再计算趋势。跨设备趋势请查看云端“周期用量”。") : empty("样本不足", "尚无与当前账号、额度类别、窗口时长和重置时间完全一致的开放周期。跨设备趋势请查看云端“周期用量”。")}</section>`;
  return forecastMetricsHtml(forecastQuotaCycle(cycle));
}
function isOfficialQuota(quota) {
  const connection = state.quotaConnection || {};
  const source = String(quota.source || "").toLowerCase();
  return (
    (connection.accountKey && connection.accountKey === quota.accountKey) ||
    source === "codex-app-server" ||
    source.includes("official") ||
    source.includes("官方")
  );
}
function quotaWindowHtml(window, current, quota) {
  const used = percent(window.usedPercent);
  const remaining = percent(window.remainingPercent);
  const reset = window.resetsAt && new Date(window.resetsAt).getTime();
  const live = current && (!reset || reset > Date.now());
  return `<div class="quota-window ${live ? "" : "quota-window-history"}"><div class="quota-window-title"><div><strong>${esc(window.name || "未命名窗口")}</strong><span>${esc(durationText(window.windowMinutes))}</span></div><span class="quota-window-state">${live ? "当前观测" : "最后观测"}</span></div><div class="quota-numbers"><div><strong>${percentText(used)}</strong><span>${live ? "已用" : "最后观测已用"}</span></div><div><strong>${percentText(remaining)}</strong><span>${live ? "剩余" : "最后观测剩余"}</span></div></div>${used == null ? "" : `<progress max="100" value="${used}" aria-label="${esc(window.name || "额度窗口")} 已用百分比"></progress>`}<p class="small quota-reset"><span>${esc(countdown(window.resetsAt))}</span><span>${window.resetsAt ? date(window.resetsAt) : "未提供重置时间"}</span></p>${live ? currentWindowForecastHtml(quota, window) : ""}</div>`;
}
function quotaCard(quota) {
  const official = isOfficialQuota(quota);
  const current =
    official &&
    quotaConnectionStatus(state.quotaConnection) === "fresh" &&
    quotaIsCurrent(quota);
  const snapshotLabel = String(quota.source || "").startsWith("codexbar:")
    ? "附加来源"
    : official
      ? "旧快照"
      : "回退快照";
  const title =
    quota.limitName || quota.limitId || quota.provider || "额度窗口";
  return `<article class="card quota-card ${current ? "" : "quota-card-history"}"><div class="card-head"><div><p class="quota-provider">${esc(quota.provider || "Codex")}</p><h2>${esc(title)}</h2></div><span class="badge quota-status ${current ? "fresh" : "stale"}">${current ? "当前额度" : snapshotLabel}</span></div><p class="quota-account">${esc(accountText(quota))}</p><div class="quota-meta"><span>${esc(quota.source || "来源未知")}</span>${quota.planType ? `<span>${esc(quota.planType)}</span>` : ""}${quota.limitId && quota.limitName ? `<span>额度类别 ${esc(quota.limitId)}</span>` : ""}</div>${(quota.windows || []).map((window) => quotaWindowHtml(window, current, quota)).join("") || empty("暂时没有窗口记录", "刷新官方额度，或稍后再次扫描本机。")}<p class="small quota-recorded">记录时间：${date(quota.updatedAt)}</p>${quota.note ? note(quota.note) : ""}</article>`;
}
function officialUsageHtml() {
  const usage = state.officialUsage;
  if (!usage)
    return `<section class="card quota-section"><div class="card-head"><div><p class="quota-provider">OFFICIAL USAGE</p><h2>官方每日 Tokens</h2></div></div>${empty("尚未读取官方每日用量", "登录 Codex 后刷新官方额度。每日数据不会按额度周期裁切，也不会把缺失日期填为 0。")}</section>`;
  const matchedQuota = (state.quotas || []).find(
    (quota) => quota.accountKey && quota.accountKey === usage.accountKey,
  );
  const usageAccount = {
    ...usage,
    account: matchedQuota?.account || usage.account || undefined,
  };
  const buckets = Array.isArray(usage.dailyUsageBuckets)
    ? usage.dailyUsageBuckets.filter(
        (bucket) =>
          bucket &&
          bucket.startDate &&
          typeof bucket.tokens === "number" &&
          Number.isFinite(bucket.tokens),
      )
    : null;
  const rows = buckets
    ? [...buckets].sort((a, b) =>
        String(a.startDate).localeCompare(String(b.startDate)),
      )
    : [];
  const shown = officialUsageExpanded ? rows : rows.slice(-14);
  const updated = new Date(usage.updatedAt).getTime();
  const age = Date.now() - updated;
  const fresh =
    usage.status === "observed" &&
    quotaConnectionStatus(state.quotaConnection) === "fresh" &&
    Number.isFinite(age) &&
    age >= -2 * 60000 &&
    age <= 15 * 60000;
  const unavailable = usage.status === "unavailable" && !rows.length;
  const usageClass = fresh ? "fresh" : unavailable ? "unavailable" : "stale";
  const usageLabel = fresh ? "已观测" : unavailable ? "不可用" : "历史观测";
  return `<section class="card quota-section"><div class="card-head"><div><p class="quota-provider">OFFICIAL USAGE</p><h2>官方每日 Tokens</h2></div><span class="badge quota-status ${usageClass}">${usageLabel}</span></div><p class="small">${esc(accountText(usageAccount))} · 记录时间 ${date(usage.updatedAt)}</p><p class="quota-boundary">${fresh ? "按官方返回的日期独立展示" : "以下为已保留的官方历史观测"}；不按额度周期裁切，不补齐缺失日期，也不推断所属额度类别。</p>${usage.error ? `<p class="notice error">${esc(usage.error)}</p>` : ""}${rows.length ? `<div class="official-days" role="list">${shown.map((bucket) => `<div role="listitem"><time datetime="${esc(bucket.startDate)}">${esc(bucket.startDate)}</time><strong>${num(bucket.tokens)} <span>Tokens</span></strong></div>`).join("")}</div>${rows.length > 14 ? button(officialUsageExpanded ? "收起到最近 14 条" : `展开全部 ${rows.length} 条`, "official-usage-toggle") : ""}` : empty("官方未返回每日 Tokens", "此处保持缺失状态，不会将未知日期显示为 0。")}${usage.summary == null ? "" : `<details><summary>查看官方摘要</summary><pre>${typeof usage.summary === "string" ? esc(usage.summary) : json(usage.summary)}</pre></details>`}</section>`;
}
function quotaHistoryHtml() {
  const cycles = (state.quotaHistory?.cycles || [])
    .slice(0, 200)
    .map((cycle) => ({ ...cycle, resetsAt: cycleEndAt(cycle) }));
  if (!cycles.length) {
    const officialWindows = (state.quotas || [])
      .filter(isOfficialQuota)
      .flatMap((quota) => quota.windows || []);
    const syncedZero =
      quotaConnectionStatus(state.quotaConnection) === "fresh" &&
      officialWindows.length > 0 &&
      officialWindows.every((window) => percent(window.usedPercent) === 0);
    return `<section class="card quota-section"><div class="card-head"><div><p class="quota-provider">OBSERVED CYCLES</p><h2>周期历史</h2></div></div>${empty(syncedZero ? "已同步，尚无非零消耗观测" : "尚无周期历史", syncedZero ? "当前官方窗口仍为 0%，后续出现非零观测后会形成可分析的趋势。" : "刷新官方额度后，UsageMesh 会按账号、额度类别和窗口分别保留观测周期。")}${note("周期边界由重置时间与窗口时长推算，并非核实的实际重置时刻。跨设备聚合请查看云端“周期用量”。")}</section>`;
  }
  return `<section class="card quota-section"><div class="card-head"><div><p class="quota-provider">OBSERVED CYCLES</p><h2>周期历史</h2></div><span class="small">最近 ${num(cycles.length)} 个周期</span></div><p class="quota-boundary">分别按账号、额度类别和窗口保存。百分比不能跨窗口相加；已结束周期仅展示最后一次实际观测，不补成 100% 或 0%。</p><label class="cycle-picker">选择周期并读取同期本机明细<select id="quota-cycle-select"><option value="">请选择账号 / 额度类别 / 窗口</option>${cycles.map((cycle) => `<option value="${esc(cycle.id)}">${esc(`${accountText(cycle)} · ${cycle.limitName || cycle.limitId || "额度类别"} · ${cycle.windowName || "窗口"} · ${percentText(cycle.lastUsedPercent)}`)}</option>`).join("")}</select></label><div class="table-wrap cycle-table"><table><thead><tr><th>账号 / 额度类别</th><th>窗口</th><th>观测范围</th><th>最后观测</th><th>状态</th><th></th></tr></thead><tbody>${cycles.map((cycle) => `<tr><td><strong>${esc(accountText(cycle))}</strong><div class="small">${esc(cycle.limitName || cycle.limitId || "额度类别未命名")}${cycle.limitId && cycle.limitName ? ` · ${esc(cycle.limitId)}` : ""}</div></td><td>${esc(cycle.windowName || "未命名窗口")}<div class="small">${esc(durationText(cycle.windowMinutes))}</div></td><td>${date(Number(cycle.segment) > 0 ? cycle.firstObservedAt : cycle.nominalStartAt)}<div class="small">至 ${date(cycle.resetsAt)}${Number(cycle.segment) > 0 ? " · 重置或额度调整后" : " · 推算边界"}</div></td><td><strong>${percentText(cycle.lastUsedPercent)}</strong><div class="small">${date(cycle.lastObservedAt)}</div></td><td>${esc(cycleReason(cycle))}</td><td>${button("查看同期记录", "quota-cycle", cycle.id)}</td></tr>`).join("")}</tbody></table></div>${note("周期起点由重置时间减去窗口时长推算，并非核实的实际重置时刻。出现百分比下降或提前重置时，记录为“重置或额度调整”。跨设备聚合请查看云端“周期用量”。")}</section>`;
}
function toast(message, error = false) {
  const el = $("#status");
  if (el) {
    el.textContent = message;
    el.classList.toggle("error", error);
  }
}
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  let v;
  try {
    v = await response.json();
  } catch {
    throw Error("本地服务未返回有效数据，请查看终端。");
  }
  if (!response.ok) {
    if (response.status === 401) {
      token = "";
      try {
        sessionStorage.removeItem("usagemesh-local-token");
      } catch {}
    }
    throw Error(v.error || "请求失败");
  }
  return v;
}
async function refresh() {
  state = await api("state");
  render();
}
function login() {
  $("#app").innerHTML =
    `<main class="login card"><div class="brand-mark">U</div><p class="eyebrow">YOUR LOCAL WORKSPACE</p><h1>连接本地工作台</h1><p>使用 <code>usagemesh serve</code> 启动后，打开终端显示的完整链接。也可在下方粘贴该链接。</p><form id="connect-form">${field("启动链接或访问凭据", "token", "", "password", 'required autocomplete="off" spellcheck="false"')}<button class="primary">连接工作台</button></form><p id="status" role="status" aria-live="polite"></p>${note("凭据仅在本次本地服务中有效。此页面不会上传配置或密钥。")}</main>`;
  $("#connect-form").onsubmit = async (e) => {
    e.preventDefault();
    const raw = new FormData(e.target).get("token").trim();
    try {
      token = raw.startsWith("http")
        ? new URLSearchParams(new URL(raw).hash.slice(1)).get("token")
        : raw;
      if (!token) throw Error("链接中缺少访问凭据");
      await refresh();
      try {
        sessionStorage.setItem("usagemesh-local-token", token);
      } catch {}
    } catch (err) {
      toast(err.message, true);
    }
  };
}
function render() {
  const [title, subtitle] = sections[section];
  $("#app").innerHTML =
    `<aside><a class="brand" href="#" data-action="home"><span class="brand-mark">U</span><span>UsageMesh<small>本地工作台</small></span></a><nav aria-label="工作区">${Object.entries(
      sections,
    )
      .map(
        ([id, [name]]) =>
          `<button data-action="navigate" data-id="${id}" ${section === id ? 'aria-current="page"' : ""}>${icons[id] || ""}<span>${name}</span></button>`,
      )
      .join(
        "",
      )}</nav><div class="sidebar-foot"><span class="live">仅本机访问</span><small>v${esc(state.version)} · ${esc(state.platform)}</small>${button("锁定页面", "lock")}</div></aside><main><div class="local-toolbar"><label class="nav-search">${icons.search}<input id="nav-search" type="search" aria-label="搜索功能" placeholder="搜索功能"></label><div class="actions">${button("提醒", "navigate", "notifications")}${button("外观", "theme")}</div></div><header ${section === "guide" ? 'class="local-guide-header"' : ""}><div><p class="eyebrow">YOUR USAGE. YOUR WORKSPACE.</p><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${button("刷新数据", "refresh")}${button("扫描本机", "scan", "", 'class="primary"')}</div></header><div id="status" role="status" aria-live="polite"></div>${state.scanError ? `<p class="notice error">${esc(state.scanError)}</p>` : ""}<section id="content">${views[section]()}</section><footer><span>配置与密钥仅保留本机 · 官方周期随加密账本同步 · ${state.activity?.updatedAt ? "上次扫描 " + date(state.activity.updatedAt) : "尚未扫描"}</span><div class="actions">${button("切换主题", "theme")}${button(document.documentElement.classList.contains("large") ? "标准字号" : "大字号", "font")}</div></footer></main><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
}
const sessions = () => state.activity?.sessions || [];
const projectName = (id) =>
  state.settings.projects[id]?.alias ||
  sessions().find((s) => s.projectId === id)?.project ||
  "未识别项目";
function metrics(items) {
  return `<div class="metrics">${items.map(([label, value, desc]) => `<div class="card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(desc || "")}</small></div>`).join("")}</div>`;
}
const views = {
  overview() {
    const daily = state.activity?.daily || {};
    const month = new Date().toLocaleDateString("sv-SE").slice(0, 7);
    const cost = Object.entries(daily)
      .filter(([d]) => d.startsWith(month))
      .reduce((s, [, v]) => s + v, 0);
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = new Date();
      day.setDate(day.getDate() - 6 + i);
      const key = day.toLocaleDateString("sv-SE");
      return [key, Number(daily[key] || 0)];
    });
    const max = Math.max(...days.map(([, v]) => v), 0.01);
    return `<div class="local-today"><section class="daily-chart"><h2>7 天费用趋势</h2><p class="small">本机兼容价卡估算 · 非实际账单</p>${state.activity?.updatedAt ? `<div class="daily-bars">${days.map(([d, v]) => `<div><span>${esc(d.slice(5))}</span><meter min="0" max="${max}" value="${v}" aria-label="${esc(d)} 估算费用 ${money(v)}"></meter><strong>${money(v)}</strong></div>`).join("")}</div>` : empty("尚未扫描本机", "点击扫描后查看最近 7 天的费用变化。")}</section>${metrics(
      [
        ["本月估算费用", money(cost), "本机记录"],
        [
          "项目",
          new Set(sessions().map((s) => s.projectId)).size,
          "最近 90 天",
        ],
        ["会话", num(sessions().length), "按来源会话 ID 汇总"],
        ["渠道事件", num(state.events.length), "探测与导入"],
      ],
    )}</div><h2 class="region-heading">近期概览</h2><div class="recent-grid"><article class="card"><h2>最近会话</h2>${
      sessions()
        .slice(0, 5)
        .map(
          (s) =>
            `<div class="recent-row"><div><strong>${esc(projectName(s.projectId))}</strong><small>${esc(s.client)} · ${date(s.lastAt)}</small></div><span>${s.lowerBound ? "≥ " : ""}${money(s.cost)}</span></div>`,
        )
        .join("") || empty("暂无会话")
    }${button("查看全部", "navigate", "projects")}</article><article class="card"><h2>供应商方案</h2>${
      state.settings.providers
        .slice(0, 5)
        .map(
          (p) =>
            `<div class="recent-row"><div><strong>${esc(p.name)}</strong><small>${esc(p.tool)} · ${esc(p.model)}</small></div></div>`,
        )
        .join("") || empty("尚未保存方案", "新增方案后可预览、应用和回滚。")
    }${button("管理方案", "navigate", "providers")}</article><article class="card"><h2>运行状态</h2><dl><dt>自动扫描</dt><dd>每 ${state.settings.preferences.scanMinutes} 分钟</dd><dt>系统通知</dt><dd>${state.settings.preferences.notifications ? "已启用" : "未启用"}</dd><dt>数据目录</dt><dd class="path">${esc(state.dataDir)}</dd></dl>${note("关闭浏览器后服务仍运行；终止 serve 后，扫描和通知停止。")}${button("提醒设置", "navigate", "notifications")}</article></div>${note(state.activity?.note || "配置与密钥仅保留本机；官方周期随加密账本同步。")}`;
  },
  guide() {
    const chapters = [
      [
        "start",
        "快速开始",
        "点击扫描本机读取最近 90 天的客户端用量。工作台不需要 GitHub 登录；云端面板继续负责跨设备加密汇总。",
      ],
      [
        "quota",
        "额度来源",
        "登录 Codex 后可手动刷新官方实时额度；UsageMesh 不会自动发起登录。当前额度按账号、额度类别和动态窗口分别显示，过期记录只作为旧快照。周期明细中的 Tokens 是同期本机官方订阅记录，无法归属到某个账号或额度类别；跨设备聚合请查看云端“周期用量”。CodexBar 仍是可选附加来源。",
      ],
      [
        "projects",
        "项目与会话",
        "可按项目搜索、设置别名和标签，并查看会话、请求及导出 CSV。费用为价卡估算，≥ 表示费用下界，未知字段不会填入推测值。",
      ],
      [
        "providers",
        "配置管理",
        "先保存供应商方案，再预览修改内容。确认应用会创建本机备份；回滚遇到外部修改会拒绝覆盖。凭据填写环境变量名，Claude 应用时会把值写入其本机配置。",
      ],
      [
        "connectors",
        "渠道与代理",
        "连接测试默认只读取模型目录，生成测试需要主动勾选。导入日志与探测分别统计。代理连接器仅读取账号元数据或模型目录。",
      ],
      [
        "notifications",
        "通知与隐私",
        "预算、费用突增和额度阈值提醒仅在 serve 运行期间生效。关闭浏览器不会停止服务。配置备份可能包含原有凭据，仅保存在本机私有目录。",
      ],
    ];
    return `<article class="guide-page"><h2>本地工作台使用指南</h2><p class="guide-meta">${chapters.length} 个章节 · UsageMesh ${esc(state.version)}</p><p class="guide-intro">从查看本机用量，到管理供应商配置，了解每项功能的操作方式与数据边界。</p><div class="guide-layout"><nav aria-label="指南目录"><strong>目录</strong>${chapters.map(([id, title], i) => `<a href="#chapter-${id}" data-action="chapter" data-id="${id}">${i + 1}. ${title}</a>`).join("")}</nav><div>${chapters.map(([id, title, body], i) => `<section id="chapter-${id}"><h3><span>${i + 1}</span>${title}</h3><div class="guide-copy"><p>${body}</p>${id === "start" ? "<pre>usagemesh serve</pre>" : ""}</div></section>`).join("")}</div></div></article>`;
  },
  quota() {
    const connection = state.quotaConnection || {};
    const [connectionLabel, connectionClass] = quotaConnectionCopy(connection);
    const connectionStatus = quotaConnectionStatus(connection);
    const quotas = state.quotas || [];
    const current = quotas.filter(
      (quota) =>
        connectionStatus === "fresh" &&
        isOfficialQuota(quota) &&
        quotaIsCurrent(quota),
    );
    const snapshots = quotas.filter((quota) => !current.includes(quota));
    const fallback = connectionStatus !== "fresh";
    return `<section class="card quota-connection ${connectionClass}"><div><div class="card-head"><div><p class="quota-provider">CODEX OFFICIAL</p><h2>官方实时额度</h2></div><span class="badge quota-status ${connectionClass}">${connectionLabel}</span></div><p>${connectionStatus === "fresh" ? "官方额度连接有效。刷新会读取当前登录账号的最新额度和官方每日 Tokens。" : "官方实时额度当前不可用。下方已采集的本机日志或 CodexBar 快照仍可查看，但旧记录不会作为当前额度。"}</p><div class="quota-meta"><span>最近尝试 ${date(connection.lastAttemptAt)}</span><span>最近成功 ${date(connection.lastSuccessAt)}</span>${connection.accountKey ? `<span>${esc(accountText({ account: "当前账号", accountKey: connection.accountKey }))}</span>` : ""}</div>${connection.error ? `<p class="notice error">${esc(connection.error)}</p>` : ""}${fallback ? `<p class="quota-boundary">请先在终端运行 <code>codex login</code>，再点击刷新。UsageMesh 不会自动登录；失效期间仅回退展示带来源与记录时间的本机快照。</p>` : ""}</div><div class="quota-actions">${button("刷新官方额度", "quota-official", "", 'class="primary"')}</div></section><section class="quota-current"><div class="section-heading"><div><h2>当前额度</h2><p>每个账号、额度类别和窗口独立显示；百分比不能相加。</p></div></div><div class="grid two">${current.length ? current.map(quotaCard).join("") : empty("没有有效的当前额度", "登录 Codex 后刷新官方额度。旧快照会保留在下方，避免被误认为当前值。")}</div></section>${officialUsageHtml()}${quotaHistoryHtml()}<section class="quota-snapshots"><div class="section-heading"><div><h2>旧快照与附加来源</h2><p>保留原始来源和记录时间，仅供追溯。</p></div><div class="actions">${["codex", "claude", "gemini"].map((provider) => button("读取 " + provider, "quota", provider)).join("")}</div></div><div class="grid two">${snapshots.length ? snapshots.map(quotaCard).join("") : empty("暂无旧快照", "CodexBar 是可选附加来源，读取最多等待 25 秒。")}</div>${note("额度百分比以来源记录为准，不能从 Token 数推算订阅余额。过期窗口和失败连接不会升级为当前值。")}</section>`;
  },
  projects() {
    return `<div class="card"><div class="card-head"><h2>项目账本</h2>${button("导出会话 CSV", "export-sessions")}</div><label>搜索项目、标签或客户端<input id="project-search" type="search" placeholder="搜索本机记录"></label><div id="projects-table">${projectTable("")}</div></div>${note(state.activity?.note || "请先扫描本机。")}`;
  },
  providers() {
    return `<div class="card"><div class="card-head"><h2>供应商方案</h2>${button("新增方案", "new-provider", "", 'class="primary"')}</div>${note("保存方案不会立即切换。密钥只保存环境变量名；应用到 Claude Code 时会将对应密钥写入其本机设置，页面始终脱敏显示。")}<div class="stack">${state.settings.providers.map((p) => `<article class="item"><div><strong>${esc(p.name)}</strong><p class="small">${esc(p.tool)} · ${esc(p.model)}<br>${esc(p.baseUrl)}<br>凭据：${esc(p.keyEnv || (p.tool === "claude" ? "保留已有配置凭据" : "未指定（用于无需认证的本地接口）"))}</p></div><div class="actions">${button("预览并应用", "preview", p.id)}${button("连接测试", "probe", p.id)}${button("编辑", "edit-provider", p.id)}${button("删除方案", "delete-provider", p.id)}</div></article>`).join("") || empty("还没有供应商方案", "新增后可测试连接，并预览配置差异。")}</div></div><div class="grid two">${state.tools.map((t) => `<article class="card"><h2>${esc(t.tool)} 当前设置</h2><p class="path small">${esc(t.path)}</p>${t.error ? note(t.error) : `<details><summary>${t.exists ? "查看脱敏配置" : "配置尚不存在"}</summary><pre>${json(t.config)}</pre></details>`}</article>`).join("")}</div><div class="card"><h2>配置备份与回滚</h2>${note("只在当前文件仍与该次应用结果一致时允许回滚，避免覆盖其他工具的修改。备份仅保存在本机。")}<div class="stack">${state.backups.map((b) => `<div class="item"><span>${esc(b.tool)} · ${date(b.at)}</span>${button("回滚此更改", "rollback", b.id)}</div>`).join("") || empty("暂无备份", "每次应用前自动创建。")}</div></div>`;
  },
  quality() {
    return `<div class="card"><div class="card-head"><h2>渠道观测</h2><div class="actions">${button("导入 JSON", "import-events")}${button("导出事件", "export-events")}</div></div>${note("主动探测记录响应头耗时；导入记录的 latencyMs 由日志生产者定义。两种来源分开统计。HTTP 0 表示网络失败；缺少 retry 时保持未知。")}${qualityTable()}<details><summary>导入格式与约束</summary><pre>${json([{ id: "unique-request-id", channel: "My provider", status: 200, latencyMs: 430, at: "2026-09-07T09:00:00Z", retry: false }])}</pre>${note("JSON 数组，最大 2MB、10000 条；按 id 去重，只保留这些字段。不要上传提示词、响应内容或密钥。")}</details></div>`;
  },
  connectors() {
    return `<div class="card"><div class="card-head"><h2>已有代理服务</h2>${button("添加连接器", "new-connector", "", 'class="primary"')}</div><p>连接 CLIProxyAPI 的账号元数据，或 LiteLLM / OpenAI 兼容接口的模型目录。</p>${note("只读访问。不会创建代理内核、切换账号或下载认证文件。管理密钥通过服务进程环境变量引用。")}<div class="stack">${state.settings.connectors.map((c) => `<article class="item"><div><strong>${esc(c.name)}</strong><p class="small">${esc(c.kind)} · ${esc(c.baseUrl)}</p></div><div class="actions">${button("读取目录", "inspect", c.id)}${button("编辑", "edit-connector", c.id)}${button("删除", "delete-connector", c.id)}</div></article>`).join("") || empty("尚未连接代理", "先在本机启动已有代理，再填入接口地址。")}</div></div>`;
  },
  notifications() {
    const p = state.settings.preferences;
    return `<div class="card"><h2>通知与扫描</h2><form id="preferences" class="grid two"><label class="check"><input name="notifications" type="checkbox" ${p.notifications ? "checked" : ""}> 启用系统通知</label><div></div>${field("本月预算（USD，0 为关闭）", "monthlyBudget", p.monthlyBudget, "number", 'min="0" step="0.01" required')}${field("额度使用提醒（%）", "quotaThreshold", p.quotaThreshold, "number", 'min="1" max="100" required')}${field("同一提醒冷却（分钟）", "cooldownMinutes", p.cooldownMinutes, "number", 'min="1" max="1440" required')}${field("自动扫描间隔（分钟）", "scanMinutes", p.scanMinutes, "number", 'min="1" max="60" required')}${field("费用突增倍数", "spikeFactor", p.spikeFactor, "number", 'min="1.1" max="20" step="0.1" required')}<div class="actions"><button class="primary">保存设置</button>${button("测试系统通知", "notify-test")}</div></form>${note("费用突增与前 7 天日均比较，日均至少 $1 才触发。仅新鲜且未过期的额度快照用于提醒。项目预算在项目账本内设置。系统勿扰可能阻止通知显示。")}</div><div class="card"><h2>最近提醒</h2>${
      state.alerts.length
        ? `<div class="stack">${[...state.alerts]
            .reverse()
            .map(
              (a) =>
                `<article class="item"><div><strong>${esc(a.message)}</strong><p class="small">${date(a.at)} · ${a.state === "active" ? "达到阈值" : "状态变化"} · ${a.notified ? "已发送系统通知" : "仅工作台记录"}</p></div></article>`,
            )
            .join("")}</div>`
        : empty("暂无提醒", "服务运行期间按设置检查，不满足阈值时不会打扰。")
    }</div>`;
  },
};
function projectTable(query) {
  const groups = new Map();
  for (const s of sessions()) {
    const id = s.projectId;
    let p = groups.get(id) || {
      id,
      name: projectName(id),
      cost: 0,
      month: 0,
      tokens: 0,
      count: 0,
      clients: new Set(),
      lower: false,
    };
    p.cost += s.cost;
    p.month += s.monthCost;
    p.tokens += s.tokens;
    p.count++;
    p.clients.add(s.client);
    p.lower ||= s.lowerBound;
    groups.set(id, p);
  }
  const rows = [...groups.values()].filter((p) =>
    (
      p.name +
      " " +
      [...p.clients] +
      " " +
      (state.settings.projects[p.id]?.tags || [])
    )
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>会话</th><th>Token</th><th>本月估算</th><th>90 天估算</th><th>操作</th></tr></thead><tbody>${rows.map((p) => `<tr><td><strong>${esc(p.name)}</strong><div class="small">${esc([...p.clients].join(" · "))}</div><div class="small">${esc((state.settings.projects[p.id]?.tags || []).join(" · "))}</div></td><td>${num(p.count)}</td><td>${num(p.tokens)}</td><td>${money(p.month)}${state.settings.projects[p.id]?.budget ? ` / ${money(state.settings.projects[p.id].budget)}` : ""}</td><td>${p.lower ? "≥ " : ""}${money(p.cost)}</td><td><div class="actions">${button("会话", "sessions", p.id)}${button("设置", "project", p.id)}</div></td></tr>`).join("")}</tbody></table></div>`
    : empty("没有匹配的项目", "扫描本机记录，或尝试其他搜索词。");
}
function qualityTable() {
  const groups = new Map();
  for (const e of state.events) {
    const source =
        e.kind === "imported"
          ? "导入请求"
          : e.kind === "generation-probe"
            ? "生成探测"
            : "模型目录探测",
      key = JSON.stringify([e.channel, source]);
    let g = groups.get(key) || { channel: e.channel, source, rows: [] };
    g.rows.push(e);
    groups.set(key, g);
  }
  return groups.size
    ? `<div class="table-wrap"><table><thead><tr><th>渠道 / 来源</th><th>事件数</th><th>错误率</th><th>P50 / P95</th><th>限流</th><th>重试</th></tr></thead><tbody>${[
        ...groups.values(),
      ]
        .map((g) => {
          const a = g.rows,
            times = a.map((r) => Number(r.latencyMs)).sort((a, b) => a - b),
            pct = (p) =>
              Math.round(times[Math.max(0, Math.ceil(times.length * p) - 1)]),
            known = a.filter((r) => typeof r.retry === "boolean");
          return `<tr><td>${esc(g.channel)}<div class="small">${g.source}</div></td><td>${a.length}</td><td>${((100 * a.filter((r) => r.status === 0 || r.status >= 400).length) / a.length).toFixed(1)}%</td><td>${pct(0.5)} / ${pct(0.95)} ms</td><td>${a.filter((r) => r.status === 429).length}</td><td>${known.length ? known.filter((r) => r.retry).length + " / " + known.length + " 已知" : "未知"}</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : empty("还没有渠道事件", "在供应商配置中测试连接，或导入结构化请求日志。");
}
function modal(title, html) {
  const d = $("#dialog");
  d.innerHTML = `<div class="card-head"><h2 id="dialog-title">${esc(title)}</h2>${button("关闭", "close")}</div>${html}`;
  d.showModal();
}
function providerForm(p = {}) {
  modal(
    p.id ? "编辑供应商" : "新增供应商",
    `<form id="provider-form"><input type="hidden" name="id" value="${esc(p.id || crypto.randomUUID())}"><div class="grid two">${field("方案名称", "name", p.name || "", "", 'required maxlength="100"')}${select(
      "工具",
      "tool",
      [
        ["codex", "Codex"],
        ["claude", "Claude Code"],
      ],
      p.tool || "codex",
    )}${field("接口地址", "baseUrl", p.baseUrl || "https://api.openai.com/v1", "url", "required")}${field("模型 ID", "model", p.model || "", "", 'required maxlength="150"')}${field("凭据环境变量名（可选）", "keyEnv", p.keyEnv || "", "", 'pattern="[A-Z_][A-Z0-9_]*" placeholder="例如 OPENAI_API_KEY" autocomplete="off"')}</div>${note("这里只填写变量名，不填写密钥。先在启动 serve 的终端设置变量。Codex CLI 也需要继承该变量；Claude 应用时会将值写入其私有本机设置。")}<button class="primary">保存方案</button><p class="form-error" role="alert"></p></form>`,
  );
}
function connectorForm(c = {}) {
  modal(
    c.id ? "编辑连接器" : "添加连接器",
    `<form id="connector-form"><input type="hidden" name="id" value="${esc(c.id || crypto.randomUUID())}"><div class="grid two">${field("名称", "name", c.name || "", "", 'required maxlength="100"')}${select(
      "代理类型",
      "kind",
      [
        ["cliproxy", "CLIProxyAPI"],
        ["litellm", "LiteLLM"],
        ["openai", "OpenAI 兼容"],
      ],
      c.kind || "cliproxy",
    )}${field("接口根地址", "baseUrl", c.baseUrl || "http://127.0.0.1:8317", "url", "required")}${field("密钥环境变量名（可选）", "keyEnv", c.keyEnv || "", "", 'pattern="[A-Z_][A-Z0-9_]*" autocomplete="off"')}</div>${note("CLIProxyAPI 填服务根地址；另外两类填模型接口前缀（如 http://127.0.0.1:4000/v1）。")}<button class="primary">保存连接器</button><p class="form-error" role="alert"></p></form>`,
  );
}
function download(name, body, type = "application/json") {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
let preview;
async function act(action, id) {
  if (action === "chapter") {
    document
      .getElementById("chapter-" + id)
      ?.scrollIntoView({ block: "start" });
    document
      .querySelectorAll(".guide-layout nav a")
      .forEach((a) => a.classList.toggle("active", a.dataset.id === id));
    return;
  }
  if (action === "close") return $("#dialog").close();
  if (action === "home") ((action = "navigate"), (id = "overview"));
  if (action === "navigate") {
    section = id;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (action === "lock") {
    token = "";
    try {
      sessionStorage.removeItem("usagemesh-local-token");
    } catch {}
    login();
    return;
  }
  if (action === "theme") {
    const list = ["system", "light", "dark"];
    const next =
      list[(list.indexOf(document.documentElement.dataset.theme) + 1) % 3];
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("um-local-theme", next);
    } catch {}
    toast("主题：" + { system: "跟随系统", light: "浅色", dark: "深色" }[next]);
    return;
  }
  if (action === "font") {
    document.documentElement.classList.toggle("large");
    try {
      localStorage.setItem(
        "um-local-large",
        document.documentElement.classList.contains("large"),
      );
    } catch {}
    render();
    return;
  }
  if (action === "official-usage-toggle") {
    officialUsageExpanded = !officialUsageExpanded;
    render();
    return;
  }
  if (action === "new-provider") return providerForm();
  if (action === "edit-provider")
    return providerForm(state.settings.providers.find((p) => p.id === id));
  if (action === "new-connector") return connectorForm();
  if (action === "edit-connector")
    return connectorForm(state.settings.connectors.find((c) => c.id === id));
  if (action === "project") {
    const p = state.settings.projects[id] || {
      alias: projectName(id),
      tags: [],
      budget: 0,
    };
    return modal(
      "项目设置",
      `<form id="project-form"><input type="hidden" name="id" value="${esc(id)}">${field("显示名称", "alias", p.alias, "text", 'maxlength="120"')}${field("标签（用逗号分隔）", "tags", p.tags.join(", "))}${field("本月预算（USD，0 为关闭）", "budget", p.budget, "number", 'min="0" step="0.01" required')}<button class="primary">保存项目设置</button><p class="form-error" role="alert"></p></form>`,
    );
  }
  if (action === "sessions")
    return modal(
      projectName(id) + " · 会话",
      `<div class="stack">${sessions()
        .filter((s) => s.projectId === id)
        .map(
          (s) =>
            `<div class="item"><div><strong>${esc(s.client)} · ${date(s.lastAt)}</strong><p class="small">${s.lowerBound ? "≥ " : ""}${money(s.cost)} · ${num(s.tokens)} Token · ${num(s.requests)} 消息</p></div>${button("请求明细", "requests", s.id)}</div>`,
        )
        .join("")}</div>`,
    );
  if (action === "requests") {
    const rows = (state.activity?.requests || []).filter(
      (r) => r.sessionId === id,
    );
    return modal(
      "会话请求明细",
      `${note("只展示本次保留的请求记录；消息可能由来源聚合，耗时未知时不估算。")}<div class="table-wrap"><table><thead><tr><th>时间</th><th>模型 / 渠道</th><th>Token</th><th>估算费用</th><th>源耗时</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${date(r.at)}</td><td>${esc(r.model)}<div class="small">${esc(r.provider || "未知")}</div></td><td>${num(r.tokens)}</td><td>${r.lowerBound ? "≥ " : ""}${money(r.cost)}</td><td>${r.durationMs == null ? "未知" : num(r.durationMs) + " ms"}</td></tr>`).join("")}</tbody></table></div>`,
    );
  }
  if (action === "quota-cycle") {
    const data = await api("quota/cycle", { id });
    const rawCycle = data.cycle || {};
    const forecast = forecastQuotaCycle(rawCycle);
    const cycle = { ...rawCycle, resetsAt: cycleEndAt(rawCycle) };
    const local = data.local || {};
    const models = Array.isArray(local.models) ? local.models : [];
    return modal(
      `${cycle.windowName || "额度窗口"} · 周期明细`,
      `<div class="cycle-detail-head"><div><p class="quota-provider">${esc(cycle.limitName || cycle.limitId || "额度类别")}</p><h3>${esc(accountText(cycle))}</h3></div><span class="badge quota-status ${cycleEnded(cycle) ? "stale" : "fresh"}">${esc(cycleReason(cycle))}</span></div><dl class="cycle-facts"><dt>最后观测已用</dt><dd>${percentText(cycle.lastUsedPercent)} · ${date(cycle.lastObservedAt)}</dd><dt>${Number(cycle.segment) > 0 ? "调整后观测范围" : "推算周期范围"}</dt><dd>${date(Number(cycle.segment) > 0 ? cycle.firstObservedAt : cycle.nominalStartAt)} — ${date(cycle.resetsAt)}</dd><dt>窗口时长</dt><dd>${esc(durationText(cycle.windowMinutes))}</dd></dl><p class="quota-boundary">${esc(cycleRange(cycle))}。${Number(cycle.segment) > 0 ? "此段始于一次百分比下降或窗口提前变化，统一标记为“重置或额度调整”。" : "周期起点由重置时间减去窗口时长推算，并非核实的实际重置时刻。"}</p>${quotaTrendSvg(forecast)}${forecastMetricsHtml(forecast)}<section class="local-cycle-usage"><div class="card-head"><div><p class="quota-provider">LOCAL OBSERVATION</p><h3>同期本机官方订阅记录（未归属此账号/额度）</h3></div></div><p class="quota-boundary">只统计 ${date(local.from)} — ${date(local.to)} 范围内本机已采集的 Codex 官方订阅请求。它不能证明这些 Tokens 属于上方账号、额度类别或百分比窗口。</p><div class="cycle-metrics"><div><span>Tokens</span><strong>${local.tokens == null ? "未知" : num(local.tokens)}</strong></div><div><span>请求</span><strong>${local.requests == null ? "未知" : num(local.requests)}</strong></div><div><span>保留明细</span><strong>${local.rows == null ? "未知" : num(local.rows)}</strong></div></div>${models.length ? `<div class="table-wrap"><table><thead><tr><th>模型</th><th>Tokens</th><th>请求</th></tr></thead><tbody>${models.map((model) => `<tr><td>${esc(model.model || "未知模型")}</td><td>${model.tokens == null ? "未知" : num(model.tokens)}</td><td>${model.requests == null ? "未知" : num(model.requests)}</td></tr>`).join("")}</tbody></table></div>` : empty("此范围内没有已保留的模型明细", "缺失保持未知，不会用 0 补齐。")}<p class="small">来源行 ${local.sourceRows == null ? "未知" : num(local.sourceRows)} · 保留行 ${local.retainedRows == null ? "未知" : num(local.retainedRows)}${local.truncated ? " · 明细已截断" : ""}</p>${local.note ? note(local.note) : ""}</section>`,
    );
  }
  if (action === "export-sessions") {
    return download(
      "usagemesh-sessions.csv",
      "\uFEFF" +
        [
          ["项目", "客户端", "最近活动", "Token", "估算USD", "费用下界"],
          ...sessions().map((s) => [
            projectName(s.projectId),
            s.client,
            date(s.lastAt),
            s.tokens,
            s.cost,
            s.lowerBound,
          ]),
        ]
          .map((r) => r.map(csvCell).join(","))
          .join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  if (action === "export-events")
    return download(
      "usagemesh-events.json",
      JSON.stringify(state.events, null, 2),
    );
  if (action === "import-events")
    return modal(
      "导入渠道事件",
      `<form id="events-form"><label>选择 JSON 文件<input type="file" name="file" accept=".json,application/json" required></label>${note("文件不超过 2MB。会先验证全部事件，再按 id 合并。")}<button class="primary">验证并导入</button><p class="form-error" role="alert"></p></form>`,
    );
  if (action === "probe")
    return modal(
      "连接测试",
      `<p>默认只读取模型目录。生成测试会发送“Reply OK”，可能产生少量 API 费用。</p><form id="probe-form"><input type="hidden" name="id" value="${esc(id)}"><label class="check"><input name="generate" type="checkbox"> 我选择执行一次可能计费的生成测试</label><button class="primary">执行测试</button><p class="form-error" role="alert"></p></form>`,
    );
  if (
    action === "delete-provider" ||
    action === "delete-connector" ||
    action === "rollback"
  )
    return modal(
      action === "rollback" ? "确认回滚配置" : "确认删除",
      `<p>${action === "rollback" ? "恢复这次应用之前的本机配置；如果期间有其他修改，将拒绝覆盖。" : "移除保存的方案。此操作不会修改外部工具当前配置。"}</p>${button("确认执行", "confirm-" + action, id, 'class="primary"')}`,
    );
  let result;
  if (action === "refresh") {
    await refresh();
    return toast("已刷新本地快照");
  }
  if (action === "scan") result = await api("scan", {});
  if (action === "quota-official") result = await api("quota/official", {});
  if (action === "quota") {
    result = await api("quota", { provider: id });
    result.message = "额度来源已读取";
  }
  if (action === "notify-test") result = await api("notify-test", {});
  if (action === "preview") {
    preview = await api("provider/preview", { id });
    preview.id = id;
    return modal(
      "确认配置差异",
      `<p class="path">${esc(preview.path)}</p><div class="grid two"><div><h3>当前（脱敏）</h3><pre>${json(preview.before)}</pre></div><div><h3>应用后（脱敏）</h3><pre>${json(preview.after)}</pre></div></div>${note(preview.note)}${button("备份并应用此配置", "apply", id, 'class="primary"')}`,
    );
  }
  if (action === "apply") {
    result = await api("provider/apply", {
      id,
      beforeHash: preview.beforeHash,
      afterHash: preview.afterHash,
    });
  }
  if (action === "inspect") {
    const data = await api("connector/inspect", { id });
    return modal(
      "代理目录",
      `${note(data.note)}<p class="small">${date(data.at)} · ${data.items.length} 项</p><pre>${json(data.items)}</pre>`,
    );
  }
  if (action === "confirm-delete-provider")
    result = await api("provider/delete", { id });
  if (action === "confirm-delete-connector")
    result = await api("connector/delete", { id });
  if (action === "confirm-rollback") result = await api("rollback", { id });
  if (result) {
    await refresh();
    toast(result.message || "操作已完成");
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  const originalLabel = b.textContent;
  const loadingLabels = {
    "quota-official": "正在读取官方额度…",
    "quota-cycle": "正在读取同期记录…",
    quota: "正在读取附加来源…",
  };
  b.disabled = true;
  b.setAttribute("aria-busy", "true");
  if (loadingLabels[b.dataset.action])
    b.textContent = loadingLabels[b.dataset.action];
  try {
    await act(b.dataset.action, b.dataset.id);
  } catch (err) {
    const d = $("#dialog");
    if (d?.open) {
      let el = $(".form-error", d);
      if (!el) {
        el = document.createElement("p");
        el.className = "form-error";
        el.setAttribute("role", "alert");
        d.append(el);
      }
      el.textContent = err.message;
    } else toast(err.message, true);
    if (!token) login();
  } finally {
    busy = false;
    b.disabled = false;
    b.removeAttribute("aria-busy");
    b.textContent = originalLabel;
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id !== "quota-cycle-select" || !e.target.value || busy) return;
  const picker = e.target;
  busy = true;
  picker.disabled = true;
  picker.setAttribute("aria-busy", "true");
  try {
    await act("quota-cycle", picker.value);
  } catch (err) {
    toast(err.message, true);
    if (!token) login();
  } finally {
    busy = false;
    picker.disabled = false;
    picker.removeAttribute("aria-busy");
    picker.value = "";
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "nav-search") {
    const q = e.target.value.toLowerCase();
    document
      .querySelectorAll("aside nav button")
      .forEach((b) => (b.hidden = !b.textContent.toLowerCase().includes(q)));
  }
  if (e.target.id === "project-search")
    $("#projects-table").innerHTML = projectTable(e.target.value);
});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.getAttribute("id") === "connect-form") return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  const b = $('button[type="submit"],button:not([type])', form);
  if (b) b.disabled = true;
  const error = $(".form-error", form);
  if (error) error.textContent = "";
  try {
    const d = Object.fromEntries(new FormData(form));
    let result;
    if (form.getAttribute("id") === "provider-form")
      result = await api("provider", d);
    if (form.getAttribute("id") === "connector-form")
      result = await api("connector", d);
    if (form.getAttribute("id") === "project-form")
      result = await api("project", {
        id: d.id,
        meta: {
          alias: d.alias,
          tags: d.tags
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
          budget: Number(d.budget),
        },
      });
    if (form.getAttribute("id") === "preferences")
      result = await api("preferences", {
        notifications: d.notifications === "on",
        monthlyBudget: Number(d.monthlyBudget),
        quotaThreshold: Number(d.quotaThreshold),
        cooldownMinutes: Number(d.cooldownMinutes),
        scanMinutes: Number(d.scanMinutes),
        spikeFactor: Number(d.spikeFactor),
      });
    if (form.getAttribute("id") === "events-form") {
      if (d.file.size > 2000000) throw Error("文件超过 2MB");
      result = await api("events", JSON.parse(await d.file.text()));
    }
    if (form.getAttribute("id") === "probe-form") {
      result = await api("provider/probe", {
        id: d.id,
        generate: d.generate === "on",
      });
      await refresh();
      return modal(
        "连接测试结果",
        `<p>${esc(result.message)} · HTTP ${result.status || "网络失败"}</p><p>响应头耗时 ${num(result.latencyMs)} ms</p>${result.models.length ? `<pre>${json(result.models)}</pre>` : ""}`,
      );
    }
    if (result) {
      await refresh();
      toast(result.message || "已保存");
    }
  } catch (err) {
    if (error) error.textContent = err.message;
    else toast(err.message, true);
  } finally {
    busy = false;
    if (b) b.disabled = false;
  }
});
if (token) {
  refresh().catch((err) => {
    login();
    toast(err.message, true);
  });
} else login();

window.addEventListener("hashchange", async () => {
  const next = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!next) return;
  token = next;
  history.replaceState(null, "", location.pathname);
  try {
    await refresh();
    try {
      sessionStorage.setItem("usagemesh-local-token", token);
    } catch {}
  } catch (err) {
    login();
    toast(err.message, true);
  }
});
