import { b64url } from "./data";

const DASHBOARD_SESSION_STORAGE = "usagemesh:dashboard-session:v2";
const DASHBOARD_SESSION_DB = "usagemesh-dashboard-session-v2";
const DASHBOARD_SESSION_STORE = "session-keys";
const DASHBOARD_SESSION_IDLE_MS = 30 * 60 * 1000;
const DASHBOARD_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

interface BrowserDashboardSession {
  version: 2;
  repo: string;
  keyId: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  lastActivityAt: number;
}

function b64urlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function openDashboardSessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DASHBOARD_SESSION_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DASHBOARD_SESSION_STORE)) {
        db.createObjectStore(DASHBOARD_SESSION_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("secure session database unavailable"));
  });
}

async function storeSessionWrappingKey(
  id: string,
  key: CryptoKey,
  createdAt: number,
): Promise<void> {
  const db = await openDashboardSessionDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DASHBOARD_SESSION_STORE, "readwrite");
      tx.objectStore(DASHBOARD_SESSION_STORE).put({ id, key, createdAt });
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error || new Error("secure session write failed"));
      tx.onabort = () =>
        reject(tx.error || new Error("secure session write aborted"));
    });
  } finally {
    db.close();
  }
}

async function loadSessionWrappingKey(id: string): Promise<CryptoKey | null> {
  const db = await openDashboardSessionDb();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(DASHBOARD_SESSION_STORE, "readonly");
      const request = tx.objectStore(DASHBOARD_SESSION_STORE).get(id);
      request.onsuccess = () =>
        resolve((request.result?.key as CryptoKey | undefined) || null);
      request.onerror = () =>
        reject(request.error || new Error("secure session read failed"));
    });
  } finally {
    db.close();
  }
}

async function deleteSessionWrappingKey(id: string): Promise<void> {
  const db = await openDashboardSessionDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DASHBOARD_SESSION_STORE, "readwrite");
      tx.objectStore(DASHBOARD_SESSION_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error || new Error("secure session delete failed"));
      tx.onabort = () =>
        reject(tx.error || new Error("secure session delete aborted"));
    });
  } finally {
    db.close();
  }
}

function readDashboardSession(): BrowserDashboardSession | null {
  try {
    const raw = sessionStorage.getItem(DASHBOARD_SESSION_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrowserDashboardSession;
    if (
      parsed?.version !== 2 ||
      !parsed.repo ||
      !parsed.keyId ||
      !parsed.iv ||
      !parsed.ciphertext
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function dashboardSessionExpired(
  session = readDashboardSession(),
): boolean {
  if (!session) return false;
  const now = Date.now();
  return (
    !Number.isFinite(session.createdAt) ||
    !Number.isFinite(session.lastActivityAt) ||
    session.createdAt > now ||
    session.lastActivityAt > now ||
    now - session.lastActivityAt >= DASHBOARD_SESSION_IDLE_MS ||
    now - session.createdAt >= DASHBOARD_SESSION_ABSOLUTE_MS
  );
}

export function touchDashboardSession(): void {
  const session = readDashboardSession();
  if (!session || dashboardSessionExpired(session)) return;
  session.lastActivityAt = Date.now();
  try {
    sessionStorage.setItem(DASHBOARD_SESSION_STORAGE, JSON.stringify(session));
  } catch {
    /* Memory-only sessions still work. */
  }
}

export async function forgetDashboardSession(): Promise<void> {
  const session = readDashboardSession();
  try {
    sessionStorage.removeItem(DASHBOARD_SESSION_STORAGE);
  } catch {
    /* Storage may be disabled. */
  }
  if (session?.keyId) {
    try {
      await deleteSessionWrappingKey(session.keyId);
    } catch {
      /* best-effort cleanup */
    }
  }
}

export async function rememberDashboardSession(
  repo: string,
  workspaceKey: string,
): Promise<void> {
  await forgetDashboardSession();
  const keyId = crypto.randomUUID();
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const now = Date.now();
  await storeSessionWrappingKey(keyId, wrappingKey, now);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(
    `usagemesh-browser-session-v2:${repo.toLowerCase()}:${keyId}`,
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    wrappingKey,
    new TextEncoder().encode(workspaceKey),
  );
  const session: BrowserDashboardSession = {
    version: 2,
    repo,
    keyId,
    iv: b64urlEncodeBytes(iv),
    ciphertext: b64urlEncodeBytes(new Uint8Array(ciphertext)),
    createdAt: now,
    lastActivityAt: now,
  };
  try {
    sessionStorage.setItem(DASHBOARD_SESSION_STORAGE, JSON.stringify(session));
  } catch (error) {
    await deleteSessionWrappingKey(keyId).catch(() => undefined);
    throw error;
  }
}

export async function restoreDashboardSession(
  repo: string,
): Promise<string | null> {
  const session = readDashboardSession();
  if (
    !session ||
    session.repo.toLowerCase() !== repo.toLowerCase() ||
    dashboardSessionExpired(session)
  ) {
    if (session) await forgetDashboardSession();
    return null;
  }
  const wrappingKey = await loadSessionWrappingKey(session.keyId);
  if (!wrappingKey) {
    await forgetDashboardSession();
    return null;
  }
  try {
    const aad = new TextEncoder().encode(
      `usagemesh-browser-session-v2:${repo.toLowerCase()}:${session.keyId}`,
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64url(session.iv), additionalData: aad },
      wrappingKey,
      b64url(session.ciphertext),
    );
    const workspaceKey = new TextDecoder().decode(plaintext);
    if (b64url(workspaceKey).length !== 32)
      throw new Error("invalid workspace key");
    touchDashboardSession();
    return workspaceKey;
  } catch {
    await forgetDashboardSession();
    return null;
  }
}
