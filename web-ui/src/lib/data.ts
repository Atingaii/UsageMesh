import type {
  UsageRecord,
  RequestRecord,
  DeviceInfo,
  DashboardDataset,
  PricingStatus,
} from "./types";

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

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`数据读取失败 (${response.status})`);
  return response.json() as Promise<T>;
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
): Promise<Ledger> {
  const envelope = await json<LedgerEnvelope>(
    `${RAW}/${repo}/${branch}/ledger.json`,
  );
  if (
    envelope.kind !== "usagemesh-encrypted-ledger" ||
    envelope.schemaVersion !== 2 ||
    envelope.algorithm !== "AES-256-GCM" ||
    branch !== `um-ledger-${envelope.deviceHash}`
  ) {
    throw new Error(`设备账本格式不受支持 (${branch})`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    b64url(encodedKey),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  try {
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
    const ledger = JSON.parse(new TextDecoder().decode(plaintext)) as Ledger;
    try {
      const presence = await json<DevicePresence>(
        `${RAW}/${repo}/${PRESENCE_BRANCH_PREFIX}${envelope.deviceHash}/presence.json`,
      );
      if (
        presence.kind === "usagemesh-device-presence" &&
        presence.schemaVersion === 1 &&
        presence.deviceHash === envelope.deviceHash
      ) {
        ledger.presenceUpdatedAt = String(presence.updatedAt || "");
      }
    } catch {
      // Backward compatibility: pre-resident-agent devices have no presence branch.
    }
    return ledger;
  } catch {
    throw new Error(`设备账本解密失败 (${branch})`);
  }
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
): Promise<DashboardDataset> {
  const branches = await loadDeviceIndex(repo);
  const settled = await Promise.allSettled(
    branches.map((branch) => decryptLedger(repo, branch, key)),
  );
  const ledgers = settled
    .filter(
      (item): item is PromiseFulfilledResult<Ledger> =>
        item.status === "fulfilled",
    )
    .map((item) => item.value);
  if (branches.length && !ledgers.length) {
    const reason = settled.find((item) => item.status === "rejected");
    throw reason && reason.status === "rejected"
      ? reason.reason
      : new Error("暂无设备数据");
  }

  const records = ledgers.flatMap((ledger) =>
    (ledger.rows || []).map((row, index) => toRecord(ledger, row, index)),
  );
  const requests = ledgers
    .flatMap((ledger) =>
      (ledger.requests || []).map((row, index) =>
        toRequestRecord(ledger, row, index),
      ),
    )
    .sort((a, b) => b.timestampMs - a.timestampMs);
  const labels = deviceLabelsFor(ledgers);
  for (const record of records)
    record.device = labels.get(record.deviceId) || record.device;
  for (const request of requests)
    request.device = labels.get(request.deviceId) || request.device;
  const pricing = await applyDynamicPricing(records);
  const devices = buildDeviceRows(ledgers, records, labels);
  const lastSync =
    ledgers
      .map((ledger) => String(ledger.generatedAt || ""))
      .filter(Boolean)
      .sort()
      .at(-1) || "";
  const warnings = settled.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${branches[index]}：${result.reason instanceof Error ? result.reason.message : "读取失败"}`,
        ]
      : [],
  );
  return {
    repo,
    records,
    requests,
    devices,
    pricing,
    lastSync,
    warnings,
    expectedDevices: branches.length,
  };
}

export async function unlockDashboard(
  password: string,
): Promise<{ dataset: DashboardDataset; key: string }> {
  const repo = repoFromLocation();
  const key = await workspaceKey(repo, password);
  const dataset = await loadDashboardWithKey(repo, key);
  return { dataset, key };
}
