// Synthetic encrypted responses for manual browser QA. Never imported by the app.
// Usage: node tests/browser-fixture.mjs /absolute/output/file.json
import { webcrypto as crypto } from "node:crypto";
import { writeFile } from "node:fs/promises";
const target = process.argv[2];
if (!target) throw new Error("Pass a disposable output JSON path.");
const repo = "fixture/UsageMesh",
  password = "ui-fixture-password";
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
const encoded = Buffer.from(keyBytes).toString("base64url");
const b64 = (value) => Buffer.from(value).toString("base64url");
const salt = crypto.getRandomValues(new Uint8Array(16));
const material = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveKey"],
);
const wrapping = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
  material,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"],
);
async function encrypt(key, aad, plaintext) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
}
const responses = {};
responses["um-dashboard/access.json"] = {
  schemaVersion: 1,
  kind: "usagemesh-dashboard-access",
  kdf: "PBKDF2-HMAC-SHA256",
  algorithm: "AES-256-GCM",
  iterations: 310_000,
  salt: b64(salt),
  ...(await encrypt(
    wrapping,
    `usagemesh-dashboard-access-v1:${repo.toLowerCase()}`,
    encoded,
  )),
};
const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
  "encrypt",
]);
const devices = [
  ["aabb", "MacBook Pro", "macos", "aarch64"],
  ["ccdd", "Windows Desktop", "windows", "x86_64"],
  ["eeff", "Linux Workstation", "linux", "x86_64"],
];
responses["um-index/index.json"] = {
  branches: devices.map(([hash]) => `um-ledger-${hash}`),
};
const now = Date.now();
for (const [d, [hash, name, platform, arch]] of devices.entries()) {
  const rows = [],
    requests = [];
  const models = [
    "gpt-5.6-sol",
    "claude-sonnet-4-6",
    "gpt-5.4",
    "claude-opus-4-6",
    "gemini-2.5-pro",
  ];
  for (let i = 0; i < 180; i++) {
    const model = models[(i + d) % models.length],
      anthropic = model.startsWith("claude");
    const date = new Date(now);
    date.setDate(date.getDate() - Math.floor(i / 6));
    date.setHours(8 + (i % 12), 15, 0, 0);
    const input = 2700 + ((i * 3147 + d * 781) % 37000),
      cacheRead = 5000 + ((i * 9193 + d * 2771) % 71000),
      output = 300 + i * 63;
    const common = {
      timestampMs: date.getTime(),
      date: date.toISOString().slice(0, 10),
      client: anthropic ? "Claude Code" : "Codex",
      model,
      upstreamVendor: anthropic ? "Anthropic" : "OpenAI",
      provider: anthropic ? "anthropic" : "openai",
      routeProvider: d === 1 ? "relay-workspace" : "official",
      routeType: d === 1 ? "relay" : "official",
      billingChannel: d === 1 ? "third-party-api" : "official-subscription",
      tier: i % 3 ? "standard" : "fast",
      input,
      cacheRead,
      cacheWrite: 1200 + ((i * 211) % 5000),
      output,
      reasoning: i % 5 ? 200 : 0,
      messages: 1,
      costUsd: Number(
        ((input * 5 + cacheRead * 0.5 + output * 30) / 1e6).toFixed(6),
      ),
      costLowerBound: i === 0 && d === 2,
    };
    rows.push(common);
    requests.push({
      ...common,
      reasoningEffort: i % 3 ? "high" : null,
      durationMs: i % 4 ? 12500 + i * 163 : null,
      agent: "coding",
    });
  }
  const generatedAt = new Date(now - d * 80_000).toISOString();
  responses[`um-ledger-${hash}/ledger.json`] = {
    schemaVersion: 2,
    kind: "usagemesh-encrypted-ledger",
    deviceHash: hash,
    algorithm: "AES-256-GCM",
    updatedAt: generatedAt,
    ...(await encrypt(
      key,
      `usagemesh-ledger-v2:${hash}`,
      JSON.stringify({
        schemaVersion: 2,
        generatedAt,
        device: { id: hash, name, platform, arch, appVersion: "2.5.0" },
        rows,
        requests,
      }),
    )),
  };
  responses[`um-presence-${hash}/presence.json`] = {
    schemaVersion: 1,
    kind: "usagemesh-device-presence",
    deviceHash: hash,
    updatedAt: new Date(now - [0, 250_000, 1_000_000][d]).toISOString(),
  };
}
await writeFile(target, JSON.stringify({ repo, password, responses }));
console.log("Synthetic encrypted browser fixture created.");
