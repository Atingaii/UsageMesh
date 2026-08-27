from pathlib import Path

path = Path("src/app.tsx")
text = path.read_text(encoding="utf-8")

# Keep the dashboard unlocked across reloads without storing the user's plaintext
# password. The decrypted 256-bit workspace key is scoped to the selected repo
# and stored only for the current browser session. Clicking the lock button removes it.
storage_anchor = "const LEDGER_AAD_PREFIX = 'usagemesh-ledger-v2:';"
storage_helpers = r'''const REMEMBERED_WORKSPACE_KEY_PREFIX = 'usagemesh:remembered-workspace-key:v1:';

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
}'''

if "REMEMBERED_WORKSPACE_KEY_PREFIX" not in text:
    if storage_anchor not in text:
        raise SystemExit("ledger AAD anchor not found")
    text = text.replace(storage_anchor, storage_anchor + "\n" + storage_helpers, 1)

old_loader = r'''async function loadDashboard(password: string): Promise<DashboardDataset> {
  const repo = repoFromLocation();
  const key = await workspaceKey(repo, password);
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
}'''

new_loader = r'''async function loadDashboardWithKey(repo: string, key: string): Promise<DashboardDataset> {
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
}'''

if old_loader not in text:
    raise SystemExit("loadDashboard block not found")
text = text.replace(old_loader, new_loader, 1)

old_auth = r'''function App() {
  const [dataset, setDataset] = useState<DashboardDataset | null>(null);
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('usagemesh:theme') === 'dark');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem('usagemesh:sidebar') === 'collapsed');
  const [syncStatus, setSyncStatus] = useState<'synced'|'syncing'|'error'>('synced');
  const [filters, setFilters] = useState<FilterState>({ timeRange:'30d',device:'all',tool:'all',model:'all',vendor:'all',routeProvider:'all',routeType:'all',rawProvider:'all',tier:'all' });

  useEffect(() => { document.documentElement.classList.toggle('dark', isDarkMode); localStorage.setItem('usagemesh:theme', isDarkMode ? 'dark' : 'light'); }, [isDarkMode]);
  useEffect(() => { localStorage.setItem('usagemesh:sidebar', isSidebarCollapsed ? 'collapsed' : 'expanded'); }, [isSidebarCollapsed]);

  const unlock = async (nextPassword: string) => {
    setUnlockError(null); setSyncStatus('syncing');
    try { const next = await loadDashboard(nextPassword); setDataset(next); setPassword(nextPassword); setSyncStatus('synced'); }
    catch (error) { setUnlockError(error instanceof Error ? error.message : String(error)); setSyncStatus('error'); throw error; }
  };
  const refresh = async () => {
    if (!password) return;
    setSyncStatus('syncing');
    try { setDataset(await loadDashboard(password)); setSyncStatus('synced'); }
    catch { setSyncStatus('error'); }
  };
  const lock = () => { setDataset(null); setPassword(''); setUnlockError(null); };'''

new_auth = r'''function App() {
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
  };'''

if old_auth not in text:
    raise SystemExit("App authentication block not found")
text = text.replace(old_auth, new_auth, 1)

old_locked_render = "  if (!dataset) return <div className={isDarkMode ? 'dark' : ''}><UnlockScreen onUnlock={unlock} error={unlockError} /></div>;"
new_locked_render = r'''  if (!dataset && isRestoringSession) return <div className={isDarkMode ? 'dark' : ''}><div className="min-h-screen bg-[var(--bg-main)] text-[var(--text-primary)] grid place-items-center"><div className="flex items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-4 py-3 text-xs text-[var(--text-muted)] shadow-sm"><RefreshCw className="h-4 w-4 animate-spin text-[var(--accent-blue)]" /><span>正在恢复登录...</span></div></div></div>;
  if (!dataset) return <div className={isDarkMode ? 'dark' : ''}><UnlockScreen onUnlock={unlock} error={unlockError} /></div>;'''

if old_locked_render not in text:
    raise SystemExit("locked dashboard render not found")
text = text.replace(old_locked_render, new_locked_render, 1)

for required in [
    "REMEMBERED_WORKSPACE_KEY_PREFIX",
    "loadDashboardWithKey",
    "unlockDashboard",
    "const [workspaceKeyValue, setWorkspaceKeyValue]",
    "rememberWorkspaceKey(next.repo, key)",
    "forgetRememberedWorkspaceKey(repoFromLocation())",
    "正在恢复登录...",
]:
    if required not in text:
        raise SystemExit(f"persistent-login patch missing: {required}")

for forbidden in [
    "setPassword(nextPassword)",
    "loadDashboard(password)",
    "if (!password) return;",
]:
    if forbidden in text:
        raise SystemExit(f"App still depends on plaintext password state: {forbidden}")

path.write_text(text, encoding="utf-8")
