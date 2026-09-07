import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "fake-indexeddb/auto";
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
