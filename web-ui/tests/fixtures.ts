import type {
  DashboardDataset,
  RequestRecord,
  UsageRecord,
} from "../src/lib/types";

export function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "one",
    date: "2026-09-07",
    timestampMs: new Date(2026, 8, 7, 10).getTime(),
    device: "Test Mac",
    deviceId: "aabb",
    platform: "macOS",
    architecture: "Apple Silicon",
    tool: "Codex",
    model: "test-model",
    vendor: "OpenAI",
    routeProvider: "official",
    routeType: "official",
    billingChannel: "official-api",
    rawProvider: "openai",
    tier: "Standard",
    inputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
    outputTokens: 50,
    reasoningTokens: 10,
    totalTokens: 410,
    requestsCount: 2,
    storedCost: 0.45,
    cost: 0.45,
    costLowerBound: false,
    pricingResolved: true,
    updatedAt: "2026-09-07T02:00:00Z",
    ...overrides,
  };
}
export function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  const row = record();
  return {
    ...row,
    requestCount: 1,
    reasoningEffort: "",
    agent: "",
    durationMs: null,
    ...overrides,
  };
}
export function dataset(
  overrides: Partial<DashboardDataset> = {},
): DashboardDataset {
  return {
    repo: "test/UsageMesh",
    records: [record()],
    requests: [request()],
    devices: [],
    warnings: [],
    expectedDevices: 0,
    lastSync: "2026-09-07T02:00:00Z",
    pricing: {
      source: "ledger",
      sourceUrl: "",
      updatedAt: null,
      fastMultiplier: 1,
      resolvedRows: 1,
      fallbackRows: 0,
    },
    ...overrides,
  };
}

export async function encryptedAccess(
  repo: string,
  password: string,
  keyBytes: Uint8Array,
  iterations = 310_000,
) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    nonce = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const encodedKey = Buffer.from(keyBytes).toString("base64url");
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(
        `usagemesh-dashboard-access-v1:${repo.toLowerCase()}`,
      ),
    },
    key,
    new TextEncoder().encode(encodedKey),
  );
  return {
    schemaVersion: 1,
    kind: "usagemesh-dashboard-access",
    kdf: "PBKDF2-HMAC-SHA256",
    iterations,
    algorithm: "AES-256-GCM",
    salt: Buffer.from(salt).toString("base64url"),
    nonce: Buffer.from(nonce).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
}
export async function encryptedLedger(
  hash: string,
  keyBytes: Uint8Array,
  ledger: unknown,
) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(`usagemesh-ledger-v2:${hash}`),
    },
    key,
    new TextEncoder().encode(JSON.stringify(ledger)),
  );
  return {
    schemaVersion: 2,
    kind: "usagemesh-encrypted-ledger",
    deviceHash: hash,
    algorithm: "AES-256-GCM",
    nonce: Buffer.from(nonce).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
}
