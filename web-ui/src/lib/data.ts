import type {
  UsageRecord,
  RequestRecord,
  DeviceInfo,
  DashboardDataset,
  PricingStatus,
  OfficialQuotaCycle,
  OfficialQuotaData,
  OfficialQuotaSnapshot,
  OfficialQuotaWindow,
  OfficialUsageSnapshot,
} from "./types";
import { mergeOfficialQuotaData } from "./quotaCycles";

async function applyDynamicPricing(
  records: UsageRecord[],
): Promise<PricingStatus> {
  // Device-side pricing is the accounting source of truth. Repricing aggregated
  // rows in the browser can change cache/long-context semantics and drift from
  // the same machine's CC Switch / CCB totals. Keep the signed-in dashboard on
  // the exact cost that was calculated request-by-request before encryption.
  let resolvedRows = 0;
  let fallbackRows = 0;
  for (const record of records) {
    record.cost = record.storedCost;
    record.pricingResolved = !record.costLowerBound;
    if (record.costLowerBound) fallbackRows += 1;
    else resolvedRows += 1;
  }
  return {
    source: "设备端账本 · 兼容价卡估算",
    sourceUrl:
      "https://github.com/Atingaii/UsageMesh/blob/main/docs/PRICING.md",
    updatedAt: null,
    fastMultiplier: 1.0,
    resolvedRows,
    fallbackRows,
  };
}

const RAW = "https://raw.githubusercontent.com";
const DEFAULT_REPO = "Atingaii/UsageMesh";
const ACCESS_BRANCH = "um-dashboard";
const DEVICE_INDEX_BRANCH = "um-index";
const PRESENCE_BRANCH_PREFIX = "um-presence-";
const ACCESS_AAD_PREFIX = "usagemesh-dashboard-access-v1:";
const LEDGER_AAD_PREFIX = "usagemesh-ledger-v2:";
interface AccessEnvelope {
  schemaVersion: number;
  kind: string;
  kdf: string;
  iterations: number;
  salt: string;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  updatedAt?: string;
}

interface LedgerEnvelope {
  schemaVersion: number;
  kind: string;
  deviceHash: string;
  updatedAt: string;
  algorithm: string;
  nonce: string;
  ciphertext: string;
}

interface DevicePresence {
  schemaVersion: number;
  kind: string;
  deviceHash: string;
  updatedAt: string;
  appVersion?: string;
}

interface LedgerRow {
  date?: string;
  timestampMs?: number;
  client?: string;
  provider?: string;
  upstreamVendor?: string;
  routeProvider?: string;
  routeType?: string;
  billingChannel?: string;
  model?: string;
  tier?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  messages?: number;
  costUsd?: number;
  costLowerBound?: boolean;
}

interface LedgerRequest {
  timestampMs?: number;
  client?: string;
  provider?: string;
  upstreamVendor?: string;
  routeProvider?: string;
  routeType?: string;
  billingChannel?: string;
  model?: string;
  tier?: string | null;
  reasoningEffort?: string | null;
  agent?: string | null;
  durationMs?: number | null;
  costLowerBound?: boolean;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  messages?: number;
  costUsd?: number;
}

interface Ledger {
  schemaVersion?: number;
  generatedAt?: string;
  presenceUpdatedAt?: string;
  device?: {
    id?: string;
    name?: string;
    platform?: string;
    arch?: string;
    hostname?: string;
    appVersion?: string;
  };
  rows?: LedgerRow[];
  requests?: LedgerRequest[];
  officialQuota?: unknown;
}

// Owned by one unlocked hook session, never persisted or shared globally.
export interface DashboardLoadCache {
  scope?: string;
  ledgers: Map<
    string,
    {
      envelope: LedgerEnvelope;
      ledger: Ledger;
      lastRead?: { ledger: Ledger; source: Ledger };
    }
  >;
  snapshot?: { sources: Ledger[]; dataset: DashboardDataset };
}
export function createDashboardLoadCache(): DashboardLoadCache {
  return { ledgers: new Map() };
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const valueText = value.trim();
  return valueText && valueText.length <= max ? valueText : null;
}

function dateValue(value: unknown, nullable = false): string | null {
  if (nullable && value == null) return null;
  const valueText = textValue(value, 40);
  return valueText &&
    RFC3339.test(valueText) &&
    Number.isFinite(Date.parse(valueText))
    ? valueText
    : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function quotaWindow(value: unknown): OfficialQuotaWindow | null {
  const row = object(value);
  if (!row) return null;
  const name = textValue(row.name);
  const usedPercent = finiteNumber(row.usedPercent, 0, 100);
  const remainingPercent = finiteNumber(row.remainingPercent, 0, 100);
  const resetsAt = dateValue(row.resetsAt, true);
  const windowMinutes =
    row.windowMinutes == null
      ? null
      : finiteNumber(row.windowMinutes, 1, 10 * 365 * 24 * 60);
  if (!name || usedPercent == null || remainingPercent == null) return null;
  if (row.resetsAt != null && !resetsAt) return null;
  if (row.windowMinutes != null && windowMinutes == null) return null;
  return { name, usedPercent, remainingPercent, resetsAt, windowMinutes };
}

function quotaSnapshot(value: unknown): OfficialQuotaSnapshot | null {
  const row = object(value);
  if (
    !row ||
    row.provider !== "codex" ||
    row.source !== "codex-app-server" ||
    row.status !== "observed"
  )
    return null;
  const accountKey = textValue(row.accountKey);
  const account = textValue(row.account);
  const limitId = textValue(row.limitId);
  const limitName = row.limitName == null ? limitId : textValue(row.limitName);
  const planType = row.planType == null ? "unknown" : textValue(row.planType);
  const updatedAt = dateValue(row.updatedAt);
  const windows = Array.isArray(row.windows)
    ? row.windows
        .slice(0, 32)
        .map(quotaWindow)
        .filter((item): item is OfficialQuotaWindow => Boolean(item))
    : [];
  if (
    !accountKey ||
    !account ||
    !limitId ||
    !limitName ||
    !planType ||
    !updatedAt
  )
    return null;
  return {
    provider: "codex",
    source: "codex-app-server",
    accountKey,
    account,
    limitId,
    limitName,
    planType,
    updatedAt,
    status: "observed",
    windows,
  };
}

function quotaCycle(value: unknown): OfficialQuotaCycle | null {
  const row = object(value);
  if (!row) return null;
  const id = textValue(row.id);
  const accountKey = textValue(row.accountKey);
  const account = textValue(row.account);
  const limitId = textValue(row.limitId);
  const limitName = textValue(row.limitName);
  const windowName = textValue(row.windowName);
  const windowMinutes =
    row.windowMinutes == null
      ? null
      : finiteNumber(row.windowMinutes, 1, 10 * 365 * 24 * 60);
  const resetsAt = dateValue(row.resetsAt);
  const nominalStartAt = dateValue(row.nominalStartAt);
  const firstObservedAt = dateValue(row.firstObservedAt);
  const lastObservedAt = dateValue(row.lastObservedAt);
  const firstUsedPercent = finiteNumber(row.firstUsedPercent, 0, 100);
  const lastUsedPercent = finiteNumber(row.lastUsedPercent, 0, 100);
  const closedAt = dateValue(row.closedAt, true);
  const closureReason =
    row.closureReason == null ||
    row.closureReason === "reset-adjustment" ||
    row.closureReason === "window-changed"
      ? row.closureReason
      : undefined;
  const segment = finiteNumber(row.segment, 0, 10_000);
  const samples = Array.isArray(row.samples)
    ? row.samples.slice(0, 10_000).flatMap((sample) => {
        const item = object(sample);
        const at = dateValue(item?.at);
        const usedPercent = finiteNumber(item?.usedPercent, 0, 100);
        return at && usedPercent != null ? [{ at, usedPercent }] : [];
      })
    : [];
  if (
    !id ||
    !accountKey ||
    !account ||
    !limitId ||
    !limitName ||
    !windowName ||
    (row.windowMinutes != null && windowMinutes == null) ||
    !resetsAt ||
    !nominalStartAt ||
    !firstObservedAt ||
    !lastObservedAt ||
    firstUsedPercent == null ||
    lastUsedPercent == null ||
    (row.closedAt != null && !closedAt) ||
    closureReason === undefined ||
    segment == null ||
    !Number.isInteger(segment)
  )
    return null;
  return {
    id,
    accountKey,
    account,
    limitId,
    limitName,
    windowName,
    windowMinutes,
    resetsAt,
    nominalStartAt,
    firstObservedAt,
    lastObservedAt,
    firstUsedPercent,
    lastUsedPercent,
    samples,
    closedAt,
    closureReason,
    segment,
  };
}

function officialUsage(value: unknown): OfficialUsageSnapshot | null {
  const row = object(value);
  if (!row) return null;
  const accountKey = textValue(row.accountKey);
  const updatedAt = dateValue(row.updatedAt);
  const status =
    row.status === "observed" ||
    row.status === "stale" ||
    row.status === "unavailable"
      ? row.status
      : null;
  const error = row.error == null ? undefined : textValue(row.error, 500);
  let dailyUsageBuckets: OfficialUsageSnapshot["dailyUsageBuckets"] = null;
  if (Array.isArray(row.dailyUsageBuckets)) {
    dailyUsageBuckets = row.dailyUsageBuckets
      .slice(0, 4_000)
      .flatMap((bucket) => {
        const item = object(bucket);
        const startDate = textValue(item?.startDate, 10);
        const tokens = finiteNumber(item?.tokens, 0, Number.MAX_SAFE_INTEGER);
        return startDate && DATE.test(startDate) && tokens != null
          ? [{ startDate, tokens }]
          : [];
      });
  } else if (row.dailyUsageBuckets != null) {
    return null;
  }
  if (!accountKey || !updatedAt || !status || (row.error != null && !error))
    return null;
  return {
    accountKey,
    updatedAt,
    summary: row.summary ?? null,
    dailyUsageBuckets,
    status,
    ...(error ? { error } : {}),
  };
}

export function sanitizeOfficialQuota(
  value: unknown,
): OfficialQuotaData | null {
  const row = object(value);
  if (!row || row.version !== 1) return null;
  const latest = Array.isArray(row.latest)
    ? row.latest
        .slice(0, 256)
        .map(quotaSnapshot)
        .filter((item): item is OfficialQuotaSnapshot => Boolean(item))
    : [];
  const cycles = Array.isArray(row.cycles)
    ? row.cycles
        .slice(0, 10_000)
        .map(quotaCycle)
        .filter((item): item is OfficialQuotaCycle => Boolean(item))
    : [];
  const usage = officialUsage(row.officialUsage);
  return {
    version: 1,
    latest,
    cycles,
    officialUsage: usage ? [usage] : [],
  };
}

export function repoFromLocation(): string {
  const param = new URLSearchParams(location.search).get("repo");
  if (
    param &&
    /^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(param) &&
    !param.split("/").includes("..")
  )
    return param;
  const owner = location.hostname.match(/^([^.]+)\.github\.io$/i)?.[1];
  const repo = location.pathname.split("/").filter(Boolean)[0];
  if (owner && repo) return `${owner}/${repo}`;
  return DEFAULT_REPO;
}

export function b64url(value: string): Uint8Array {
  let text = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (text.length % 4) text += "=";
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

class DataReadError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

async function json<T>(url: string): Promise<T> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new DataReadError(
        `数据读取失败 (${response.status})`,
        response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status <= 599),
      );
    return (await response.json()) as T;
  } catch (error) {
    // Include response-body failures; malformed JSON and invalid envelopes are
    // deliberately not eligible for the last successful snapshot fallback.
    if (
      (error instanceof Error || error instanceof DOMException) &&
      ["TypeError", "AbortError", "TimeoutError"].includes(error.name)
    )
      throw new DataReadError(
        error.name === "TypeError" ? "网络读取失败" : "数据读取超时",
        true,
      );
    throw error;
  }
}

export async function workspaceKey(
  repo: string,
  password: string,
): Promise<string> {
  const envelope = await json<AccessEnvelope>(
    `${RAW}/${repo}/${ACCESS_BRANCH}/access.json`,
  );
  if (
    envelope.kind !== "usagemesh-dashboard-access" ||
    envelope.schemaVersion !== 1 ||
    envelope.kdf !== "PBKDF2-HMAC-SHA256" ||
    envelope.algorithm !== "AES-256-GCM"
  )
    throw new Error("Dashboard 访问配置不受支持");
  // v1 envelopes are iteration-driven: existing 310k manifests remain valid,
  // while new/changed passwords use the stronger device-side default.
  if (
    !Number.isInteger(envelope.iterations) ||
    envelope.iterations < 100_000 ||
    envelope.iterations > 5_000_000
  ) {
    throw new Error("Dashboard 访问配置的 KDF 参数无效");
  }

  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64url(envelope.salt),
      iterations: envelope.iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64url(envelope.nonce),
        additionalData: new TextEncoder().encode(
          `${ACCESS_AAD_PREFIX}${repo.toLowerCase()}`,
        ),
      },
      key,
      b64url(envelope.ciphertext),
    );
    const encoded = new TextDecoder().decode(plaintext);
    if (b64url(encoded).length !== 32) throw new Error("bad key");
    return encoded;
  } catch {
    throw new Error("Dashboard 密码不正确");
  }
}

async function loadDeviceIndex(repo: string): Promise<string[]> {
  const urls = [
    // The CLI updates this branch on every successful sync, so newly joined
    // devices become visible immediately without rebuilding GitHub Pages.
    `${RAW}/${repo}/${DEVICE_INDEX_BRANCH}/index.json`,
    // Legacy/static fallbacks keep older workspaces and transient raw GitHub
    // failures usable, but they are no longer the source of truth.
    `${RAW}/${repo}/${ACCESS_BRANCH}/device-index.json`,
    ...(!new URLSearchParams(location.search).has("repo")
      ? [new URL("device-index.json", document.baseURI).toString()]
      : []),
  ];
  for (const url of urls) {
    try {
      const index = await json<{ branches?: string[] }>(url);
      const branches = (index.branches || []).filter((branch) =>
        /^um-ledger-[a-f0-9]+$/i.test(branch),
      );
      if (Array.isArray(index.branches)) return [...new Set(branches)];
    } catch {
      // Try the static deployment fallback next.
    }
  }
  throw new Error("暂无设备索引，请先在任意设备执行 usagemesh sync");
}

async function decryptLedger(
  repo: string,
  branch: string,
  encodedKey: string,
  cache?: DashboardLoadCache,
): Promise<{ ledger: Ledger; source: Ledger; envelope: LedgerEnvelope }> {
  // The heartbeat is independent of decrypting the accounting payload. Start
  // both existing reads together so a slow heartbeat does not add a second
  // full network wait to each refresh.
  const envelopePromise = json<LedgerEnvelope>(
    `${RAW}/${repo}/${branch}/ledger.json`,
  );
  const presencePromise = json<DevicePresence>(
    `${RAW}/${repo}/${PRESENCE_BRANCH_PREFIX}${branch.slice("um-ledger-".length)}/presence.json`,
  ).catch(() => null);
  const envelope = await envelopePromise;
  if (
    envelope.kind !== "usagemesh-encrypted-ledger" ||
    envelope.schemaVersion !== 2 ||
    envelope.algorithm !== "AES-256-GCM" ||
    branch !== `um-ledger-${envelope.deviceHash}`
  )
    throw new Error(`设备账本格式不受支持 (${branch})`);
  const previous = cache?.ledgers.get(branch);
  let source: Ledger;
  if (
    previous &&
    previous.envelope.nonce === envelope.nonce &&
    previous.envelope.ciphertext === envelope.ciphertext
  ) {
    source = previous.ledger;
  } else {
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        b64url(encodedKey),
        "AES-GCM",
        false,
        ["decrypt"],
      );
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: b64url(envelope.nonce),
          additionalData: new TextEncoder().encode(
            `${LEDGER_AAD_PREFIX}${envelope.deviceHash}`,
          ),
        },
        key,
        b64url(envelope.ciphertext),
      );
      source = JSON.parse(new TextDecoder().decode(plaintext)) as Ledger;
    } catch {
      throw new Error(`设备账本解密失败 (${branch})`);
    }
  }
  // Heartbeats change independently from the encrypted usage payload. Refresh
  // them even on a cache hit, without mutating the cached accounting source.
  const ledger = { ...source };
  const presence = await presencePromise;
  if (
    presence?.kind === "usagemesh-device-presence" &&
    presence.schemaVersion === 1 &&
    presence.deviceHash === envelope.deviceHash
  )
    ledger.presenceUpdatedAt = String(presence.updatedAt || "");
  // Older devices have no presence branch; use their ledger timestamp.
  return { ledger, source, envelope };
}

function platformLabel(platform: string): string {
  const value = platform.toLowerCase();
  if (value.includes("mac")) return "macOS";
  if (value.includes("win")) return "Windows";
  if (value.includes("linux")) return "Linux";
  return platform || "Unknown";
}

function archLabel(platform: string, arch: string): string {
  const value = arch.toLowerCase();
  if (platformLabel(platform) === "macOS") {
    if (value.includes("aarch64") || value.includes("arm64"))
      return "Apple Silicon";
    if (value.includes("x86_64") || value.includes("x64")) return "Intel";
  }
  if (value.includes("aarch64") || value.includes("arm64")) return "ARM64";
  if (value.includes("x86_64") || value.includes("x64")) return "x86_64";
  return arch || "Unknown";
}

function tierLabel(value: string | null | undefined): string {
  const tier = String(value || "standard")
    .trim()
    .toLowerCase();
  if (tier === "fast") return "Fast";
  if (tier === "priority") return "Priority";
  if (tier === "standard" || tier === "default") return "Standard";
  return value ? String(value) : "Standard";
}

function normalizedRoute(row: LedgerRow): {
  provider: string;
  type: string;
  label: string;
  billing: string;
} {
  const provider = String(row.routeProvider || row.provider || "unknown")
    .trim()
    .toLowerCase();
  const type = String(row.routeType || "unknown")
    .trim()
    .toLowerCase();
  const billing = String(row.billingChannel || "unknown")
    .trim()
    .toLowerCase();
  const vendor = String(row.upstreamVendor || "")
    .trim()
    .toLowerCase();
  if (type === "official") {
    const vendorLabel = vendor
      ? vendor.replace(/^./, (c) => c.toUpperCase())
      : "";
    const label =
      billing === "official-subscription"
        ? "官方 · ChatGPT 订阅"
        : billing === "official-api"
          ? vendor === "openai"
            ? "官方 · OpenAI API"
            : `官方 API${vendorLabel ? ` · ${vendorLabel}` : ""}`
          : vendorLabel
            ? `官方 · ${vendorLabel}`
            : "官方";
    return { provider: label, type: "official", label, billing };
  }
  // Never promote a raw provider name such as `openai` to official in the browser.
  // Only the device-side local base-URL mapper may set routeType=official.
  return {
    provider: provider || "unknown",
    type: type || "unknown",
    label: String(row.routeProvider || row.provider || "未知"),
    billing,
  };
}

function toRecord(ledger: Ledger, row: LedgerRow, index: number): UsageRecord {
  const deviceId = String(
    ledger.device?.id || ledger.device?.name || "unknown-device",
  );
  const deviceName = String(
    ledger.device?.name || ledger.device?.id || "Unknown Device",
  );
  const platform = String(ledger.device?.platform || "unknown");
  const arch = String(ledger.device?.arch || "");
  const input = Number(row.input || 0);
  const output = Number(row.output || 0);
  const cacheRead = Number(row.cacheRead || 0);
  const cacheWrite = Number(row.cacheWrite || 0);
  const reasoning = Number(row.reasoning || 0);
  const route = normalizedRoute(row);
  return {
    id: `${deviceId}:${row.date || ""}:${row.client || ""}:${row.model || ""}:${index}`,
    date: String(row.date || ""),
    timestampMs: Number(row.timestampMs || 0),
    device: deviceName,
    deviceId,
    platform: platformLabel(platform),
    architecture: archLabel(platform, arch),
    tool: String(row.client || "Unknown"),
    model: String(row.model || "Unknown"),
    vendor: String(row.upstreamVendor || "Unknown"),
    routeProvider: route.provider,
    routeType: route.type,
    billingChannel: route.billing,
    rawProvider: String(row.provider || "unknown"),
    tier: tierLabel(row.tier),
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + cacheRead + cacheWrite + output + reasoning,
    requestsCount: Number(row.messages || 0),
    storedCost: Number(row.costUsd || 0),
    cost: Number(row.costUsd || 0),
    costLowerBound: Boolean(row.costLowerBound),
    pricingResolved: false,
    updatedAt: String(ledger.generatedAt || ""),
  };
}

function toRequestRecord(
  ledger: Ledger,
  row: LedgerRequest,
  index: number,
): RequestRecord {
  const deviceId = String(
    ledger.device?.id || ledger.device?.name || "unknown-device",
  );
  const deviceName = String(
    ledger.device?.name || ledger.device?.id || "Unknown Device",
  );
  const platform = String(ledger.device?.platform || "unknown");
  const arch = String(ledger.device?.arch || "");
  const timestampMs = Number(row.timestampMs || 0);
  const input = Number(row.input || 0),
    output = Number(row.output || 0);
  const cacheRead = Number(row.cacheRead || 0),
    cacheWrite = Number(row.cacheWrite || 0);
  const reasoning = Number(row.reasoning || 0);
  const route = normalizedRoute(row as LedgerRow);
  return {
    id: `${deviceId}:${timestampMs}:${row.client || ""}:${row.model || ""}:${index}`,
    timestampMs,
    date:
      timestampMs > 0 ? new Date(timestampMs).toISOString().slice(0, 10) : "",
    device: deviceName,
    deviceId,
    platform: platformLabel(platform),
    architecture: archLabel(platform, arch),
    tool: String(row.client || "Unknown"),
    model: String(row.model || "Unknown"),
    vendor: String(row.upstreamVendor || "Unknown"),
    routeProvider: route.provider,
    routeType: route.type,
    billingChannel: route.billing,
    rawProvider: String(row.provider || "unknown"),
    tier: tierLabel(row.tier),
    reasoningEffort: String(row.reasoningEffort || ""),
    agent: String(row.agent || ""),
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + cacheRead + cacheWrite + output + reasoning,
    requestCount: Math.max(1, Number(row.messages || 1)),
    cost: Number(row.costUsd || 0),
    costLowerBound: Boolean(row.costLowerBound),
  };
}

function rawDeviceIdentity(ledger: Ledger): {
  id: string;
  name: string;
  platform: string;
  arch: string;
  updatedAt: string;
  presenceAt: string;
} {
  const id = String(
    ledger.device?.id || ledger.device?.name || "unknown-device",
  );
  return {
    id,
    name: String(ledger.device?.name || ledger.device?.id || "Unknown Device"),
    platform: String(ledger.device?.platform || "unknown"),
    arch: String(ledger.device?.arch || ""),
    updatedAt: String(ledger.generatedAt || ""),
    presenceAt: String(ledger.presenceUpdatedAt || ""),
  };
}

function deviceLabelsFor(ledgers: Ledger[]): Map<string, string> {
  const identities = ledgers.map(rawDeviceIdentity);
  const counts = new Map<string, number>();
  for (const item of identities)
    counts.set(item.name, (counts.get(item.name) || 0) + 1);
  const labels = new Map<string, string>();
  for (const item of identities) {
    const compact =
      item.id.replace(/[^a-z0-9]/gi, "").slice(-8) || item.id.slice(-8);
    labels.set(
      item.id,
      (counts.get(item.name) || 0) > 1
        ? `${item.name} · ${compact}`
        : item.name,
    );
  }
  return labels;
}

export function deviceSyncStatus(
  updatedAt: string,
  now = Date.now(),
): DeviceInfo["status"] {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "offline";
  const age = Math.max(0, now - ts);
  if (age <= 3 * 60_000) return "online";
  if (age <= 10 * 60_000) return "syncing";
  return "offline";
}

function buildDeviceRows(
  ledgers: Ledger[],
  records: UsageRecord[],
  labels: Map<string, string>,
): DeviceInfo[] {
  const usage = new Map<
    string,
    { tokens: number; cost: number; requests: number; lowerBound: boolean }
  >();
  for (const row of records) {
    const item = usage.get(row.deviceId) || {
      tokens: 0,
      cost: 0,
      requests: 0,
      lowerBound: false,
    };
    item.tokens += row.totalTokens;
    item.cost += row.cost;
    item.requests += row.requestsCount;
    item.lowerBound ||= row.costLowerBound;
    usage.set(row.deviceId, item);
  }
  const total =
    [...usage.values()].reduce((sum, item) => sum + item.tokens, 0) || 1;
  return ledgers
    .map((ledger) => {
      const identity = rawDeviceIdentity(ledger);
      const item = usage.get(identity.id) || {
        tokens: 0,
        cost: 0,
        requests: 0,
        lowerBound: false,
      };
      return {
        id: identity.id,
        name: labels.get(identity.id) || identity.name,
        platform: platformLabel(identity.platform),
        architecture: archLabel(identity.platform, identity.arch),
        lastSync: identity.updatedAt,
        presenceAt: identity.presenceAt || identity.updatedAt,
        appVersion: ledger.device?.appVersion || "未知",
        totalTokens: item.tokens,
        cost: item.cost,
        costLowerBound: item.lowerBound,
        requestsCount: item.requests,
        sharePercentage: (item.tokens / total) * 100,
        status: deviceSyncStatus(identity.presenceAt || identity.updatedAt),
      };
    })
    .sort(
      (a, b) =>
        b.totalTokens - a.totalTokens ||
        a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
}

export async function loadDashboardWithKey(
  repo: string,
  key: string,
  cache?: DashboardLoadCache,
): Promise<DashboardDataset> {
  const scope = `${repo}:${key}`;
  if (cache && cache.scope !== scope) {
    cache.ledgers = new Map();
    cache.snapshot = undefined;
    cache.scope = scope;
  }
  // Detach an in-flight load from any later repo/key switch on this cache.
  const loadCache = cache ? { ...cache } : undefined;
  const branches = await loadDeviceIndex(repo);
  const settled = await Promise.allSettled(
    branches.map((branch) => decryptLedger(repo, branch, key, loadCache)),
  );
  const retained = new Map<string, Ledger>();
  const loaded = settled.flatMap<{ ledger: Ledger; source: Ledger }>(
    (item, index) => {
      if (item.status === "fulfilled") return [item.value];
      const previous = loadCache?.ledgers.get(branches[index])?.lastRead;
      if (
        previous &&
        item.reason instanceof DataReadError &&
        item.reason.transient
      ) {
        retained.set(branches[index], previous.ledger);
        return [previous];
      }
      return [];
    },
  );
  const ledgers = loaded.map((item) => item.ledger);
  if (loadCache)
    for (const branch of loadCache.ledgers.keys()) {
      if (!branches.includes(branch)) loadCache.ledgers.delete(branch);
    }
  if (branches.length && !ledgers.length) {
    const reason = settled.find((item) => item.status === "rejected");
    throw reason && reason.status === "rejected"
      ? reason.reason
      : new Error("暂无设备数据");
  }

  const sources = loaded.map((item) => item.source);
  const previous = loadCache?.snapshot;
  const unchanged =
    previous &&
    previous.sources.length === sources.length &&
    sources.every((source, index) => source === previous.sources[index]);
  const labels = deviceLabelsFor(ledgers);
  let records: UsageRecord[], requests: RequestRecord[], pricing: PricingStatus;
  let officialQuota: OfficialQuotaData | undefined;
  if (unchanged) {
    ({ records, requests, pricing, officialQuota } = previous.dataset);
  } else {
    records = ledgers.flatMap((ledger) =>
      (ledger.rows || []).map((row, index) => toRecord(ledger, row, index)),
    );
    requests = ledgers
      .flatMap((ledger) =>
        (ledger.requests || []).map((row, index) =>
          toRequestRecord(ledger, row, index),
        ),
      )
      .sort((a, b) => b.timestampMs - a.timestampMs);
    for (const record of records)
      record.device = labels.get(record.deviceId) || record.device;
    for (const request of requests)
      request.device = labels.get(request.deviceId) || request.device;
    pricing = await applyDynamicPricing(records);
    officialQuota = mergeOfficialQuotaData(
      ledgers.flatMap((ledger) => {
        const value = sanitizeOfficialQuota(ledger.officialQuota);
        return value ? [value] : [];
      }),
    );
  }
  const devices = unchanged
    ? ledgers
        .map((ledger) => {
          const device = previous.dataset.devices.find(
            (item) => item.id === rawDeviceIdentity(ledger).id,
          )!;
          const presenceAt = ledger.presenceUpdatedAt || device.lastSync;
          return {
            ...device,
            presenceAt,
            status: deviceSyncStatus(presenceAt),
          };
        })
        .sort(
          (a, b) =>
            b.totalTokens - a.totalTokens ||
            a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
        )
    : buildDeviceRows(ledgers, records, labels);
  const lastSync =
    ledgers
      .map((ledger) => String(ledger.generatedAt || ""))
      .filter(Boolean)
      .sort()
      .at(-1) || "";
  const warnings = settled.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${branches[index]}：${result.reason instanceof Error ? result.reason.message : "读取失败"}${retained.has(branches[index]) ? `；正在沿用上次成功快照（账本时间 ${retained.get(branches[index])!.generatedAt || "未知"}），尚未更新` : ""}`,
        ]
      : [],
  );
  const dataset: DashboardDataset = {
    repo,
    records,
    requests,
    devices,
    pricing,
    lastSync,
    warnings,
    expectedDevices: branches.length,
    ...(retained.size
      ? {
          retainedDeviceIds: [...retained.values()].map(
            (ledger) => rawDeviceIdentity(ledger).id,
          ),
        }
      : {}),
    ...(officialQuota ? { officialQuota } : {}),
  };
  if (cache && cache.scope === scope && cache.ledgers === loadCache?.ledgers) {
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      // Publish decrypted sources only after normalization succeeds, so a
      // malformed update cannot replace the last usable accounting snapshot.
      cache.ledgers.set(branches[index], {
        envelope: result.value.envelope,
        ledger: result.value.source,
        lastRead: result.value,
      });
    });
    cache.snapshot = { sources, dataset };
  }
  return dataset;
}

export async function unlockDashboard(
  password: string,
  cache?: DashboardLoadCache,
): Promise<{ dataset: DashboardDataset; key: string }> {
  const repo = repoFromLocation();
  const key = await workspaceKey(repo, password);
  const dataset = await loadDashboardWithKey(repo, key, cache);
  return { dataset, key };
}
