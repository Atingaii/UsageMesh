import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BarChart3, TrendingUp, HardDrive, Table, PanelLeftClose, PanelLeftOpen, Sun, Moon, Lock, Terminal, RefreshCw, ShieldCheck, Database, PanelLeft, KeyRound, ShieldAlert, ArrowRight, Calendar, RotateCcw, Filter, ChevronDown, Coins, Cpu, ArrowDownRight, ArrowUpRight, FileCode, Info, X, ExternalLink, Route, Wrench, Monitor, Clock, Download, Search, ChevronLeft, ChevronRight, ArrowUpDown, Table as TableIcon, Layers3, PieChart as PieIcon, Table2 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from 'recharts';
import './index.css';

interface UsageRecord {
  id: string;
  date: string;
  device: string;
  deviceId: string;
  platform: string;
  architecture: string;
  tool: string;
  model: string;
  vendor: string;
  routeProvider: string;
  routeType: string;
  rawProvider: string;
  tier: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requestsCount: number;
  storedCost: number;
  cost: number;
  pricingResolved: boolean;
  updatedAt: string;
}

interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  architecture: string;
  lastSync: string;
  totalTokens: number;
  cost: number;
  requestsCount: number;
  sharePercentage: number;
  status: 'online' | 'syncing' | 'offline' | 'error';
}

interface DailyTrendPoint {
  date: string;
  label: string;
  totalTokens: number;
  cost: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requestsCount: number;
}

interface FilterState {
  timeRange: 'today' | '7d' | '30d' | 'month' | 'all' | 'custom';
  customStartDate?: string;
  customEndDate?: string;
  device: string;
  tool: string;
  model: string;
  vendor: string;
  routeProvider: string;
  routeType: string;
  rawProvider: string;
  tier: string;
}

interface DynamicFilterOptions {
  device: string[];
  tool: string[];
  model: string[];
  vendor: string[];
  routeProvider: string[];
  routeType: string[];
  rawProvider: string[];
  tier: string[];
}

interface PricingStatus {
  source: string;
  sourceUrl: string;
  updatedAt: string | null;
  fastMultiplier: number;
  resolvedRows: number;
  fallbackRows: number;
}

interface DashboardDataset {
  repo: string;
  records: UsageRecord[];
  pricing: PricingStatus;
  lastSync: string;
}

type ActiveTab = 'overview' | 'analytics' | 'devices' | 'aggregated';


const LITELLM_COST_MAP_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_KEY = 'usagemesh:litellm-cost-map:v1';
function subscriptionSpeedMultiplier(record: UsageRecord): number {
  const tier = String(record.tier || '').trim().toLowerCase();
  if (record.tool.trim().toLowerCase() !== 'codex' || (tier !== 'fast' && tier !== 'priority')) {
    return 1;
  }

  const model = normalizeModel(record.model);
  // OpenAI Codex / ChatGPT Work official Speed rate card (2026-08):
  // GPT-5.6 and GPT-5.5 Fast consume 2.5x Standard credits; GPT-5.4 consumes 2x.
  // API-key Priority/Fast is deliberately NOT inferred here: it has separate API pricing.
  if (model.startsWith('gpt-5.6') || model.startsWith('gpt-5.5')) return 2.5;
  if (model.startsWith('gpt-5.4')) return 2;
  return 1;
}

type CostEntry = Record<string, unknown> & {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  output_cost_per_reasoning_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
};

type CostMap = Record<string, CostEntry>;

interface CachedMap {
  fetchedAt: number;
  map: CostMap;
}

function canonicalVendor(vendor: string): string {
  const value = vendor.trim().toLowerCase();
  if (value === 'openai') return 'openai';
  if (value === 'anthropic') return 'anthropic';
  if (value === 'google') return 'vertex_ai';
  if (value === 'deepseek') return 'deepseek';
  if (value === 'xai') return 'xai';
  if (value === 'meta') return 'meta_llama';
  return value.replace(/[^a-z0-9_-]+/g, '_');
}

function normalizeModel(model: string): string {
  let value = model.trim().replace(/@/g, '-').toLowerCase();
  value = value.replace(/\[1m\]$/i, '').trim();
  if (/^gpt-5\.6(?:-(low|medium|high|xhigh|minimal))?$/.test(value)) return 'gpt-5.6-sol';
  return value;
}

function stripDateSuffix(model: string): string | null {
  const match = model.match(/^(.*)-(\d{8}|\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

function candidates(record: UsageRecord): string[] {
  const model = normalizeModel(record.model);
  const base = stripDateSuffix(model);
  const provider = canonicalVendor(record.vendor);
  const routeProvider = record.rawProvider?.trim().toLowerCase();
  const values = [
    model,
    `${provider}/${model}`,
    routeProvider ? `${routeProvider}/${model}` : '',
    base || '',
    base ? `${provider}/${base}` : '',
  ];
  return [...new Set(values.filter(Boolean))];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function thresholdFromKey(key: string, base: string): number | null {
  if (!key.startsWith(`${base}_above_`)) return null;
  const suffix = key.slice(`${base}_above_`.length);
  const match = suffix.match(/^(\d+)(k|m)_tokens$/);
  if (!match) return null;
  const scale = match[2] === 'm' ? 1_000_000 : 1_000;
  return Number(match[1]) * scale;
}

function rate(entry: CostEntry, base: string, totalInput: number): number | null {
  let selected = asNumber(entry[base]);
  let selectedThreshold = -1;
  for (const [key, raw] of Object.entries(entry)) {
    const threshold = thresholdFromKey(key, base);
    if (threshold === null || totalInput <= threshold || threshold < selectedThreshold) continue;
    const value = asNumber(raw);
    if (value !== null) {
      selected = value;
      selectedThreshold = threshold;
    }
  }
  return selected;
}

function lookup(map: CostMap, record: UsageRecord): CostEntry | null {
  for (const key of candidates(record)) {
    const direct = map[key];
    if (direct) return direct;
  }

  // LiteLLM contains both bare and provider-prefixed keys. If an exact alias was
  // not found, prefer an entry whose final model segment matches and whose
  // provider agrees with the observed upstream vendor.
  const wanted = normalizeModel(record.model);
  const provider = canonicalVendor(record.vendor);
  let fallback: CostEntry | null = null;
  for (const [key, entry] of Object.entries(map)) {
    const tail = normalizeModel(key.split('/').at(-1) || key);
    if (tail !== wanted) continue;
    if (String(entry.litellm_provider || '').toLowerCase() === provider) return entry;
    fallback ||= entry;
  }
  return fallback;
}

function quote(map: CostMap, record: UsageRecord): number | null {
  const entry = lookup(map, record);
  if (!entry) return null;

  const totalInput = Math.max(0, record.inputTokens) + Math.max(0, record.cacheReadTokens) + Math.max(0, record.cacheWriteTokens);
  let input = rate(entry, 'input_cost_per_token', totalInput);
  let output = rate(entry, 'output_cost_per_token', totalInput);
  let cacheRead = rate(entry, 'cache_read_input_token_cost', totalInput);
  let cacheWrite = rate(entry, 'cache_creation_input_token_cost', totalInput);
  let reasoning = rate(entry, 'output_cost_per_reasoning_token', totalInput);

  if (input === null && output === null) return null;
  input ??= 0;
  output ??= 0;
  // Missing cache-specific pricing must never make paid input free. LiteLLM's
  // own cost tests use the same accounting principle: cached buckets fall back
  // to the regular input price when the model publishes no special rate.
  cacheRead ??= input;
  cacheWrite ??= input;
  reasoning ??= output;

  // UsageMesh's dashboard is subscription-equivalent usage, not the API
  // Priority price card. OpenAI's ChatGPT/Codex Fast mode consumes 2.5x the
  // Standard rate, so Fast and the raw service-tier label Priority use 2.5x.
  const multiplier = subscriptionSpeedMultiplier(record);

  const cost = (
    Math.max(0, record.inputTokens) * input +
    Math.max(0, record.cacheReadTokens) * cacheRead +
    Math.max(0, record.cacheWriteTokens) * cacheWrite +
    Math.max(0, record.outputTokens) * output +
    Math.max(0, record.reasoningTokens) * reasoning
  ) * multiplier;

  return Number.isFinite(cost) ? Math.max(0, cost) : null;
}

function readCache(): CachedMap | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedMap;
    if (!parsed?.map || !parsed?.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(map: CostMap, fetchedAt: number) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt, map } satisfies CachedMap));
  } catch {
    // Storage quotas/private browsing must not break the dashboard.
  }
}

async function fetchMap(): Promise<{ map: CostMap | null; fetchedAt: number | null; source: string }> {
  const cached = readCache();
  const now = Date.now();
  try {
    // Revalidate on every unlock/refresh so newly-added LiteLLM models become
    // available without a UsageMesh release. Browser HTTP caching can still
    // satisfy an unchanged map cheaply, while localStorage is only a failure fallback.
    const response = await fetch(LITELLM_COST_MAP_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const map = await response.json() as CostMap;
    writeCache(map, now);
    return { map, fetchedAt: now, source: 'LiteLLM live' };
  } catch {
    if (cached) return { map: cached.map, fetchedAt: cached.fetchedAt, source: 'LiteLLM stale cache' };
    return { map: null, fetchedAt: null, source: 'Ledger fallback' };
  }
}

async function applyDynamicPricing(records: UsageRecord[]): Promise<PricingStatus> {
  const loaded = await fetchMap();
  let resolvedRows = 0;
  let fallbackRows = 0;

  for (const record of records) {
    const calculated = loaded.map ? quote(loaded.map, record) : null;
    if (calculated !== null) {
      record.cost = calculated;
      record.pricingResolved = true;
      resolvedRows += 1;
    } else {
      record.cost = record.storedCost;
      record.pricingResolved = false;
      fallbackRows += 1;
    }
  }

  return {
    source: `${loaded.source} · Fast`,
    sourceUrl: LITELLM_COST_MAP_URL,
    updatedAt: loaded.fetchedAt ? new Date(loaded.fetchedAt).toISOString() : null,
    fastMultiplier: 2.5,
    resolvedRows,
    fallbackRows,
  };
}

const RAW = 'https://raw.githubusercontent.com';
const DEFAULT_REPO = 'Atingaii/UsageMesh';
const ACCESS_BRANCH = 'um-dashboard';
const DEVICE_INDEX_BRANCH = 'um-index';
const ACCESS_AAD_PREFIX = 'usagemesh-dashboard-access-v1:';
const LEDGER_AAD_PREFIX = 'usagemesh-ledger-v2:';
const REMEMBERED_WORKSPACE_KEY_PREFIX = 'usagemesh:remembered-workspace-key:v1:';

function rememberedWorkspaceStorageKey(repo: string): string {
  return `${REMEMBERED_WORKSPACE_KEY_PREFIX}${repo.toLowerCase()}`;
}

function readRememberedWorkspaceKey(repo: string): string {
  try {
    return sessionStorage.getItem(rememberedWorkspaceStorageKey(repo)) || '';
  } catch {
    return '';
  }
}

function rememberWorkspaceKey(repo: string, encodedKey: string) {
  try {
    sessionStorage.setItem(rememberedWorkspaceStorageKey(repo), encodedKey);
  } catch {
    // Storage may be unavailable in private browsing; normal password unlock still works.
  }
}

function forgetRememberedWorkspaceKey(repo: string) {
  try {
    sessionStorage.removeItem(rememberedWorkspaceStorageKey(repo));
  } catch {
    // Best-effort local logout.
  }
}

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

interface LedgerRow {
  date?: string;
  client?: string;
  provider?: string;
  upstreamVendor?: string;
  routeProvider?: string;
  routeType?: string;
  model?: string;
  tier?: string | null;
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
  device?: {
    id?: string;
    name?: string;
    platform?: string;
    arch?: string;
    hostname?: string;
    appVersion?: string;
  };
  rows?: LedgerRow[];
}

function repoFromLocation(): string {
  const param = new URLSearchParams(location.search).get('repo');
  if (param && /^[^/]+\/[^/]+$/.test(param)) return param;
  const owner = location.hostname.match(/^([^.]+)\.github\.io$/i)?.[1];
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (owner && repo) return `${owner}/${repo}`;
  return DEFAULT_REPO;
}

function b64url(value: string): Uint8Array {
  let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`数据读取失败 (${response.status})`);
  return response.json() as Promise<T>;
}

async function workspaceKey(repo: string, password: string): Promise<string> {
  const envelope = await json<AccessEnvelope>(`${RAW}/${repo}/${ACCESS_BRANCH}/access.json`);
  if (
    envelope.kind !== 'usagemesh-dashboard-access' ||
    envelope.schemaVersion !== 1 ||
    envelope.kdf !== 'PBKDF2-HMAC-SHA256' ||
    envelope.algorithm !== 'AES-256-GCM'
  ) throw new Error('Dashboard 访问配置不受支持');

  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64url(envelope.salt), iterations: envelope.iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64url(envelope.nonce),
        additionalData: new TextEncoder().encode(`${ACCESS_AAD_PREFIX}${repo.toLowerCase()}`),
      },
      key,
      b64url(envelope.ciphertext),
    );
    const encoded = new TextDecoder().decode(plaintext);
    if (b64url(encoded).length !== 32) throw new Error('bad key');
    return encoded;
  } catch {
    throw new Error('Dashboard 密码不正确');
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
    new URL('device-index.json', document.baseURI).toString(),
  ];
  for (const url of urls) {
    try {
      const index = await json<{ branches?: string[] }>(url);
      const branches = (index.branches || []).filter(branch => /^um-ledger-[a-f0-9]+$/i.test(branch));
      if (branches.length) return [...new Set(branches)];
    } catch {
      // Try the static deployment fallback next.
    }
  }
  throw new Error('暂无设备索引，请先在任意设备执行 usagemesh sync');
}

async function decryptLedger(repo: string, branch: string, encodedKey: string): Promise<Ledger> {
  const envelope = await json<LedgerEnvelope>(`${RAW}/${repo}/${branch}/ledger.json`);
  if (envelope.kind !== 'usagemesh-encrypted-ledger' || envelope.schemaVersion !== 2) {
    throw new Error(`设备账本格式不受支持 (${branch})`);
  }
  const key = await crypto.subtle.importKey('raw', b64url(encodedKey), 'AES-GCM', false, ['decrypt']);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64url(envelope.nonce),
        additionalData: new TextEncoder().encode(`${LEDGER_AAD_PREFIX}${envelope.deviceHash}`),
      },
      key,
      b64url(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as Ledger;
  } catch {
    throw new Error(`设备账本解密失败 (${branch})`);
  }
}

function platformLabel(platform: string): string {
  const value = platform.toLowerCase();
  if (value.includes('mac')) return 'macOS';
  if (value.includes('win')) return 'Windows';
  if (value.includes('linux')) return 'Linux';
  return platform || 'Unknown';
}

function archLabel(platform: string, arch: string): string {
  const value = arch.toLowerCase();
  if (platformLabel(platform) === 'macOS') {
    if (value.includes('aarch64') || value.includes('arm64')) return 'Apple Silicon';
    if (value.includes('x86_64') || value.includes('x64')) return 'Intel';
  }
  if (value.includes('aarch64') || value.includes('arm64')) return 'ARM64';
  if (value.includes('x86_64') || value.includes('x64')) return 'x86_64';
  return arch || 'Unknown';
}

function tierLabel(value: string | null | undefined): string {
  const tier = String(value || 'standard').trim().toLowerCase();
  if (tier === 'fast') return 'Fast';
  if (tier === 'priority') return 'Priority';
  if (tier === 'standard' || tier === 'default') return 'Standard';
  return value ? String(value) : 'Standard';
}

function routeLabel(row: LedgerRow): string {
  if (String(row.routeType || '').toLowerCase() === 'official') return '官方';
  return String(row.routeProvider || row.provider || '未知');
}

function toRecord(ledger: Ledger, row: LedgerRow, index: number): UsageRecord {
  const deviceId = String(ledger.device?.id || ledger.device?.name || 'unknown-device');
  const deviceName = String(ledger.device?.name || ledger.device?.id || 'Unknown Device');
  const platform = String(ledger.device?.platform || 'unknown');
  const arch = String(ledger.device?.arch || '');
  const input = Number(row.input || 0);
  const output = Number(row.output || 0);
  const cacheRead = Number(row.cacheRead || 0);
  const cacheWrite = Number(row.cacheWrite || 0);
  const reasoning = Number(row.reasoning || 0);
  return {
    id: `${deviceId}:${row.date || ''}:${row.client || ''}:${row.model || ''}:${index}`,
    date: String(row.date || ''),
    device: deviceName,
    deviceId,
    platform: platformLabel(platform),
    architecture: archLabel(platform, arch),
    tool: String(row.client || 'Unknown'),
    model: String(row.model || 'Unknown'),
    vendor: String(row.upstreamVendor || 'Unknown'),
    routeProvider: routeLabel(row),
    routeType: String(row.routeType || 'unknown'),
    rawProvider: String(row.provider || 'unknown'),
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
    pricingResolved: false,
    updatedAt: String(ledger.generatedAt || ''),
  };
}

async function loadDashboardWithKey(repo: string, key: string): Promise<DashboardDataset> {
  const branches = await loadDeviceIndex(repo);
  const settled = await Promise.allSettled(branches.map(branch => decryptLedger(repo, branch, key)));
  const ledgers = settled.filter((item): item is PromiseFulfilledResult<Ledger> => item.status === 'fulfilled').map(item => item.value);
  if (!ledgers.length) {
    const reason = settled.find(item => item.status === 'rejected');
    throw reason && reason.status === 'rejected' ? reason.reason : new Error('暂无设备数据');
  }

  const records = ledgers.flatMap(ledger => (ledger.rows || []).map((row, index) => toRecord(ledger, row, index)));
  const pricing = await applyDynamicPricing(records);
  const lastSync = ledgers.map(ledger => String(ledger.generatedAt || '')).filter(Boolean).sort().at(-1) || '';
  return { repo, records, pricing, lastSync };
}

async function unlockDashboard(password: string): Promise<{ dataset: DashboardDataset; key: string }> {
  const repo = repoFromLocation();
  const key = await workspaceKey(repo, password);
  const dataset = await loadDashboardWithKey(repo, key);
  return { dataset, key };
}

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  syncStatus: 'synced' | 'syncing' | 'error';
  deviceCount: number;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  onLock: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ isCollapsed, onToggleCollapse, activeTab, onSelectTab, syncStatus, deviceCount, isDarkMode, onToggleDarkMode, onLock }) => {
  const navItems = [
    { id: 'overview' as ActiveTab, label: '概览', icon: BarChart3 },
    { id: 'analytics' as ActiveTab, label: '用量分析', icon: TrendingUp },
    { id: 'devices' as ActiveTab, label: '设备', icon: HardDrive },
    { id: 'aggregated' as ActiveTab, label: '聚合数据', icon: Table },
  ];
  const syncText = syncStatus === 'syncing' ? '同步数据中...' : syncStatus === 'error' ? '部分设备异常' : `${deviceCount} 台设备已同步`;

  return (
    <aside className={`relative flex flex-col h-full border-r border-[var(--border-color)] bg-[var(--bg-card)] transition-all duration-300 ease-in-out select-none z-30 shrink-0 ${isCollapsed ? 'w-16 lg:w-18' : 'w-60 lg:w-64'}`}>
      <div className="flex items-center justify-between h-14 px-3 border-b border-[var(--border-color)] shrink-0">
        {!isCollapsed ? (
          <div className="flex items-center gap-2.5 overflow-hidden">
            <img src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`} alt="" className="w-8 h-8 rounded-lg shadow-sm shrink-0" />
            <div className="min-w-0 transition-opacity duration-200"><div className="text-sm font-semibold tracking-tight text-[var(--text-primary)] truncate">UsageMesh</div><div className="text-[10px] font-mono text-[var(--text-muted)] tracking-wider uppercase truncate">Usage Console</div></div>
          </div>
        ) : <img src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`} alt="UsageMesh" title="UsageMesh Usage Console" className="w-8 h-8 rounded-lg shadow-sm mx-auto" />}
        <button onClick={onToggleCollapse} title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'} className={`p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition cursor-pointer ${isCollapsed ? 'hidden' : 'block'}`}><PanelLeftClose className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 py-3 px-2 space-y-4 overflow-x-hidden overflow-y-auto">
        <div>
          {!isCollapsed && <div className="px-2.5 mb-2 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">工作台</div>}
          <nav className="space-y-1">
            {navItems.map(item => { const Icon = item.icon; const active = activeTab === item.id; return (
              <button key={item.id} onClick={() => onSelectTab(item.id)} title={isCollapsed ? item.label : undefined}
                className={`w-full flex items-center gap-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer relative group ${isCollapsed ? 'justify-center px-0' : 'px-2.5'} ${active ? 'bg-[var(--accent-blue-light)] text-[var(--accent-blue)] border border-[var(--accent-blue-border)] shadow-2xs font-semibold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] border border-transparent'}`}>
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[var(--accent-blue)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'}`} />
                {!isCollapsed && <span className="truncate text-left flex-1">{item.label}</span>}
                {isCollapsed && <div className="fixed left-16 bg-slate-900 text-white text-[11px] px-2.5 py-1 rounded-md shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 transition duration-150 whitespace-nowrap z-50 font-medium border border-slate-700">{item.label}</div>}
              </button>
            ); })}
          </nav>
        </div>
      </div>
      <div className="p-2 border-t border-[var(--border-color)] bg-[var(--bg-main)]/60 space-y-2 shrink-0">
        {isCollapsed && <button onClick={onToggleCollapse} title="展开侧边栏" className="w-full flex items-center justify-center p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition cursor-pointer"><PanelLeftOpen className="w-4 h-4" /></button>}
        {!isCollapsed ? <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] text-[11px]"><span className={`w-2 h-2 rounded-full shrink-0 ${syncStatus === 'syncing' ? 'bg-amber-500 animate-ping' : syncStatus === 'error' ? 'bg-red-500' : 'bg-emerald-500 animate-pulse'}`} /><span className="text-[var(--text-secondary)] truncate font-mono">{syncText}</span></div> : <div title={syncText} className="flex justify-center p-2 relative group cursor-pointer"><span className={`w-2.5 h-2.5 rounded-full ${syncStatus === 'error' ? 'bg-red-500' : 'bg-emerald-500 animate-pulse'}`} /><div className="fixed left-16 bg-slate-900 text-white text-[11px] px-2.5 py-1 rounded-md shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 transition whitespace-nowrap z-50 font-mono border border-slate-700">{syncText}</div></div>}
        <div className={`flex items-center ${isCollapsed ? 'flex-col gap-1' : 'justify-between gap-1'} pt-1`}>
          <button onClick={onToggleDarkMode} title={isDarkMode ? '切换浅色模式' : '切换深色模式'} className={`flex items-center justify-center gap-1.5 p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] transition cursor-pointer ${isCollapsed ? 'w-full' : 'flex-1'}`}>{isDarkMode ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}{!isCollapsed && <span className="text-xs">{isDarkMode ? '浅色' : '深色'}</span>}</button>
          <button onClick={onLock} title="锁定控制台" className={`flex items-center justify-center p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-[var(--bg-card-hover)] transition cursor-pointer ${isCollapsed ? 'w-full' : ''}`}><Lock className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    </aside>
  );
};

interface TopbarProps {
  title: string; subtitle: string; repoBadge?: string; pricingBadge?: string; lastSyncTime: string;
  syncStatus: 'synced' | 'syncing' | 'error'; deviceCount: number; isDarkMode: boolean;
  onToggleDarkMode: () => void; onRefresh: () => void; onLock: () => void;
  isSidebarCollapsed: boolean; onToggleSidebar: () => void;
}

const Topbar: React.FC<TopbarProps> = ({ title, subtitle, repoBadge = 'Atingaii/UsageMesh', pricingBadge = 'LiteLLM live · Fast', lastSyncTime, syncStatus, deviceCount, isDarkMode, onToggleDarkMode, onRefresh, onLock, isSidebarCollapsed, onToggleSidebar }) => (
  <header className="sticky top-0 z-20 border-b border-[var(--border-color)] bg-[var(--bg-main)]/90 backdrop-blur-md px-4 lg:px-6 py-3 transition-colors">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <button onClick={onToggleSidebar} title={isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} className="p-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition cursor-pointer"><PanelLeft className="w-4 h-4" /></button>
        <div><div className="flex items-center gap-2"><h1 className="text-lg lg:text-xl font-semibold tracking-tight text-[var(--text-primary)]">{title}</h1>{repoBadge && <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-card)] border border-[var(--border-color)] rounded-md"><Database className="w-3 h-3 text-[var(--accent-blue)]" />{repoBadge}</span>}</div><p className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</p></div>
      </div>
      <div className="flex items-center flex-wrap gap-2 text-xs">
        {pricingBadge && <div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent-blue-light)] border border-[var(--accent-blue-border)] text-[var(--accent-blue)] font-medium"><ShieldCheck className="w-3.5 h-3.5" /><span>{pricingBadge}</span></div>}
        <div className="hidden md:block text-[var(--text-muted)] font-mono">{syncStatus === 'syncing' ? '正在同步加密数据…' : `数据更新于 ${lastSyncTime}`}</div>
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-color)] text-[var(--text-secondary)] font-medium"><span className={`w-2 h-2 rounded-full ${syncStatus === 'syncing' ? 'bg-amber-500 animate-ping' : syncStatus === 'error' ? 'bg-red-500' : 'bg-emerald-500 animate-pulse'}`} /><span>{syncStatus === 'syncing' ? '同步中' : syncStatus === 'error' ? '部分设备异常' : `${deviceCount} 台设备已同步`}</span></div>
        <button onClick={onRefresh} title="刷新数据" className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-card)] border border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition active:scale-95 cursor-pointer font-medium"><RefreshCw className={`w-3.5 h-3.5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} /><span className="hidden sm:inline">刷新</span></button>
        <button onClick={onToggleDarkMode} title={isDarkMode ? '切换浅色模式' : '切换深色模式'} className="p-1.5 rounded-md bg-[var(--bg-card)] border border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition cursor-pointer">{isDarkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}</button>
        <button onClick={onLock} title="锁定 Dashboard" className="p-1.5 rounded-md bg-[var(--bg-card)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-red-500 hover:bg-[var(--bg-card-hover)] transition cursor-pointer"><Lock className="w-4 h-4" /></button>
      </div>
    </div>
  </header>
);

interface UnlockScreenProps {
  onUnlock: (password: string) => Promise<void>;
  error: string | null;
}

const UnlockScreen: React.FC<UnlockScreenProps> = ({ onUnlock, error }) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    try { await onUnlock(password); } finally { setLoading(false); }
  };

  return (
    <div className="relative min-h-screen flex flex-col justify-between bg-[var(--bg-main)] text-[var(--text-primary)] transition-colors p-4">
      <div className="w-full flex items-center justify-between py-3 px-4 border-b border-[var(--border-color)] bg-[var(--bg-card)]/50 backdrop-blur-xs rounded-xl max-w-5xl mx-auto opacity-70">
        <div className="flex items-center gap-2.5"><img src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`} alt="" className="w-7 h-7 rounded-lg" /><span className="font-semibold text-sm tracking-tight">UsageMesh</span></div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] font-mono"><Lock className="w-3.5 h-3.5 text-amber-500" /><span>Encrypted Session</span></div>
      </div>

      <main className="flex-1 flex items-center justify-center my-8 px-4">
        <div className="w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-color)] rounded-2xl p-6 lg:p-8 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-emerald-500" />
          <div className="flex justify-between items-start mb-6">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--bg-card-hover)] border border-[var(--border-color)] text-[11px] font-mono font-medium text-[var(--text-secondary)] uppercase tracking-wider"><KeyRound className="w-3.5 h-3.5 text-[var(--accent-blue)]" />Private Analytics</div>
            <div className="w-9 h-9 rounded-full bg-[var(--accent-blue-light)] border border-[var(--accent-blue-border)] flex items-center justify-center text-[var(--accent-blue)]"><Lock className="w-4 h-4" /></div>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-[var(--text-primary)] mb-1">打开 UsageMesh</h2>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-6">输入 Dashboard 密码。密码只在当前页面参与 PBKDF2 + AES-GCM 解密，不会发送给 GitHub，也不会出现在网址中。</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Dashboard Password</label><div className="relative"><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="输入 Dashboard 密码" className="w-full bg-[var(--bg-main)] text-[var(--text-primary)] text-sm border border-[var(--border-color)] rounded-xl px-3.5 py-2.5 focus:outline-none focus:border-[var(--accent-blue)] transition font-mono pr-10" autoFocus /><KeyRound className="absolute right-3 top-3 w-4 h-4 text-[var(--text-muted)]" /></div></div>
            {error && <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-xs"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" /><div><div className="font-semibold">{error}</div><div className="text-[11px] opacity-90 mt-0.5">{error.includes('密码') ? '请确认输入的是设备端 usagemesh password 设置的密码。' : '页面只读取公开仓库中的加密快照；请稍后刷新或检查设备是否完成同步。'}</div></div></div>}
            <button type="submit" disabled={loading || password.length < 8} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--accent-blue)] text-white text-sm font-medium hover:bg-blue-600 active:scale-[0.99] transition cursor-pointer disabled:opacity-50 shadow-sm">{loading ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>正在解密并读取数据…</span></> : <><span>进入 Dashboard</span><ArrowRight className="w-4 h-4" /></>}</button>
          </form>
          <div className="mt-6 pt-4 border-t border-[var(--border-subtle)] text-center text-xs text-[var(--text-muted)]">使用设备设置的 Dashboard 密码即可从任意浏览器访问。</div>
        </div>
      </main>
      <footer className="text-center text-xs text-[var(--text-muted)] py-2 font-mono">UsageMesh · Local PBKDF2 + AES-256-GCM Decryption</footer>
    </div>
  );
};

interface FilterBarProps {
  filters: FilterState;
  options: DynamicFilterOptions;
  onChangeFilter: (key: keyof FilterState, value: string) => void;
  onResetFilters: () => void;
}

const filterRouteTypeLabels: Record<string, string> = {
  official: '官方', cloud: '云服务', aggregator: '聚合服务', relay: '中转',
  'inference-provider': '推理服务', inference: '推理服务', 'self-hosted': '自托管',
  self_hosted: '自托管', custom: '自定义', unknown: '未知',
};

const FilterBar: React.FC<FilterBarProps> = ({ filters, options, onChangeFilter, onResetFilters }) => {
  const timeOptions: { id: FilterState['timeRange']; label: string }[] = [
    { id: 'today', label: '今日' }, { id: '7d', label: '7 天' }, { id: '30d', label: '30 天' },
    { id: 'month', label: '本月' }, { id: 'all', label: '全部' }, { id: 'custom', label: '自定义' },
  ];

  const groups: Array<{ key: keyof DynamicFilterOptions; label: string; all: string; values: string[] }> = [
    { key: 'device', label: '设备', all: '全部设备', values: options.device },
    { key: 'tool', label: '工具', all: '全部工具', values: options.tool },
    { key: 'model', label: '模型', all: '全部模型', values: options.model },
    { key: 'vendor', label: '模型厂商', all: '全部厂商', values: options.vendor },
    { key: 'routeProvider', label: '路由', all: '全部路由', values: options.routeProvider },
    { key: 'routeType', label: '路由类型', all: '全部类型', values: options.routeType },
    { key: 'rawProvider', label: '原始 Provider', all: '全部 Provider', values: options.rawProvider },
    { key: 'tier', label: 'Tier', all: '全部 Tier', values: options.tier },
  ];

  const labelFor = (key: keyof DynamicFilterOptions, value: string) =>
    key === 'routeType' ? (filterRouteTypeLabels[value] || value) : value;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-3 shadow-2xs space-y-3 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-[var(--accent-blue)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">时间与范围筛选</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] overflow-x-auto max-w-full">
            {timeOptions.map((opt) => (
              <button key={opt.id} onClick={() => onChangeFilter('timeRange', opt.id)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition cursor-pointer whitespace-nowrap ${filters.timeRange === opt.id ? 'bg-[var(--accent-blue)] text-white shadow-2xs font-semibold' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                {opt.label}
              </button>
            ))}
          </div>
          {filters.timeRange === 'custom' && (
            <div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-xs font-mono text-[var(--text-secondary)]">
              <input type="date" value={filters.customStartDate || ''} onChange={e => onChangeFilter('customStartDate', e.target.value)} className="bg-transparent outline-none" />
              <span className="text-[var(--text-muted)]">-</span>
              <input type="date" value={filters.customEndDate || ''} onChange={e => onChangeFilter('customEndDate', e.target.value)} className="bg-transparent outline-none" />
            </div>
          )}
          <button onClick={onResetFilters} title="重置所有筛选" className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition cursor-pointer">
            <RotateCcw className="w-3 h-3" /><span>重置</span>
          </button>
        </div>
      </div>

      <div className="pt-2 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-1 text-[10px] font-mono text-[var(--text-muted)] uppercase font-semibold mb-2">
          <Filter className="w-3 h-3 text-[var(--accent-blue)]" /><span>快速维度</span>
          <span className="normal-case font-sans font-normal ml-1">· 选项从已识别数据自动生成</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
          {groups.map(group => (
            <label key={group.key} className="min-w-0">
              <span className="block text-[10px] font-semibold text-[var(--text-muted)] mb-1 truncate">{group.label}</span>
              <div className="relative">
                <select
                  value={String(filters[group.key as keyof FilterState] || 'all')}
                  onChange={e => onChangeFilter(group.key as keyof FilterState, e.target.value)}
                  className="appearance-none w-full h-8 pl-2.5 pr-7 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-[11px] font-medium text-[var(--text-primary)] outline-none hover:border-[var(--text-muted)]/60 focus:border-[var(--accent-blue)] transition cursor-pointer truncate"
                >
                  <option value="all">{group.all}</option>
                  {group.values.map(value => <option key={value} value={value}>{labelFor(group.key, value)}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-2.5 w-3 h-3 text-[var(--text-muted)]" />
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
};

interface KpiCardsProps {
  totalTokens: number; cost: number; inputTokens: number; cacheReadTokens: number;
  outputTokens: number; requestsCount: number; pricing: PricingStatus;
}

const KpiCards: React.FC<KpiCardsProps> = ({ totalTokens, cost, inputTokens, cacheReadTokens, outputTokens, requestsCount, pricing }) => {
  const [showPricingModal, setShowPricingModal] = useState(false);
  const fmt = (num: number) => Math.round(num).toLocaleString('en-US');
  const kpis = [
    { id: 'total', title: '总 Tokens', value: fmt(totalTokens), subtext: '当前筛选范围', icon: Cpu, highlight: false },
    { id: 'cost', title: '订阅等价费用', value: `$${cost.toFixed(4)}`, subtext: 'API 等价估算', icon: Coins, highlight: true, info: false },
    { id: 'input', title: '输入 Tokens', value: fmt(inputTokens), subtext: 'Fresh input', icon: ArrowDownRight, highlight: false },
    { id: 'cache', title: '缓存读取', value: fmt(cacheReadTokens), subtext: 'Cache read', icon: Database, highlight: false },
    { id: 'output', title: '输出 Tokens', value: fmt(outputTokens), subtext: 'Output', icon: ArrowUpRight, highlight: false },
    { id: 'requests', title: '请求记录', value: fmt(requestsCount), subtext: 'Parsed requests', icon: FileCode, highlight: false },
  ];

  return <div className="relative">
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {kpis.map(kpi => { const Icon = kpi.icon; return <div key={kpi.id} className={`relative p-3.5 lg:p-4 rounded-xl border transition-all duration-200 ${kpi.highlight ? 'bg-[var(--accent-blue-light)] border-[var(--accent-blue-border)] shadow-sm' : 'bg-[var(--bg-card)] border-[var(--border-color)] shadow-2xs hover:border-[var(--text-muted)]/40'}`}>
        <div className="flex items-center justify-between mb-1.5"><span className="text-xs font-medium text-[var(--text-muted)] truncate">{kpi.title}</span><div className="flex items-center gap-1">{kpi.info && <button onClick={() => setShowPricingModal(true)} title="查看动态价格来源" className="text-[var(--accent-blue)] hover:text-blue-700 cursor-pointer p-0.5 rounded hover:bg-blue-100/50 transition"><Info className="w-3.5 h-3.5" /></button>}<Icon className={`w-3.5 h-3.5 ${kpi.highlight ? 'text-[var(--accent-blue)]' : 'text-[var(--text-muted)] opacity-60'}`} /></div></div>
        <div className={`text-lg lg:text-xl font-bold font-mono-numbers tracking-tight truncate ${kpi.highlight ? 'text-[var(--accent-blue)]' : 'text-[var(--text-primary)]'}`}>{kpi.value}</div>
        <div className="text-[10px] text-[var(--text-muted)] mt-1 font-mono truncate" title={kpi.subtext}>{kpi.subtext}</div>
      </div>; })}
    </div>

    {showPricingModal && <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs" onClick={() => setShowPricingModal(false)}>
      <div className="w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between pb-2 border-b border-[var(--border-color)]"><div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]"><Coins className="w-4 h-4 text-[var(--accent-blue)]" /><span>动态模型价格</span></div><button onClick={() => setShowPricingModal(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"><X className="w-4 h-4" /></button></div>
        <div className="text-xs space-y-3 text-[var(--text-secondary)] font-mono">
          <div className="grid grid-cols-[120px_1fr] gap-2 bg-[var(--bg-main)] p-3 rounded-lg border border-[var(--border-color)]">
            <span className="text-[var(--text-muted)]">Pricing source</span><span className="font-semibold text-[var(--text-primary)]">{pricing.source}</span>
            <span className="text-[var(--text-muted)]">Fast mode</span><span className="font-semibold text-[var(--accent-blue)]">{pricing.fastMultiplier.toFixed(1)}× Standard</span>
            <span className="text-[var(--text-muted)]">已解析</span><span>{pricing.resolvedRows.toLocaleString()} rows</span>
            <span className="text-[var(--text-muted)]">Fallback</span><span>{pricing.fallbackRows.toLocaleString()} rows</span>
            <span className="text-[var(--text-muted)]">价格更新时间</span><span>{pricing.updatedAt ? new Date(pricing.updatedAt).toLocaleString() : '使用账本内费用'}</span>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">基础模型费率从 LiteLLM 官方维护的 model cost map 动态读取，并在浏览器中缓存 12 小时。新模型被 LiteLLM 收录后无需重新发布 UsageMesh。Fast / Priority 在本 Dashboard 的“订阅等价”口径中按 2.5× Standard 计算。</p>
          <a href={pricing.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--accent-blue)] hover:underline">查看 LiteLLM cost map <ExternalLink className="w-3 h-3" /></a>
        </div>
        <button onClick={() => setShowPricingModal(false)} className="w-full py-1.5 rounded-lg bg-[var(--accent-blue)] text-white text-xs font-medium cursor-pointer">关闭说明</button>
      </div>
    </div>}
  </div>;
};

interface TrendChartProps { isDarkMode: boolean; data: DailyTrendPoint[]; }

type MetricKey = keyof Pick<DailyTrendPoint, 'totalTokens' | 'cost' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens' | 'requestsCount'>;

function trimZeros(text: string) { return text.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, ''); }
function trendCompact(val: number) {
  const abs = Math.abs(val);
  for (const [n, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (abs >= n) { const scaled = val / n; const digits = Math.abs(scaled) < 10 ? 2 : Math.abs(scaled) < 100 ? 1 : 0; return `${trimZeros(scaled.toFixed(digits))}${suffix}`; }
  }
  return Math.round(val).toLocaleString();
}

const TrendChart: React.FC<TrendChartProps> = ({ isDarkMode, data }) => {
  const [metricKey, setMetricKey] = useState<MetricKey>('totalTokens');
  const metricOptions: { key: MetricKey; label: string }[] = [
    { key: 'totalTokens', label: '总 Tokens' }, { key: 'cost', label: '费用 ($)' }, { key: 'inputTokens', label: '输入 Tokens' },
    { key: 'cacheReadTokens', label: 'Cache Read' }, { key: 'cacheWriteTokens', label: 'Cache Write' }, { key: 'outputTokens', label: '输出 Tokens' },
    { key: 'reasoningTokens', label: 'Reasoning' }, { key: 'requestsCount', label: '请求数' },
  ];

  const formatYAxis = (val: number) => metricKey === 'cost'
    ? `$${trimZeros(Number(val).toFixed(Math.abs(val) < 1 ? 3 : Math.abs(val) < 100 ? 2 : 1))}`
    : trendCompact(Number(val));

  const yWidth = useMemo(() => {
    const max = Math.max(0, ...data.map(d => Number(d[metricKey] || 0)));
    return Math.max(56, Math.min(88, formatYAxis(max).length * 8 + 18));
  }, [data, metricKey]);

  const interval = Math.max(0, Math.ceil(data.length / 7) - 1);

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d: DailyTrendPoint = payload[0].payload;
    return <div className="bg-slate-950/95 text-slate-100 text-xs p-3 rounded-xl border border-slate-800 shadow-2xl space-y-1.5 font-mono min-w-[220px] z-50">
      <div className="text-[11px] text-slate-400 font-semibold border-b border-slate-800 pb-1 flex justify-between"><span>日期</span><span className="text-blue-400">{d.date}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-400">总 Tokens</span><span className="font-bold text-white">{Math.round(d.totalTokens).toLocaleString()}</span></div>
      <div className="flex justify-between gap-4 text-emerald-400"><span>订阅等价费用</span><span className="font-bold">${d.cost.toFixed(4)}</span></div>
      <div className="flex justify-between gap-4 text-blue-400"><span>输入 Tokens</span><span>{Math.round(d.inputTokens).toLocaleString()}</span></div>
      <div className="flex justify-between gap-4 text-indigo-400"><span>缓存读取</span><span>{Math.round(d.cacheReadTokens).toLocaleString()}</span></div>
      <div className="flex justify-between gap-4 text-slate-400"><span>缓存写入</span><span>{Math.round(d.cacheWriteTokens).toLocaleString()}</span></div>
      <div className="flex justify-between gap-4 text-amber-400"><span>输出 Tokens</span><span>{Math.round(d.outputTokens).toLocaleString()}</span></div>
      <div className="flex justify-between gap-4 text-purple-400"><span>Reasoning</span><span>{Math.round(d.reasoningTokens).toLocaleString()}</span></div>
      <div className="flex justify-between gap-4 text-slate-400 text-[11px] pt-1 border-t border-slate-800/60"><span>请求记录</span><span>{Math.round(d.requestsCount).toLocaleString()} 次</span></div>
    </div>;
  };

  return <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4 shadow-2xs space-y-3 transition-colors">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><TrendingUp className="w-4 h-4 text-[var(--accent-blue)]" /><h3 className="text-sm font-semibold text-[var(--text-primary)]">用量趋势分析</h3></div>
      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] overflow-x-auto max-w-full">
        {metricOptions.map(opt => <button key={opt.key} onClick={() => setMetricKey(opt.key)} className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer whitespace-nowrap ${metricKey === opt.key ? 'bg-[var(--accent-blue)] text-white shadow-2xs font-bold' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>{opt.label}</button>)}
      </div>
    </div>
    <div className="h-72 lg:h-80 w-full pt-2 min-w-0">
      {data.length ? <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <AreaChart data={data} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
          <defs><linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={isDarkMode ? '#3b82f6' : '#2563eb'} stopOpacity={0.2} /><stop offset="95%" stopColor={isDarkMode ? '#3b82f6' : '#2563eb'} stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? '#262a33' : '#f1f5f9'} vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: isDarkMode ? '#262a33' : '#e5e7eb' }} tick={{ fill: isDarkMode ? '#9ca3af' : '#6b7280', fontSize: 11, fontFamily: 'monospace' }} interval={interval} minTickGap={20} />
          <YAxis tickLine={false} axisLine={false} width={yWidth} tickFormatter={formatYAxis} tick={{ fill: isDarkMode ? '#9ca3af' : '#6b7280', fontSize: 11, fontFamily: 'monospace' }} domain={[0, 'auto']} allowDecimals={metricKey === 'cost'} />
          <Tooltip content={<CustomTooltip />} />
          <Area type="monotone" dataKey={metricKey} stroke={isDarkMode ? '#60a5fa' : '#2563eb'} strokeWidth={2} fillOpacity={1} fill="url(#tokenGradient)" dot={false} activeDot={{ r: 5, fill: isDarkMode ? '#60a5fa' : '#2563eb', stroke: '#ffffff', strokeWidth: 2 }} />
        </AreaChart>
      </ResponsiveContainer> : <div className="h-full grid place-items-center text-xs text-[var(--text-muted)]">当前筛选范围暂无趋势数据</div>}
    </div>
  </div>;
};

interface BreakdownCardsProps { records: UsageRecord[]; }

const breakdownColors = ['bg-blue-600','bg-cyan-500','bg-emerald-500','bg-purple-600','bg-teal-500','bg-orange-500','bg-indigo-600','bg-violet-600','bg-amber-500','bg-rose-500'];
const badgeColors = ['bg-blue-500/10 text-blue-600 dark:text-blue-400','bg-cyan-500/10 text-cyan-600 dark:text-cyan-400','bg-emerald-500/10 text-emerald-600 dark:text-emerald-400','bg-purple-500/10 text-purple-600 dark:text-purple-400','bg-teal-500/10 text-teal-600 dark:text-teal-400','bg-orange-500/10 text-orange-600 dark:text-orange-400','bg-indigo-500/10 text-indigo-600 dark:text-indigo-400','bg-violet-500/10 text-violet-600 dark:text-violet-400'];

function total(r: UsageRecord) { return r.totalTokens || 0; }
function aggregate(records: UsageRecord[], key: (r: UsageRecord) => string, limit = 6) {
  const map = new Map<string, { value: number; rows: UsageRecord[] }>();
  for (const row of records) { const name = key(row) || '未知'; const item = map.get(name) || { value: 0, rows: [] }; item.value += total(row); item.rows.push(row); map.set(name, item); }
  const sum = [...map.values()].reduce((a,b) => a + b.value, 0) || 1;
  return [...map.entries()].map(([name, item]) => ({ name, value: item.value, pct: item.value / sum * 100, rows: item.rows })).sort((a,b) => b.value - a.value).slice(0, limit);
}
function fmt(n: number) { return Math.round(n).toLocaleString(); }
function pct(n: number) { return n >= 10 ? n.toFixed(1) : n.toFixed(1); }

const routeTypeLabels: Record<string,string> = { official:'官方',cloud:'云服务',aggregator:'聚合服务',relay:'中转','inference-provider':'推理服务',inference:'推理服务','self-hosted':'自托管',self_hosted:'自托管',custom:'自定义',unknown:'未知' };

const BreakdownCards: React.FC<BreakdownCardsProps> = ({ records }) => {
  const devices = aggregate(records, r => r.device, 5);
  const routes = aggregate(records, r => r.routeProvider, 6);
  const models = aggregate(records, r => r.model, 6);
  const tools = aggregate(records, r => r.tool, 6);

  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4 shadow-2xs space-y-3 transition-breakdownColors">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]"><div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]"><HardDrive className="w-4 h-4 text-[var(--accent-blue)]" /><span>设备分布</span></div><span className="text-[10px] font-mono text-[var(--text-muted)]">{devices.length} Devices</span></div>
      <div className="space-y-3">{devices.map((d,i) => { const row = d.rows[0]; return <div key={d.name} className="space-y-1"><div className="flex items-center justify-between text-xs"><div className="flex items-center gap-1.5 truncate max-w-[220px]"><span className="font-mono text-[var(--text-primary)] font-semibold truncate" title={d.name}>{d.name}</span><span className={`px-1.5 py-0.2 rounded text-[9px] font-mono border border-transparent ${badgeColors[i%badgeColors.length]}`}>{row.architecture}</span></div><div className="flex items-center gap-2 font-mono text-[11px]"><span className="text-[var(--text-muted)]">{fmt(d.value)}</span><span className="font-bold text-[var(--text-primary)]">{pct(d.pct)}%</span></div></div><div className="w-full h-1.5 bg-[var(--bg-main)] rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all ${breakdownColors[i%breakdownColors.length]}`} style={{width:`${d.pct}%`}} /></div></div>; })}{!devices.length && <div className="text-xs text-[var(--text-muted)]">暂无设备数据</div>}</div>
    </div>

    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4 shadow-2xs space-y-3 transition-breakdownColors">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]"><div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]"><Route className="w-4 h-4 text-emerald-500" /><span>路由提供商</span></div><span className="text-[10px] font-mono text-[var(--text-muted)]">Official / Proxy</span></div>
      <div className="space-y-2.5">{routes.map((r,i) => { const row = r.rows[0]; return <div key={r.name} className="space-y-1"><div className="flex items-center justify-between text-xs"><div className="flex items-center gap-1.5 min-w-0"><span className="font-medium text-[var(--text-primary)] truncate" title={r.name}>{r.name}</span><span className={`px-1.5 py-0.2 rounded text-[9px] font-mono ${badgeColors[i%badgeColors.length]}`}>{routeTypeLabels[row.routeType] || row.routeType}</span></div><div className="flex items-center gap-2 font-mono text-[11px]"><span className="text-[var(--text-muted)]">{fmt(r.value)}</span><span className="font-bold text-[var(--text-primary)]">{pct(r.pct)}%</span></div></div><div className="w-full h-1.5 bg-[var(--bg-main)] rounded-full overflow-hidden"><div className={`h-full rounded-full ${breakdownColors[(i+2)%breakdownColors.length]}`} style={{width:`${r.pct}%`}} /></div></div>; })}{!routes.length && <div className="text-xs text-[var(--text-muted)]">暂无路由数据</div>}</div>
    </div>

    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4 shadow-2xs space-y-3 transition-breakdownColors">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]"><div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]"><Cpu className="w-4 h-4 text-purple-500" /><span>模型分布</span></div><span className="text-[10px] font-mono text-[var(--text-muted)]">Top Models</span></div>
      <div className="space-y-2.5">{models.map((m,i) => { const row = m.rows[0]; return <div key={m.name} className="space-y-1"><div className="flex items-center justify-between text-xs"><div className="flex items-center gap-1.5 min-w-0 max-w-[65%]"><span className="font-mono text-[var(--text-primary)] font-semibold truncate" title={m.name}>{m.name}</span><span className={`px-1 py-0.1 rounded text-[9px] font-mono ${badgeColors[i%badgeColors.length]}`}>{row.vendor}</span><span className="px-1 py-0.1 rounded text-[9px] font-mono bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold">{row.tier}</span></div><div className="flex items-center gap-2 font-mono text-[11px]"><span className="text-[var(--text-muted)]">{fmt(m.value)}</span><span className="font-bold text-[var(--text-primary)]">{pct(m.pct)}%</span></div></div><div className="w-full h-1.5 bg-[var(--bg-main)] rounded-full overflow-hidden"><div className={`h-full rounded-full ${breakdownColors[(i+4)%breakdownColors.length]}`} style={{width:`${m.pct}%`}} /></div></div>; })}{!models.length && <div className="text-xs text-[var(--text-muted)]">暂无模型数据</div>}</div>
    </div>

    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4 shadow-2xs space-y-3 transition-breakdownColors">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]"><div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]"><Wrench className="w-4 h-4 text-amber-500" /><span>AI 编程工具</span></div><span className="text-[10px] font-mono text-[var(--text-muted)]">Clients</span></div>
      <div className="space-y-2.5">{tools.map((t,i) => <div key={t.name} className="space-y-1"><div className="flex items-center justify-between text-xs"><div className="flex items-center gap-1.5 min-w-0"><span className="font-medium text-[var(--text-primary)] truncate" title={t.name}>{t.name}</span><span className={`px-1.5 py-0.2 rounded text-[9px] font-mono ${badgeColors[i%badgeColors.length]}`}>{t.name}</span></div><div className="flex items-center gap-2 font-mono text-[11px]"><span className="text-[var(--text-muted)]">{fmt(t.value)}</span><span className="font-bold text-[var(--text-primary)]">{pct(t.pct)}%</span></div></div><div className="w-full h-1.5 bg-[var(--bg-main)] rounded-full overflow-hidden"><div className={`h-full rounded-full ${breakdownColors[(i+6)%breakdownColors.length]}`} style={{width:`${t.pct}%`}} /></div></div>)}{!tools.length && <div className="text-xs text-[var(--text-muted)]">暂无工具数据</div>}</div>
    </div>
  </div>;
};

interface DevicesViewProps { devices: DeviceInfo[]; }

const DevicesView: React.FC<DevicesViewProps> = ({ devices }) => (
  <div className="space-y-4 transition-colors">
    <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-4 shadow-2xs">
      <div><h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2"><HardDrive className="w-4 h-4 text-[var(--accent-blue)]" /><span>已知同步设备 (Devices Console)</span></h2><p className="text-xs text-[var(--text-muted)] mt-0.5">监控已关联 UsageMesh 工作区的本地及远程开发终端状态</p></div>
      <div className="px-3 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-xs font-mono text-[var(--text-secondary)]">Command: <code className="text-[var(--accent-blue)] font-bold">usagemesh sync</code></div>
    </div>
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl shadow-2xs overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <thead className="bg-[var(--bg-main)] text-[var(--text-muted)] font-mono uppercase tracking-wider border-b border-[var(--border-color)]"><tr><th className="px-4 py-3">设备名称</th><th className="px-4 py-3">平台</th><th className="px-4 py-3">架构</th><th className="px-4 py-3">最近同步</th><th className="px-4 py-3 text-right">Tokens 用量</th><th className="px-4 py-3 text-right">订阅等价费用</th><th className="px-4 py-3 text-right">请求数</th><th className="px-4 py-3 text-right">用量占比</th><th className="px-4 py-3 text-center">状态</th></tr></thead>
      <tbody className="divide-y divide-[var(--border-subtle)] font-mono">{devices.map(dev => <tr key={dev.id} className="hover:bg-[var(--bg-card-hover)] transition"><td className="px-4 py-3 font-semibold text-[var(--text-primary)]"><div className="flex items-center gap-2"><Monitor className="w-4 h-4 text-[var(--accent-blue)]" /><span>{dev.name}</span></div></td><td className="px-4 py-3 text-[var(--text-secondary)]"><span className="font-sans font-medium">{dev.platform}</span></td><td className="px-4 py-3 text-[var(--text-muted)]"><span className="px-2 py-0.5 rounded bg-[var(--bg-main)] border border-[var(--border-color)] text-[10px]">{dev.architecture}</span></td><td className="px-4 py-3 text-[var(--text-muted)]"><div className="flex items-center gap-1"><Clock className="w-3 h-3 text-emerald-500" /><span>{dev.lastSync}</span></div></td><td className="px-4 py-3 text-right font-bold text-[var(--text-primary)]">{Math.round(dev.totalTokens).toLocaleString()}</td><td className="px-4 py-3 text-right font-bold text-emerald-600">${dev.cost.toFixed(4)}</td><td className="px-4 py-3 text-right text-[var(--text-secondary)]">{dev.requestsCount.toLocaleString()}</td><td className="px-4 py-3 text-right"><div className="inline-flex items-center gap-1.5"><div className="w-12 h-1.5 bg-[var(--bg-main)] rounded-full overflow-hidden"><div className="h-full bg-[var(--accent-blue)] rounded-full" style={{width:`${dev.sharePercentage}%`}} /></div><span className="font-bold text-[var(--text-primary)]">{dev.sharePercentage.toFixed(1)}%</span></div></td><td className="px-4 py-3 text-center"><span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 font-semibold text-[10px]"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />在线已同步</span></td></tr>)}{!devices.length && <tr><td colSpan={9} className="px-4 py-12 text-center text-[var(--text-muted)]">暂无设备数据</td></tr>}</tbody>
    </table></div></div>
  </div>
);

interface AggregatedDataViewProps { records: UsageRecord[]; }

const tableRouteTypeLabels: Record<string,string> = { official:'官方',cloud:'云服务',aggregator:'聚合服务',relay:'中转','inference-provider':'推理服务',inference:'推理服务','self-hosted':'自托管',self_hosted:'自托管',custom:'自定义',unknown:'未知' };

const AggregatedDataView: React.FC<AggregatedDataViewProps> = ({ records }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState<keyof UsageRecord>('date');
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = useMemo(() => {
    const query = searchTerm.toLowerCase();
    const filtered = records.filter(r => !query || [r.device,r.tool,r.model,r.vendor,r.routeProvider,r.rawProvider,r.tier].some(v => String(v).toLowerCase().includes(query)));
    return [...filtered].sort((a,b) => {
      const av = a[sortField] as any, bv = b[sortField] as any;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN', { numeric: true });
      return sortAsc ? cmp : -cmp;
    });
  }, [records, searchTerm, sortField, sortAsc]);

  const handleSort = (field: keyof UsageRecord) => { if (sortField === field) setSortAsc(!sortAsc); else { setSortField(field); setSortAsc(false); } };
  const csv = (value: unknown) => { const s = String(value ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const exportToCSV = () => {
    const headers = ['Date','Device','Tool','Model','Vendor','Route Provider','Route Type','Raw Provider','Tier','Input Tokens','Cache Read','Cache Write','Output Tokens','Reasoning','Total Tokens','Requests','Subscription Equivalent Cost USD','Dynamic Pricing'];
    const rows = sorted.map(r => [r.date,r.device,r.tool,r.model,r.vendor,r.routeProvider,r.routeType,r.rawProvider,r.tier,r.inputTokens,r.cacheReadTokens,r.cacheWriteTokens,r.outputTokens,r.reasoningTokens,r.totalTokens,r.requestsCount,r.cost.toFixed(6),r.pricingResolved ? 'Dynamic' : 'Stored']);
    const blob = new Blob([[headers,...rows].map(row => row.map(csv).join(',')).join('\n')], { type:'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `usagemesh-export-${Date.now()}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  const vendorBadge = (vendor: string) => {
    const lower = vendor.toLowerCase();
    const cls = lower.includes('openai') ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : lower.includes('anthropic') ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400' : lower.includes('google') ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' : lower.includes('deepseek') ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400' : 'bg-slate-500/15 text-slate-600 dark:text-slate-400';
    return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${cls}`}>{vendor || 'Unknown'}</span>;
  };
  const routeBadge = (type: string) => <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${type === 'official' ? 'bg-emerald-500/15 text-emerald-600' : type === 'cloud' ? 'bg-sky-500/15 text-sky-600' : type === 'aggregator' ? 'bg-purple-500/15 text-purple-600' : 'bg-slate-500/15 text-slate-600'}`}>{tableRouteTypeLabels[type] || type || '未知'}</span>;
  const tierBadge = (tier: string) => <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${/fast|priority/i.test(tier) ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400 font-bold' : 'bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--text-secondary)]'}`}>{tier}</span>;

  return <div className="space-y-4 transition-colors">
    <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-3.5 shadow-2xs"><div className="flex items-center gap-2"><TableIcon className="w-4 h-4 text-[var(--accent-blue)]" /><h2 className="text-sm font-semibold text-[var(--text-primary)]">聚合明细数据 (Aggregated Records)</h2><span className="text-xs font-mono text-[var(--text-muted)]">({sorted.length} 条记录)</span></div><div className="flex items-center gap-2 flex-wrap"><div className="relative"><input type="text" placeholder="搜索模型、设备、路由..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="bg-[var(--bg-main)] text-[var(--text-primary)] text-xs border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:border-[var(--accent-blue)] w-48 lg:w-64" /><Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-[var(--text-muted)]" /></div><button onClick={exportToCSV} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent-blue)] text-white text-xs font-medium hover:bg-blue-600 active:scale-95 transition cursor-pointer shadow-2xs"><Download className="w-3.5 h-3.5" /><span>导出 CSV</span></button></div></div>
    <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl shadow-2xs overflow-hidden"><div className="overflow-x-auto max-h-[620px]"><table className="w-full text-left text-xs whitespace-nowrap">
      <thead className="sticky top-0 z-10 bg-[var(--bg-main)] text-[var(--text-muted)] font-mono uppercase tracking-wider border-b border-[var(--border-color)] select-none"><tr>
        <th onClick={() => handleSort('date')} className="px-3.5 py-3 cursor-pointer hover:text-[var(--text-primary)]"><div className="flex items-center gap-1"><span>日期</span><ArrowUpDown className="w-3 h-3" /></div></th>
        <th onClick={() => handleSort('device')} className="px-3.5 py-3 cursor-pointer">设备</th><th onClick={() => handleSort('tool')} className="px-3.5 py-3 cursor-pointer">工具</th><th onClick={() => handleSort('model')} className="px-3.5 py-3 cursor-pointer">模型</th><th onClick={() => handleSort('vendor')} className="px-3.5 py-3 cursor-pointer">模型厂商</th><th onClick={() => handleSort('routeProvider')} className="px-3.5 py-3 cursor-pointer">路由提供商</th><th className="px-3.5 py-3">路由类型</th><th className="px-3.5 py-3">Tier</th><th onClick={() => handleSort('inputTokens')} className="px-3.5 py-3 text-right cursor-pointer">输入 Tokens</th><th onClick={() => handleSort('cacheReadTokens')} className="px-3.5 py-3 text-right cursor-pointer">Cache Read</th><th onClick={() => handleSort('cacheWriteTokens')} className="px-3.5 py-3 text-right cursor-pointer">Cache Write</th><th onClick={() => handleSort('outputTokens')} className="px-3.5 py-3 text-right cursor-pointer">输出 Tokens</th><th onClick={() => handleSort('reasoningTokens')} className="px-3.5 py-3 text-right cursor-pointer">Reasoning</th><th onClick={() => handleSort('totalTokens')} className="px-3.5 py-3 text-right cursor-pointer">总 Tokens</th><th onClick={() => handleSort('cost')} className="px-3.5 py-3 text-right cursor-pointer">订阅等价费用</th>
      </tr></thead>
      <tbody className="divide-y divide-[var(--border-subtle)] font-mono">{sorted.map(r => <tr key={r.id} className="hover:bg-[var(--bg-card-hover)] transition h-11"><td className="px-3.5 py-2.5 text-[var(--text-secondary)]">{r.date}</td><td className="px-3.5 py-2.5 font-medium text-[var(--text-primary)]">{r.device}</td><td className="px-3.5 py-2.5 text-[var(--text-primary)] font-semibold">{r.tool}</td><td className="px-3.5 py-2.5 font-bold text-[var(--accent-blue)] max-w-[260px] truncate" title={r.model}>{r.model}</td><td className="px-3.5 py-2.5">{vendorBadge(r.vendor)}</td><td className="px-3.5 py-2.5 text-[var(--text-primary)]">{r.routeProvider}</td><td className="px-3.5 py-2.5">{routeBadge(r.routeType)}</td><td className="px-3.5 py-2.5">{tierBadge(r.tier)}</td><td className="px-3.5 py-2.5 text-right">{r.inputTokens.toLocaleString()}</td><td className="px-3.5 py-2.5 text-right text-indigo-500">{r.cacheReadTokens.toLocaleString()}</td><td className="px-3.5 py-2.5 text-right text-slate-500">{r.cacheWriteTokens.toLocaleString()}</td><td className="px-3.5 py-2.5 text-right text-amber-500">{r.outputTokens.toLocaleString()}</td><td className="px-3.5 py-2.5 text-right text-purple-500">{r.reasoningTokens.toLocaleString()}</td><td className="px-3.5 py-2.5 text-right font-bold text-[var(--text-primary)]">{r.totalTokens.toLocaleString()}</td><td className="px-3.5 py-2.5 text-right font-bold text-emerald-600" title={r.pricingResolved ? '动态价格' : '账本内价格'}>${r.cost.toFixed(4)}</td></tr>)}{!sorted.length && <tr><td colSpan={15} className="py-12 text-center text-[var(--text-muted)]">当前筛选范围暂无记录</td></tr>}</tbody>
    </table></div><div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-color)] bg-[var(--bg-main)] text-xs"><div className="text-[var(--text-muted)] font-mono">显示 1 - {sorted.length} 共 {sorted.length} 条记录</div><div className="flex items-center gap-1.5"><button disabled className="p-1 rounded border border-[var(--border-color)] text-[var(--text-muted)] opacity-50"><ChevronLeft className="w-4 h-4" /></button><span className="px-2 py-0.5 rounded bg-[var(--accent-blue)] text-white font-mono font-bold">1</span><button disabled className="p-1 rounded border border-[var(--border-color)] text-[var(--text-muted)] opacity-50"><ChevronRight className="w-4 h-4" /></button></div></div></div>
  </div>;
};

interface Props { isDarkMode: boolean; records: UsageRecord[]; }
type Metric = 'totalTokens' | 'cost' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens' | 'requestsCount';
type Group = 'date' | 'device' | 'tool' | 'model' | 'vendor' | 'routeProvider' | 'routeType' | 'rawProvider' | 'tier';
type ChartType = 'bar' | 'line' | 'pie' | 'table';

const metricLabels: Record<Metric,string> = { totalTokens:'总 Tokens',cost:'订阅等价费用',inputTokens:'输入 Tokens',cacheReadTokens:'Cache Read',cacheWriteTokens:'Cache Write',outputTokens:'输出 Tokens',reasoningTokens:'Reasoning',requestsCount:'请求记录' };
const groupLabels: Record<Group,string> = { date:'时间',device:'设备',tool:'工具',model:'模型',vendor:'模型厂商',routeProvider:'路由提供商',routeType:'路由类型',rawProvider:'原始 Provider',tier:'Tier' };
const analysisColors = ['#2563eb','#10b981','#8b5cf6','#f59e0b','#06b6d4','#ec4899','#6366f1','#14b8a6'];
const analysisCompact = (n:number) => n >= 1e9 ? `${(n/1e9).toFixed(1)}B` : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(0)}K` : Math.round(n).toString();

const UsageAnalysisView: React.FC<Props> = ({ isDarkMode, records }) => {
  type Dimension = 'model' | 'device' | 'tool' | 'tier' | 'routeProvider';
  type Metric = 'totalTokens' | 'cost' | 'requestsCount';
  const [dimension, setDimension] = useState<Dimension>('model');
  const [metric, setMetric] = useState<Metric>('totalTokens');

  const summary = useMemo(() => {
    const totalTokens = sum(records, 'totalTokens');
    const input = sum(records, 'inputTokens');
    const cacheRead = sum(records, 'cacheReadTokens');
    const cacheWrite = sum(records, 'cacheWriteTokens');
    const output = sum(records, 'outputTokens') + sum(records, 'reasoningTokens');
    const requests = sum(records, 'requestsCount');
    const cost = sum(records, 'cost');
    const inputSide = input + cacheRead + cacheWrite;
    return {
      cacheHitRate: inputSide ? cacheRead / inputSide * 100 : 0,
      freshInputShare: inputSide ? input / inputSide * 100 : 0,
      outputInputRatio: inputSide ? output / inputSide * 100 : 0,
      avgTokensPerRequest: requests ? totalTokens / requests : 0,
      avgCostPerRequest: requests ? cost / requests : 0,
      equivalentCostPerMillion: totalTokens ? cost / totalTokens * 1_000_000 : 0,
    };
  }, [records]);

  const dimensionLabels: Record<Dimension, string> = { model:'模型', device:'设备', tool:'客户端', tier:'模式', routeProvider:'路由' };
  const metricLabels: Record<Metric, string> = { totalTokens:'Tokens', cost:'订阅等价费用', requestsCount:'请求记录' };

  const grouped = useMemo(() => {
    const map = new Map<string, { name:string; totalTokens:number; cost:number; requestsCount:number }>();
    for (const row of records) {
      const name = String(row[dimension] || '未知');
      const item = map.get(name) || { name, totalTokens:0, cost:0, requestsCount:0 };
      item.totalTokens += row.totalTokens; item.cost += row.cost; item.requestsCount += row.requestsCount;
      map.set(name, item);
    }
    return [...map.values()].sort((a,b) => Number(b[metric]) - Number(a[metric])).slice(0,14);
  }, [records, dimension, metric]);

  const topShare = useMemo(() => {
    const total = grouped.reduce((n,item) => n + Number(item[metric]), 0);
    const top3 = grouped.slice(0,3).reduce((n,item) => n + Number(item[metric]), 0);
    return total ? top3 / total * 100 : 0;
  }, [grouped, metric]);

  const matrix = useMemo(() => {
    const dt = new Map<string,number>(), mt = new Map<string,number>();
    for (const row of records) { dt.set(row.device,(dt.get(row.device)||0)+row.totalTokens); mt.set(row.model,(mt.get(row.model)||0)+row.totalTokens); }
    const devices=[...dt.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([n])=>n);
    const models=[...mt.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([n])=>n);
    const values=new Map<string,number>(); let max=1;
    for (const row of records) if (devices.includes(row.device) && models.includes(row.model)) {
      const key=`${row.device}|||${row.model}`; const value=(values.get(key)||0)+row.totalTokens; values.set(key,value); max=Math.max(max,value);
    }
    return {devices,models,values,max};
  }, [records]);

  const combinations = useMemo(() => {
    const map = new Map<string,{device:string;model:string;tool:string;tier:string;totalTokens:number;cost:number;requests:number;cacheRead:number;inputSide:number}>();
    for (const row of records) {
      const key=`${row.device}|||${row.model}|||${row.tool}|||${row.tier}`;
      const item=map.get(key)||{device:row.device,model:row.model,tool:row.tool,tier:row.tier,totalTokens:0,cost:0,requests:0,cacheRead:0,inputSide:0};
      item.totalTokens+=row.totalTokens; item.cost+=row.cost; item.requests+=row.requestsCount; item.cacheRead+=row.cacheReadTokens; item.inputSide+=row.inputTokens+row.cacheReadTokens+row.cacheWriteTokens; map.set(key,item);
    }
    return [...map.values()].sort((a,b)=>b.totalTokens-a.totalTokens).slice(0,12);
  }, [records]);

  const compact=(value:number)=>analysisCompact(Number(value||0));
  const metricFormat=(value:number)=>metric==='cost'?`$${Number(value).toFixed(value<1?3:2)}`:metric==='requestsCount'?Math.round(value).toLocaleString():compact(value);
  const barTooltip=({active,payload}:any)=>active&&payload?.length?<div className="rounded-xl border border-slate-800 bg-slate-950/95 p-3 text-xs text-white shadow-xl font-mono min-w-[220px]"><div className="mb-2 border-b border-slate-800 pb-1.5 text-slate-400 break-all">{payload[0].payload.name}</div><div className="flex justify-between gap-4"><span>{metricLabels[metric]}</span><span className="font-bold text-blue-400">{metricFormat(Number(payload[0].payload[metric]))}</span></div><div className="mt-1 flex justify-between gap-4 text-slate-400"><span>Tokens</span><span>{Math.round(payload[0].payload.totalTokens).toLocaleString()}</span></div><div className="mt-1 flex justify-between gap-4 text-slate-400"><span>费用</span><span>${payload[0].payload.cost.toFixed(4)}</span></div></div>:null;

  const stats=[
    ['缓存命中率',`${summary.cacheHitRate.toFixed(1)}%`,'输入侧缓存读取占比'],
    ['平均 Tokens / 请求',Math.round(summary.avgTokensPerRequest).toLocaleString(),`平均费用 $${summary.avgCostPerRequest.toFixed(3)}`],
    ['输出 / 输入侧',`${summary.outputInputRatio.toFixed(1)}%`,`新增输入占比 ${summary.freshInputShare.toFixed(1)}%`],
    ['等价费用 / 1M Tokens',`$${summary.equivalentCostPerMillion.toFixed(2)}`,'用于结构效率比较，不代表账单'],
  ];

  return <div className="space-y-4 transition-colors">
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-2xs">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-[var(--accent-blue)]" /><h2 className="text-base font-semibold text-[var(--text-primary)]">分析工作台</h2></div><p className="mt-1 text-xs text-[var(--text-muted)]">概览回答“用了多少”，这里用于定位“为什么高、由谁贡献、结构是否健康”。</p></div><div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2 text-right"><div className="text-[10px] text-[var(--text-muted)]">TOP 3 集中度</div><div className="font-mono text-sm font-bold text-[var(--text-primary)]">{topShare.toFixed(1)}%</div></div></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map(([label,value,note])=><div key={label} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/50 p-3.5"><div className="text-[11px] font-medium text-[var(--text-muted)]">{label}</div><div className="mt-1 font-mono-numbers text-xl font-bold text-[var(--text-primary)]">{value}</div><div className="mt-1 text-[10px] text-[var(--text-muted)]">{note}</div></div>)}</div>
    </section>

    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3.5"><div><h3 className="text-sm font-semibold text-[var(--text-primary)]">结构贡献</h3><p className="mt-0.5 text-xs text-[var(--text-muted)]">切换维度与指标，找出当前筛选范围内的主要贡献者</p></div><div className="flex gap-2"><label className="text-[10px] text-[var(--text-muted)]">维度<select value={dimension} onChange={e=>setDimension(e.target.value as Dimension)} className="mt-1 block h-8 rounded-lg border border-[var(--border-color)] bg-[var(--bg-main)] px-2.5 text-xs text-[var(--text-primary)]">{Object.entries(dimensionLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label className="text-[10px] text-[var(--text-muted)]">指标<select value={metric} onChange={e=>setMetric(e.target.value as Metric)} className="mt-1 block h-8 rounded-lg border border-[var(--border-color)] bg-[var(--bg-main)] px-2.5 text-xs text-[var(--text-primary)]">{Object.entries(metricLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label></div></div>
      <div className="h-[390px] w-full p-3 lg:p-4"><ResponsiveContainer width="100%" height="100%"><BarChart data={grouped} layout="vertical" margin={{top:4,right:28,left:12,bottom:4}}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={isDarkMode?'#262a33':'#eef2f7'} /><XAxis type="number" tickFormatter={metricFormat} tick={{fontSize:10,fill:isDarkMode?'#9ca3af':'#667085'}} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="name" width={120} tick={{fontSize:10,fill:isDarkMode?'#d1d5db':'#475467'}} axisLine={false} tickLine={false} tickFormatter={v=>String(v).length>18?`${String(v).slice(0,18)}…`:String(v)}/><Tooltip content={barTooltip}/><Bar dataKey={metric} fill="#2563eb" radius={[0,4,4,0]}/></BarChart></ResponsiveContainer></div>
    </section>

    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="border-b border-[var(--border-color)] px-4 py-3.5"><div className="flex items-center gap-2"><Monitor className="h-4 w-4 text-[var(--accent-blue)]"/><h3 className="text-sm font-semibold text-[var(--text-primary)]">设备 × 模型用量矩阵</h3></div><p className="mt-0.5 text-xs text-[var(--text-muted)]">快速识别某台机器是否集中消耗在某个模型上</p></div>
      <div className="overflow-x-auto p-4">{matrix.devices.length&&matrix.models.length?<div className="min-w-[760px]"><div className="grid gap-1.5" style={{gridTemplateColumns:`180px repeat(${matrix.models.length}, minmax(84px, 1fr))`}}><div/>{matrix.models.map(m=><div key={m} className="truncate px-2 pb-1 text-center text-[10px] font-mono text-[var(--text-muted)]" title={m}>{m}</div>)}{matrix.devices.flatMap(d=>[<div key={`${d}-label`} className="flex items-center truncate pr-3 text-xs font-medium text-[var(--text-primary)]" title={d}>{d}</div>,...matrix.models.map(m=>{const value=matrix.values.get(`${d}|||${m}`)||0;const opacity=value?0.12+0.78*(value/matrix.max):0.04;return <div key={`${d}-${m}`} title={`${d} / ${m}: ${Math.round(value).toLocaleString()} Tokens`} className="rounded-md border border-blue-500/10 px-2 py-3 text-center font-mono text-[10px] text-[var(--text-primary)]" style={{backgroundColor:`rgba(37, 99, 235, ${opacity})`}}>{value?compact(value):'—'}</div>})])}</div></div>:<div className="py-10 text-center text-xs text-[var(--text-muted)]">当前筛选范围暂无矩阵数据</div>}</div>
    </section>

    <section className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xs">
      <div className="border-b border-[var(--border-color)] px-4 py-3.5"><div className="flex items-center gap-2"><Table2 className="h-4 w-4 text-[var(--accent-blue)]"/><h3 className="text-sm font-semibold text-[var(--text-primary)]">高消耗组合</h3></div><p className="mt-0.5 text-xs text-[var(--text-muted)]">按“设备 + 模型 + 客户端 + 模式”聚合，便于定位异常来源</p></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="border-b border-[var(--border-color)] bg-[var(--bg-main)] text-[10px] font-mono text-[var(--text-muted)]"><tr><th className="p-3">设备</th><th className="p-3">模型</th><th className="p-3">客户端</th><th className="p-3">模式</th><th className="p-3 text-right">Tokens</th><th className="p-3 text-right">费用</th><th className="p-3 text-right">请求</th><th className="p-3 text-right">缓存命中率</th></tr></thead><tbody className="divide-y divide-[var(--border-subtle)]">{combinations.map((item,i)=>{const hit=item.inputSide?item.cacheRead/item.inputSide*100:0;return <tr key={`${item.device}-${item.model}-${i}`} className="hover:bg-[var(--bg-card-hover)]"><td className="p-3 font-medium text-[var(--text-primary)]">{item.device}</td><td className="p-3 font-mono text-[var(--text-primary)]">{item.model}</td><td className="p-3 text-[var(--text-secondary)]">{item.tool}</td><td className="p-3"><span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-blue-600 dark:text-blue-400">{item.tier}</span></td><td className="p-3 text-right font-mono font-semibold">{Math.round(item.totalTokens).toLocaleString()}</td><td className="p-3 text-right font-mono text-emerald-600">${item.cost.toFixed(4)}</td><td className="p-3 text-right font-mono">{Math.round(item.requests).toLocaleString()}</td><td className="p-3 text-right font-mono">{hit.toFixed(1)}%</td></tr>})}</tbody></table></div>
    </section>
  </div>;
};

function ymd(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function startDaysAgo(days: number) { const d = new Date(); d.setDate(d.getDate() - days); return ymd(d); }
function inTimeRange(row: UsageRecord, filters: FilterState) {
  const date = row.date.slice(0,10);
  const today = ymd(new Date());
  if (filters.timeRange === 'today') return date === today;
  if (filters.timeRange === '7d') return date >= startDaysAgo(6) && date <= today;
  if (filters.timeRange === '30d') return date >= startDaysAgo(29) && date <= today;
  if (filters.timeRange === 'month') return date.startsWith(today.slice(0,7));
  if (filters.timeRange === 'custom') {
    if (filters.customStartDate && date < filters.customStartDate) return false;
    if (filters.customEndDate && date > filters.customEndDate) return false;
  }
  return true;
}
function uniq(records: UsageRecord[], key: keyof UsageRecord): string[] {
  return [...new Set(records.map(r => String(r[key] ?? '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b,'zh-CN',{numeric:true,sensitivity:'base'}));
}
function sum(records: UsageRecord[], key: keyof UsageRecord) { return records.reduce((total,row) => total + Number(row[key] || 0), 0); }

function trend(records: UsageRecord[]): DailyTrendPoint[] {
  const map = new Map<string,DailyTrendPoint>();
  for (const row of records) {
    const date = row.date.slice(0,10) || '未知';
    const item = map.get(date) || { date, label: date.length >= 10 ? `${date.slice(5,7)}/${date.slice(8,10)}` : date, totalTokens:0,cost:0,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,reasoningTokens:0,requestsCount:0 };
    item.totalTokens += row.totalTokens; item.cost += row.cost; item.inputTokens += row.inputTokens; item.cacheReadTokens += row.cacheReadTokens; item.cacheWriteTokens += row.cacheWriteTokens; item.outputTokens += row.outputTokens; item.reasoningTokens += row.reasoningTokens; item.requestsCount += row.requestsCount;
    map.set(date,item);
  }
  return [...map.values()].sort((a,b) => a.date.localeCompare(b.date));
}

function devices(records: UsageRecord[]): DeviceInfo[] {
  const map = new Map<string,{name:string,platform:string,arch:string,updatedAt:string,tokens:number,cost:number,requests:number}>();
  for (const row of records) {
    const item = map.get(row.deviceId) || { name:row.device, platform:row.platform, arch:row.architecture, updatedAt:row.updatedAt, tokens:0,cost:0,requests:0 };
    item.tokens += row.totalTokens; item.cost += row.cost; item.requests += row.requestsCount;
    if (row.updatedAt > item.updatedAt) item.updatedAt = row.updatedAt;
    map.set(row.deviceId,item);
  }
  const total = [...map.values()].reduce((a,b) => a+b.tokens,0) || 1;
  return [...map.entries()].map(([id,d]) => ({ id,name:d.name,platform:d.platform,architecture:d.arch,lastSync:d.updatedAt ? new Date(d.updatedAt).toLocaleString() : '—',totalTokens:d.tokens,cost:d.cost,requestsCount:d.requests,sharePercentage:d.tokens/total*100,status:'online' as const })).sort((a,b) => b.totalTokens-a.totalTokens);
}

function App() {
  const [dataset, setDataset] = useState<DashboardDataset | null>(null);
  const [workspaceKeyValue, setWorkspaceKeyValue] = useState('');
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('usagemesh:theme') === 'dark');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem('usagemesh:sidebar') === 'collapsed');
  const [syncStatus, setSyncStatus] = useState<'synced'|'syncing'|'error'>('synced');
  const [filters, setFilters] = useState<FilterState>({ timeRange:'30d',device:'all',tool:'all',model:'all',vendor:'all',routeProvider:'all',routeType:'all',rawProvider:'all',tier:'all' });

  useEffect(() => { document.documentElement.classList.toggle('dark', isDarkMode); localStorage.setItem('usagemesh:theme', isDarkMode ? 'dark' : 'light'); }, [isDarkMode]);
  useEffect(() => { localStorage.setItem('usagemesh:sidebar', isSidebarCollapsed ? 'collapsed' : 'expanded'); }, [isSidebarCollapsed]);
  useEffect(() => {
    let cancelled = false;
    const repo = repoFromLocation();
    const remembered = readRememberedWorkspaceKey(repo);
    if (!remembered) {
      setIsRestoringSession(false);
      return () => { cancelled = true; };
    }

    setSyncStatus('syncing');
    loadDashboardWithKey(repo, remembered)
      .then(next => {
        if (cancelled) return;
        setDataset(next);
        setWorkspaceKeyValue(remembered);
        setSyncStatus('synced');
      })
      .catch(() => {
        if (cancelled) return;
        setUnlockError('已保存的登录态无法恢复，请重新输入 Dashboard 密码');
        setSyncStatus('error');
      })
      .finally(() => {
        if (!cancelled) setIsRestoringSession(false);
      });
    return () => { cancelled = true; };
  }, []);

  const unlock = async (nextPassword: string) => {
    setUnlockError(null); setSyncStatus('syncing');
    try {
      const { dataset: next, key } = await unlockDashboard(nextPassword);
      rememberWorkspaceKey(next.repo, key);
      setDataset(next);
      setWorkspaceKeyValue(key);
      setSyncStatus('synced');
    }
    catch (error) { setUnlockError(error instanceof Error ? error.message : String(error)); setSyncStatus('error'); throw error; }
  };
  const refresh = async () => {
    if (!workspaceKeyValue) return;
    setSyncStatus('syncing');
    try { setDataset(await loadDashboardWithKey(repoFromLocation(), workspaceKeyValue)); setSyncStatus('synced'); }
    catch { setSyncStatus('error'); }
  };
  const lock = () => {
    forgetRememberedWorkspaceKey(repoFromLocation());
    setDataset(null);
    setWorkspaceKeyValue('');
    setUnlockError(null);
  };

  const options = useMemo<DynamicFilterOptions>(() => {
    const rows = dataset?.records || [];
    return { device:uniq(rows,'device'),tool:uniq(rows,'tool'),model:uniq(rows,'model'),vendor:uniq(rows,'vendor'),routeProvider:uniq(rows,'routeProvider'),routeType:uniq(rows,'routeType'),rawProvider:uniq(rows,'rawProvider'),tier:uniq(rows,'tier') };
  }, [dataset]);

  const filtered = useMemo(() => {
    const rows = dataset?.records || [];
    return rows.filter(row => inTimeRange(row,filters)
      && (filters.device==='all' || row.device===filters.device)
      && (filters.tool==='all' || row.tool===filters.tool)
      && (filters.model==='all' || row.model===filters.model)
      && (filters.vendor==='all' || row.vendor===filters.vendor)
      && (filters.routeProvider==='all' || row.routeProvider===filters.routeProvider)
      && (filters.routeType==='all' || row.routeType===filters.routeType)
      && (filters.rawProvider==='all' || row.rawProvider===filters.rawProvider)
      && (filters.tier==='all' || row.tier===filters.tier));
  }, [dataset,filters]);

  const deviceRows = useMemo(() => devices(filtered), [filtered]);
  const trendRows = useMemo(() => trend(filtered), [filtered]);
  const allDevices = dataset ? new Set(dataset.records.map(r => r.deviceId)).size : 0;

  const totals = useMemo(() => ({ totalTokens:sum(filtered,'totalTokens'),cost:sum(filtered,'cost'),input:sum(filtered,'inputTokens'),cacheRead:sum(filtered,'cacheReadTokens'),output:sum(filtered,'outputTokens'),requests:sum(filtered,'requestsCount') }), [filtered]);

  const resetFilters = () => setFilters({ timeRange:'30d',device:'all',tool:'all',model:'all',vendor:'all',routeProvider:'all',routeType:'all',rawProvider:'all',tier:'all' });
  const changeFilter = (key: keyof FilterState, value: string) => setFilters(prev => ({...prev,[key]:value}));
  const title = activeTab==='overview'?'概览':activeTab==='analytics'?'用量分析':activeTab==='devices'?'设备':'聚合数据';
  const lastSync = dataset?.lastSync ? new Date(dataset.lastSync).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';

  if (!dataset && isRestoringSession) return <div className={isDarkMode ? 'dark' : ''}><div className="min-h-screen bg-[var(--bg-main)] text-[var(--text-primary)] grid place-items-center"><div className="flex items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-4 py-3 text-xs text-[var(--text-muted)] shadow-sm"><RefreshCw className="h-4 w-4 animate-spin text-[var(--accent-blue)]" /><span>正在恢复登录...</span></div></div></div>;
  if (!dataset) return <div className={isDarkMode ? 'dark' : ''}><UnlockScreen onUnlock={unlock} error={unlockError} /></div>;

  return <div className={`flex h-screen overflow-hidden bg-[var(--bg-main)] text-[var(--text-primary)] ${isDarkMode ? 'dark' : ''}`}>
    <Sidebar isCollapsed={isSidebarCollapsed} onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)} activeTab={activeTab} onSelectTab={setActiveTab} syncStatus={syncStatus} deviceCount={allDevices} isDarkMode={isDarkMode} onToggleDarkMode={() => setIsDarkMode(!isDarkMode)} onLock={lock} />
    <div className="flex-1 flex flex-col h-full overflow-y-auto w-full">
      <Topbar title={title} subtitle="跨设备 AI Coding Token、路由来源与订阅等价费用" repoBadge="" pricingBadge="" lastSyncTime={lastSync} syncStatus={syncStatus} deviceCount={allDevices} isDarkMode={isDarkMode} onToggleDarkMode={() => setIsDarkMode(!isDarkMode)} onRefresh={refresh} onLock={lock} isSidebarCollapsed={isSidebarCollapsed} onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)} />
      <main className="flex-1 p-4 lg:p-6 space-y-4 max-w-[1920px] w-full mx-auto">
        {activeTab==='overview' && <><FilterBar filters={filters} options={options} onChangeFilter={changeFilter} onResetFilters={resetFilters} /><KpiCards totalTokens={totals.totalTokens} cost={totals.cost} inputTokens={totals.input} cacheReadTokens={totals.cacheRead} outputTokens={totals.output} requestsCount={totals.requests} pricing={dataset.pricing} /><TrendChart isDarkMode={isDarkMode} data={trendRows} /><BreakdownCards records={filtered} /></>}
        {activeTab==='analytics' && <><FilterBar filters={filters} options={options} onChangeFilter={changeFilter} onResetFilters={resetFilters} /><UsageAnalysisView isDarkMode={isDarkMode} records={filtered} /></>}
        {activeTab==='devices' && <DevicesView devices={deviceRows} />}
        {activeTab==='aggregated' && <><FilterBar filters={filters} options={options} onChangeFilter={changeFilter} onResetFilters={resetFilters} /><KpiCards totalTokens={totals.totalTokens} cost={totals.cost} inputTokens={totals.input} cacheReadTokens={totals.cacheRead} outputTokens={totals.output} requestsCount={totals.requests} pricing={dataset.pricing} /><AggregatedDataView records={filtered} /></>}
      </main>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
