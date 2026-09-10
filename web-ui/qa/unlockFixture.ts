// Synthetic data only. The QA page intercepts every request and never connects
// to a real workspace; the password is deliberately public test data.
export const UNLOCK_QA_REPO = "qa/UnlockDemo";
export type UnlockScenario =
  | "access-timeout"
  | "data-timeout"
  | "raw-unavailable";
const encoded = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function unlockFixture(scenario: UnlockScenario) {
  const bytes = new Uint8Array(32).fill(7);
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
  ]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("demo"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const passwordKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const seal = async (key: CryptoKey, aad: string, value: string) => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      new TextEncoder().encode(value),
    );
    return { nonce: encoded(nonce), ciphertext: encoded(ciphertext) };
  };
  const access = {
    schemaVersion: 1,
    kind: "usagemesh-dashboard-access",
    kdf: "PBKDF2-HMAC-SHA256",
    iterations: 100000,
    algorithm: "AES-256-GCM",
    salt: encoded(salt),
    ...(await seal(
      passwordKey,
      `usagemesh-dashboard-access-v1:${UNLOCK_QA_REPO.toLowerCase()}`,
      encoded(bytes),
    )),
  };
  const ledger = {
    schemaVersion: 2,
    kind: "usagemesh-encrypted-ledger",
    deviceHash: "aabb",
    algorithm: "AES-256-GCM",
    ...(await seal(
      key,
      "usagemesh-ledger-v2:aabb",
      JSON.stringify({
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        device: { id: "demo-device", name: "演示设备", platform: "macos" },
        rows: [
          { date: "2026-09-11", model: "demo-model", input: 10, costUsd: 1 },
        ],
        requests: [],
      }),
    )),
  };
  const files: Record<string, unknown> = {
    "um-dashboard/access.json": access,
    "um-index/index.json": { branches: ["um-ledger-aabb"] },
    "um-ledger-aabb/ledger.json": ledger,
  };
  const requests: string[] = [];
  let accessFailures = 0,
    ledgerFailures = 0;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(url.toString());
    const api = url.hostname === "api.github.com";
    const path = api
      ? `${url.searchParams.get("ref")}/${url.pathname.split("/contents/")[1]}`
      : url.pathname.split(`${UNLOCK_QA_REPO}/`)[1];
    if (scenario === "raw-unavailable" && !api)
      throw new TypeError("QA simulated network failure");
    if (
      scenario === "access-timeout" &&
      path === "um-dashboard/access.json" &&
      accessFailures++ < 2
    )
      throw new DOMException("QA simulated timeout", "TimeoutError");
    if (
      scenario === "data-timeout" &&
      path === "um-ledger-aabb/ledger.json" &&
      ledgerFailures++ < 2
    )
      throw new DOMException("QA simulated timeout", "TimeoutError");
    return new Response(JSON.stringify(files[path] ?? {}), {
      status: path in files ? 200 : 404,
    });
  };
  return { fetcher, requests };
}
