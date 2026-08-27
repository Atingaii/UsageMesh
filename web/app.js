(() => {
  'use strict';

  const A = window.TokenAnalytics;
  if (!A) throw new Error('analytics.js failed to load');

  const API = 'https://api.github.com';
  const RAW = 'https://raw.githubusercontent.com';
  const BRANCH_PREFIX = 'um-ledger-';
  const ACCESS_BRANCH = 'um-dashboard';
  const ACCESS_AAD_PREFIX = 'usagemesh-dashboard-access-v1:';
  const LEDGER_AAD_PREFIX = 'usagemesh-ledger-v2:';
  const PALETTE = [
    '#3b82f6', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899',
    '#6366f1', '#14b8a6', '#f97316', '#64748b', '#0ea5e9', '#a855f7'
  ];
  const METRICS = {
    totalTokens: ['总 Tokens', compact],
    costUsd: ['订阅等价费用', money],
    input: ['输入 Tokens', compact],
    cacheRead: ['缓存读取', compact],
    cacheWrite: ['缓存写入', compact],
    output: ['输出 Tokens', compact],
    reasoning: ['Reasoning', compact],
    messages: ['请求记录', integer]
  };
  const DIMENSIONS = {
    date: '日期',
    device: '设备',
    client: '工具',
    model: '模型',
    upstreamVendor: '模型厂商',
    routeProvider: '路由提供商',
    routeType: '路由类型',
    provider: '原始 Provider',
    tier: 'Tier'
  };
  const ROUTE_TYPE_LABELS = {
    official: '官方',
    cloud: '云服务',
    aggregator: '聚合服务',
    relay: '中转',
    'inference-provider': '推理服务',
    'self-hosted': '自托管',
    custom: '自定义',
    unknown: '未知'
  };

  const state = {
    repo: '',
    key: '',
    accessEnvelope: null,
    ledgers: [],
    rows: [],
    view: 'overview',
    range: '30d',
    customStart: '',
    customEnd: '',
    device: '*',
    client: '*',
    model: '*',
    upstreamVendor: '*',
    routeProvider: '*',
    routeType: '*',
    provider: '*',
    tier: '*',
    metric: 'totalTokens',
    overviewMetric: 'totalTokens',
    group: 'date',
    chart: 'line',
    stack: 'device'
  };

  const $ = id => document.getElementById(id);
  const ids = [
    'appShell','sidebar','sidebarToggle','mobileMenuToggle','mobileBackdrop','brandLink',
    'unlockPanel','unlockForm','passwordInput','unlockButton','unlockError','accessHint',
    'appContent','syncState','updatedAt','refreshButton','viewTitle','subtitle','repoBadge',
    'pricingBadge','themeToggle','rangeButtons','customRange','startDate','endDate',
    'deviceFilter','clientFilter','modelFilter','upstreamFilter','routeProviderFilter',
    'routeTypeFilter','providerFilter','tierFilter','tierFilterLabel','mTotal','mCost',
    'mCostNote','mInput','mCache','mOutput','mMessages','overviewView','analysisView',
    'devicesView','dataView','overviewMetric','overviewTrend','deviceBars','routeBars',
    'modelBars','clientBars','metricSelect','groupSelect','chartSelect','stackSelect',
    'stackLabel','analysisChart','analysisTable','deviceTable','rawTable','exportCsv'
  ];
  const els = Object.fromEntries(ids.map(id => [id, $(id)]));

  function trimZeros(text) {
    return String(text).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }

  function compact(value) {
    const number = Number(value || 0);
    const abs = Math.abs(number);
    const units = [
      [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']
    ];
    for (const [divisor, suffix] of units) {
      if (abs >= divisor) {
        const scaled = number / divisor;
        const digits = Math.abs(scaled) < 10 ? 2 : Math.abs(scaled) < 100 ? 1 : 0;
        return `${trimZeros(scaled.toFixed(digits))}${suffix}`;
      }
    }
    return Math.round(number).toLocaleString('zh-CN');
  }

  function integer(value) {
    return Math.round(Number(value || 0)).toLocaleString('zh-CN');
  }

  function money(value, digits = 2) {
    return `$${Number(value || 0).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    })}`;
  }

  function exactMetric(metric, value) {
    if (metric === 'costUsd') return money(value, 4);
    return integer(value);
  }

  function fmt(metric, value) {
    return (METRICS[metric]?.[1] || compact)(value);
  }

  function axisFmt(metric, value) {
    if (metric === 'costUsd') {
      const abs = Math.abs(Number(value || 0));
      const digits = abs < 1 ? 3 : abs < 100 ? 2 : 1;
      return money(value, digits);
    }
    return compact(value);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function displayDimensionValue(key, value, row = null) {
    const text = String(value ?? '');
    if (key === 'routeProvider' && (text === 'official' || row?.routeType === 'official')) return '官方';
    if (key === 'routeType') return ROUTE_TYPE_LABELS[text] || text || '未知';
    if (!text) return '—';
    return text;
  }

  function deriveRepo() {
    const param = new URLSearchParams(location.search).get('repo');
    if (param && /^[^/]+\/[^/]+$/.test(param)) return param;
    const host = location.hostname.toLowerCase();
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const first = location.pathname.split('/').filter(Boolean)[0];
    return first ? `${owner}/${first}` : `${owner}/${owner}.github.io`;
  }

  function legacyFragmentKey() {
    return new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || '';
  }

  function base64UrlBytes(value) {
    let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4) text += '=';
    return Uint8Array.from(atob(text), char => char.charCodeAt(0));
  }

  function validateWorkspaceKey(value) {
    try {
      return base64UrlBytes(value).length === 32;
    } catch {
      return false;
    }
  }

  async function unwrapAccessEnvelope(envelope, password) {
    if (
      envelope?.kind !== 'usagemesh-dashboard-access' ||
      Number(envelope?.schemaVersion) !== 1 ||
      envelope?.kdf !== 'PBKDF2-HMAC-SHA256' ||
      envelope?.algorithm !== 'AES-256-GCM'
    ) throw new Error('不支持的 Dashboard 访问配置');

    const salt = base64UrlBytes(envelope.salt);
    const nonce = base64UrlBytes(envelope.nonce);
    if (salt.length !== 16 || nonce.length !== 12) throw new Error('Dashboard 访问配置损坏');

    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: Number(envelope.iterations), hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: new TextEncoder().encode(`${ACCESS_AAD_PREFIX}${state.repo.toLowerCase()}`)
        },
        key,
        base64UrlBytes(envelope.ciphertext)
      );
    } catch {
      throw new Error('Dashboard 密码不正确');
    }
    const workspaceKey = new TextDecoder().decode(plaintext);
    if (!validateWorkspaceKey(workspaceKey)) throw new Error('Dashboard 访问配置中的工作区密钥无效');
    return workspaceKey;
  }

  async function decryptLedger(envelope, encodedKey) {
    if (envelope?.kind !== 'usagemesh-encrypted-ledger' || Number(envelope?.schemaVersion) !== 2) {
      throw new Error('不支持的加密账本格式');
    }
    const rawKey = base64UrlBytes(encodedKey);
    if (rawKey.length !== 32) throw new Error('Workspace key 无效');
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlBytes(envelope.nonce),
        additionalData: new TextEncoder().encode(`${LEDGER_AAD_PREFIX}${envelope.deviceHash}`)
      },
      key,
      base64UrlBytes(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function apiJson(path) {
    const response = await fetch(`${API}${path}`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  }

  async function fetchAccessEnvelope() {
    const response = await fetch(`${RAW}/${state.repo}/${ACCESS_BRANCH}/access.json`, { cache: 'no-store' });
    if (response.status === 404) {
      const error = new Error('这个工作区还没有 Dashboard 密码配置');
      error.code = 'ACCESS_NOT_FOUND';
      throw error;
    }
    if (!response.ok) throw new Error(`读取 Dashboard 访问配置失败 (${response.status})`);
    return response.json();
  }

  async function branchLedger(branch) {
    const response = await fetch(`${RAW}/${state.repo}/${branch}/ledger.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取 ${branch} 失败 (${response.status})`);
    return decryptLedger(await response.json(), state.key);
  }

  function setSync(kind, text) {
    els.syncState.classList.toggle('ok', kind === 'ok');
    els.syncState.classList.toggle('loading', kind === 'loading');
    els.syncState.classList.toggle('error', kind === 'error');
    const label = els.syncState.querySelector('.sync-label');
    if (label) label.textContent = text;
    els.syncState.title = text;
  }

  function showUnlock(error = '') {
    els.unlockPanel.classList.remove('hidden');
    els.appContent.classList.add('hidden');
    els.unlockError.textContent = error;
    setSync(error ? 'error' : 'idle', error ? '等待解锁' : '未解锁');
  }

  function showApp() {
    els.unlockPanel.classList.add('hidden');
    els.appContent.classList.remove('hidden');
  }

  async function probeAccess() {
    try {
      state.accessEnvelope = await fetchAccessEnvelope();
      els.accessHint.innerHTML = '使用首台设备设置的密码即可从任意浏览器访问；密码本身不会上传到 GitHub。';
    } catch (error) {
      if (error.code === 'ACCESS_NOT_FOUND') {
        els.accessHint.innerHTML = '当前还是 v1.0 工作区。升级 CLI 后在已配置设备运行 <code>usagemesh password</code> 一次即可启用短密码访问。';
      } else {
        els.accessHint.textContent = error.message || String(error);
      }
    }
  }

  async function loadAll() {
    if (!state.repo) throw new Error('无法判断数据仓库，请在网址添加 ?repo=OWNER/REPO');
    if (!state.key) return showUnlock();

    setSync('loading', '正在读取 GitHub');
    const refs = await apiJson(`/repos/${state.repo}/git/matching-refs/heads/${BRANCH_PREFIX}`);
    const branches = (Array.isArray(refs) ? refs : [])
      .map(ref => String(ref.ref || '').replace(/^refs\/heads\//, ''))
      .filter(branch => branch.startsWith(BRANCH_PREFIX));
    const settled = await Promise.allSettled(branches.map(branchLedger));
    const ledgers = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
    const failures = settled.filter(item => item.status === 'rejected');
    if (!ledgers.length && failures.length) throw failures[0].reason;

    state.ledgers = ledgers;
    state.rows = ledgers.flatMap(ledger => (ledger.rows || []).map(row => ({
      ...row,
      routeProvider: row.routeType === 'official' ? 'official' : (row.routeProvider || 'unknown'),
      device: ledger.device?.id || 'unknown',
      deviceName: ledger.device?.name || ledger.device?.id || 'Unknown',
      platform: ledger.device?.platform || 'unknown',
      arch: ledger.device?.arch || '',
      updatedAt: ledger.generatedAt || ''
    })));

    populateFilters();
    renderPricing();
    renderAll();
    const latest = ledgers.map(ledger => ledger.generatedAt).filter(Boolean).sort().at(-1);
    els.updatedAt.textContent = latest ? `数据 ${new Date(latest).toLocaleString()}` : '暂无设备快照';
    setSync(
      failures.length ? 'error' : 'ok',
      failures.length ? `${ledgers.length} 台已载入，${failures.length} 台失败` : `${ledgers.length} 台设备已同步`
    );
    showApp();
  }

  function renderPricing() {
    const latest = [...state.ledgers]
      .filter(ledger => ledger.generatedAt)
      .sort((left, right) => String(right.generatedAt).localeCompare(String(left.generatedAt)))[0];
    const pricing = latest?.pricing;
    if (pricing?.source) {
      els.pricingBadge.textContent = pricing.source;
      els.pricingBadge.title = [pricing.policy, pricing.compatibility, pricing.sourceUrl].filter(Boolean).join('\n');
    } else {
      els.pricingBadge.textContent = 'Legacy v1.0 价格口径';
      els.pricingBadge.title = '升级并重新同步后会切换为 CC Switch 兼容的订阅等价价格。';
    }
  }

  function unique(key, labelKey = key) {
    const map = new Map();
    for (const row of state.rows) {
      const value = row[key];
      if (value === undefined || value === null || value === '') continue;
      map.set(String(value), displayDimensionValue(key, row[labelKey] ?? value, row));
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  }

  function populateSelect(element, entries, allLabel, stateKey) {
    const current = state[stateKey];
    element.innerHTML = `<option value="*">${esc(allLabel)}</option>${entries
      .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
      .join('')}`;
    element.value = entries.some(([value]) => value === current) ? current : '*';
    state[stateKey] = element.value;
  }

  function populateFilters() {
    populateSelect(els.deviceFilter, unique('device', 'deviceName'), '全部设备', 'device');
    populateSelect(els.clientFilter, unique('client'), '全部工具', 'client');
    populateSelect(els.modelFilter, unique('model'), '全部模型', 'model');
    populateSelect(els.upstreamFilter, unique('upstreamVendor'), '全部厂商', 'upstreamVendor');
    populateSelect(els.routeProviderFilter, unique('routeProvider'), '全部路由', 'routeProvider');
    populateSelect(els.routeTypeFilter, unique('routeType'), '全部类型', 'routeType');
    populateSelect(els.providerFilter, unique('provider'), '全部 Provider', 'provider');
    const tiers = unique('tier');
    populateSelect(els.tierFilter, tiers, '全部 Tier', 'tier');
    els.tierFilterLabel.classList.toggle('hidden', tiers.length === 0);
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function rangeBounds() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (state.range === 'all') return {};
    if (state.range === 'custom') return { start: state.customStart || undefined, end: state.customEnd || undefined };
    let start = new Date(today);
    if (state.range === 'today') return { start: dateKey(today), end: dateKey(today) };
    if (state.range === '7d') start.setDate(start.getDate() - 6);
    else if (state.range === '30d') start.setDate(start.getDate() - 29);
    else if (state.range === 'month') start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { start: dateKey(start), end: dateKey(today) };
  }

  function filtered() {
    return A.filterRows(state.rows, {
      ...rangeBounds(),
      device: state.device,
      client: state.client,
      model: state.model,
      upstreamVendor: state.upstreamVendor,
      routeProvider: state.routeProvider,
      routeType: state.routeType,
      provider: state.provider,
      tier: state.tier
    });
  }

  function setMetricText(element, metric, value, prefix = '') {
    const text = `${prefix}${fmt(metric, value)}`;
    element.textContent = text;
    element.title = `${prefix}${exactMetric(metric, value)}`;
  }

  function renderSummary(rows) {
    const sum = A.sumRows(rows);
    setMetricText(els.mTotal, 'totalTokens', sum.totalTokens);
    els.mCost.textContent = `${sum.costLowerBound ? '≥' : ''}${money(sum.costUsd)}`;
    els.mCost.title = `${sum.costLowerBound ? '≥' : ''}${money(sum.costUsd, 4)}`;
    els.mCostNote.textContent = sum.costLowerBound ? '含无法完全确认的费用下限' : 'CC Switch 兼容订阅等价口径';
    setMetricText(els.mInput, 'input', sum.input);
    setMetricText(els.mCache, 'cacheRead', sum.cacheRead);
    setMetricText(els.mOutput, 'output', Number(sum.output || 0) + Number(sum.reasoning || 0));
    setMetricText(els.mMessages, 'messages', sum.messages);
  }

  function orderedItems(rows, dimension, metric) {
    const items = A.groupRows(rows, dimension, metric).map(item => ({
      ...item,
      displayKey: displayDimensionValue(dimension, item.key)
    }));
    return dimension === 'date' ? items.sort((a, b) => a.key.localeCompare(b.key)) : items;
  }

  function renderRank(container, rows, dimension) {
    const items = orderedItems(rows, dimension, state.overviewMetric).slice(0, 6);
    if (!items.length) {
      container.innerHTML = '<div class="empty">当前筛选无数据</div>';
      return;
    }
    const max = Math.max(...items.map(item => item.value), 1);
    container.innerHTML = items.map(item => `
      <div class="rank-row" title="${esc(`${item.displayKey} · ${exactMetric(state.overviewMetric, item.value)}`)}">
        <span class="rank-name">${esc(item.displayKey)}</span>
        <span class="rank-track"><span class="rank-fill" style="width:${Math.max(1.5, item.value / max * 100)}%"></span></span>
        <span class="rank-value">${esc(fmt(state.overviewMetric, item.value))}</span>
      </div>
    `).join('');
  }

  function node(name, attrs = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  }

  let tooltip;
  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function attachTip(element, text) {
    const tip = ensureTooltip();
    const title = node('title');
    title.textContent = text;
    element.appendChild(title);
    element.addEventListener('pointermove', event => {
      tip.textContent = text;
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 300, event.clientX + 12))}px`;
      tip.style.top = `${Math.max(8, event.clientY - 38)}px`;
      tip.classList.add('visible');
    });
    element.addEventListener('pointerleave', () => tip.classList.remove('visible'));
  }

  function niceAxis(maxValue, metric, targetSteps = 5) {
    const max = Math.max(Number(maxValue || 0), 0);
    if (max === 0) return { max: 1, step: .2, ticks: [0, .2, .4, .6, .8, 1] };
    const rough = max / targetSteps;
    const power = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / power;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
    const step = factor * power;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let value = 0; value <= niceMax + step * .001; value += step) ticks.push(value);
    return { max: niceMax, step, ticks };
  }

  function frame(container, metric, maxValue, bottom = 44) {
    container.innerHTML = '';
    const width = Math.max(container.clientWidth || 700, 280);
    const height = Math.max(container.clientHeight || 320, 220);
    const axis = niceAxis(maxValue, metric);
    const yLabels = axis.ticks.map(value => axisFmt(metric, value));
    const longest = Math.max(...yLabels.map(label => label.length), 4);
    const left = Math.min(112, Math.max(58, 22 + longest * 7.2));
    const margin = { top: 18, right: 18, bottom, left };
    const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' });
    svg.setAttribute('role', 'img');
    container.appendChild(svg);
    return {
      root: svg,
      width,
      height,
      margin,
      innerWidth: Math.max(1, width - margin.left - margin.right),
      innerHeight: Math.max(1, height - margin.top - margin.bottom),
      axis,
      yLabels
    };
  }

  function drawGrid(layout, metric) {
    const ticks = [...layout.axis.ticks].reverse();
    ticks.forEach((value, index) => {
      const ratio = ticks.length <= 1 ? 0 : index / (ticks.length - 1);
      const y = layout.margin.top + layout.innerHeight * ratio;
      layout.root.appendChild(node('line', {
        x1: layout.margin.left,
        y1: y,
        x2: layout.width - layout.margin.right,
        y2: y,
        class: 'grid-line'
      }));
      const label = node('text', {
        x: layout.margin.left - 10,
        y: y + 4,
        'text-anchor': 'end',
        class: 'axis-label'
      });
      label.textContent = axisFmt(metric, value);
      const title = node('title');
      title.textContent = exactMetric(metric, value);
      label.appendChild(title);
      layout.root.appendChild(label);
    });
  }

  function categoryLabel(value, isDate = false) {
    const text = String(value ?? '');
    if (isDate && /^\d{4}-\d{2}-\d{2}$/.test(text)) return text.slice(5);
    return text.length > 16 ? `${text.slice(0, 14)}…` : text;
  }

  function drawXLabels(layout, data, x, keyOf = item => item.displayKey || item.key) {
    const isDate = data.length > 0 && data.every(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item.key)));
    const approxWidth = isDate ? 58 : 90;
    const capacity = Math.max(2, Math.floor(layout.innerWidth / approxWidth));
    const every = Math.max(1, Math.ceil(data.length / capacity));
    const rotate = !isDate && data.length > Math.max(6, capacity * .75);
    data.forEach((item, index) => {
      if (index % every !== 0 && index !== data.length - 1) return;
      const px = x(index);
      const label = node('text', {
        x: px,
        y: layout.height - (rotate ? 8 : 10),
        'text-anchor': rotate ? 'end' : (index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'),
        class: 'axis-label x-axis-label'
      });
      if (rotate) label.setAttribute('transform', `rotate(-28 ${px} ${layout.height - 8})`);
      const full = String(keyOf(item));
      label.textContent = categoryLabel(full, isDate);
      const title = node('title');
      title.textContent = full;
      label.appendChild(title);
      layout.root.appendChild(label);
    });
  }

  function tooltipText(metric, key, value, extra = '') {
    const precise = exactMetric(metric, value);
    return [String(key), extra, precise].filter(Boolean).join(' · ');
  }

  function lineChart(container, items, metric, area = false) {
    if (!items.length) {
      container.innerHTML = '<div class="empty">当前筛选无数据</div>';
      return;
    }
    const data = items.slice(-90);
    const rawMax = Math.max(...data.map(item => item.value), 0);
    const layout = frame(container, metric, rawMax, 46);
    drawGrid(layout, metric);
    const x = index => layout.margin.left + (data.length === 1 ? layout.innerWidth / 2 : index / (data.length - 1) * layout.innerWidth);
    const y = value => layout.margin.top + layout.innerHeight - Number(value || 0) / layout.axis.max * layout.innerHeight;
    const points = data.map((item, index) => [x(index), y(item.value)]);
    const pathText = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px},${py}`).join(' ');

    if (area) {
      const baseline = layout.margin.top + layout.innerHeight;
      layout.root.appendChild(node('path', {
        d: `${pathText} L${points.at(-1)[0]},${baseline} L${points[0][0]},${baseline} Z`,
        class: 'series-area'
      }));
    }
    layout.root.appendChild(node('path', { d: pathText, class: 'series-line' }));

    data.forEach((item, index) => {
      const circle = node('circle', { cx: x(index), cy: y(item.value), r: 3.2, class: 'series-dot' });
      attachTip(circle, tooltipText(metric, item.displayKey || item.key, item.value));
      layout.root.appendChild(circle);
    });
    drawXLabels(layout, data, x);
  }

  function barChart(container, items, metric) {
    const data = items.slice(0, 30);
    if (!data.length) {
      container.innerHTML = '<div class="empty">当前筛选无数据</div>';
      return;
    }
    const rawMax = Math.max(...data.map(item => item.value), 0);
    const layout = frame(container, metric, rawMax, data.length > 8 ? 66 : 46);
    drawGrid(layout, metric);
    const slot = layout.innerWidth / data.length;
    const width = Math.max(2, Math.min(42, slot * .68));
    const xCenter = index => layout.margin.left + index * slot + slot / 2;
    data.forEach((item, index) => {
      const height = Number(item.value || 0) / layout.axis.max * layout.innerHeight;
      const x = xCenter(index) - width / 2;
      const y = layout.margin.top + layout.innerHeight - height;
      const rect = node('rect', { x, y, width, height: Math.max(height, 1), rx: 3, class: 'bar' });
      attachTip(rect, tooltipText(metric, item.displayKey || item.key, item.value));
      layout.root.appendChild(rect);
    });
    drawXLabels(layout, data, xCenter);
  }

  function renderLegend(container, labels) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML = labels.slice(0, 12).map((label, index) => `
      <span class="legend-item" title="${esc(label)}"><i class="legend-dot" style="background:${PALETTE[index % PALETTE.length]}"></i>${esc(label)}</span>
    `).join('');
    container.appendChild(legend);
  }

  function stackedChart(container, rows, primary, secondary, metric) {
    const matrix = A.groupMatrix(rows, primary, secondary, metric);
    const xValues = matrix.xValues.slice(-45);
    if (!xValues.length || !matrix.stacks.length) {
      container.innerHTML = '<div class="empty">当前筛选无数据</div>';
      return;
    }
    const stackTotals = matrix.stacks.map(stack => ({
      stack,
      total: xValues.reduce((sum, x) => sum + matrix.value(x, stack), 0)
    })).sort((a, b) => b.total - a.total);
    const stacks = stackTotals.slice(0, 10).map(item => item.stack);
    const totals = xValues.map(xValue => stacks.reduce((sum, stack) => sum + matrix.value(xValue, stack), 0));
    const rawMax = Math.max(...totals, 0);
    const layout = frame(container, metric, rawMax, xValues.length > 8 ? 66 : 46);
    drawGrid(layout, metric);
    const slot = layout.innerWidth / xValues.length;
    const width = Math.max(2, Math.min(36, slot * .72));
    const xCenter = index => layout.margin.left + index * slot + slot / 2;

    xValues.forEach((xValue, xIndex) => {
      let offset = 0;
      stacks.forEach((stack, stackIndex) => {
        const value = matrix.value(xValue, stack);
        if (value <= 0) return;
        const height = value / layout.axis.max * layout.innerHeight;
        const x = xCenter(xIndex) - width / 2;
        const y = layout.margin.top + layout.innerHeight - offset - height;
        const rect = node('rect', {
          x, y, width, height: Math.max(1, height),
          fill: PALETTE[stackIndex % PALETTE.length],
          class: 'stack-bar'
        });
        const displayX = displayDimensionValue(primary, xValue);
        const displayStack = displayDimensionValue(secondary, stack);
        attachTip(rect, tooltipText(metric, displayX, value, displayStack));
        layout.root.appendChild(rect);
        offset += height;
      });
    });
    const xData = xValues.map(key => ({ key, displayKey: displayDimensionValue(primary, key) }));
    drawXLabels(layout, xData, xCenter);
    renderLegend(container, stacks.map(stack => displayDimensionValue(secondary, stack)));
  }

  function donutChart(container, items, metric) {
    const positive = items.filter(item => item.value > 0);
    if (!positive.length) {
      container.innerHTML = '<div class="empty">当前筛选无数据</div>';
      return;
    }
    const head = positive.slice(0, 8);
    const rest = positive.slice(8).reduce((sum, item) => sum + item.value, 0);
    const data = rest > 0 ? [...head, { key: '其他', displayKey: '其他', value: rest }] : head;
    const total = data.reduce((sum, item) => sum + item.value, 0);
    const layout = frame(container, metric, total, 22);
    const cx = layout.width / 2;
    const cy = layout.margin.top + layout.innerHeight / 2;
    const radius = Math.min(layout.innerWidth, layout.innerHeight) * .32;
    const circumference = Math.PI * 2 * radius;
    let offset = 0;

    data.forEach((item, index) => {
      const length = item.value / total * circumference;
      const circle = node('circle', {
        cx, cy, r: radius,
        fill: 'none',
        stroke: PALETTE[index % PALETTE.length],
        'stroke-width': Math.max(18, radius * .28),
        'stroke-dasharray': `${length} ${circumference - length}`,
        'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${cx} ${cy})`
      });
      attachTip(circle, `${item.displayKey || item.key} · ${exactMetric(metric, item.value)} · ${(item.value / total * 100).toFixed(2)}%`);
      layout.root.appendChild(circle);
      offset += length;
    });
    const center = node('text', { x: cx, y: cy + 5, 'text-anchor': 'middle', class: 'donut-center' });
    center.textContent = fmt(metric, total);
    const title = node('title');
    title.textContent = exactMetric(metric, total);
    center.appendChild(title);
    layout.root.appendChild(center);
    renderLegend(container, data.map(item => item.displayKey || item.key));
  }

  function treemapChart(container, items, metric) {
    const data = items.filter(item => item.value > 0).slice(0, 25);
    if (!data.length) {
      container.innerHTML = '<div class="empty">当前筛选无数据</div>';
      return;
    }
    const layout = frame(container, metric, Math.max(...data.map(item => item.value), 1), 18);
    const rects = A.squarify(data, 8, 8, layout.width - 16, layout.height - 16);
    rects.forEach((item, index) => {
      const rect = node('rect', {
        x: item.x,
        y: item.y,
        width: Math.max(0, item.width - 2),
        height: Math.max(0, item.height - 2),
        rx: 5,
        fill: PALETTE[index % PALETTE.length]
      });
      attachTip(rect, tooltipText(metric, item.displayKey || item.key, item.value));
      layout.root.appendChild(rect);
      if (item.width > 80 && item.height > 32) {
        const label = node('text', { x: item.x + 8, y: item.y + 18, class: 'treemap-label' });
        const text = item.displayKey || item.key;
        label.textContent = text.length > 18 ? `${text.slice(0, 16)}…` : text;
        layout.root.appendChild(label);
      }
    });
  }

  function tableHtml(headers, rows) {
    if (!rows.length) return '<div class="empty">当前筛选无数据</div>';
    return `<table class="data-table"><thead><tr>${headers.map(header =>
      `<th class="${header.number ? 'number' : ''}">${esc(header.label)}</th>`
    ).join('')}</tr></thead><tbody>${rows.map(row =>
      `<tr>${headers.map(header => {
        const value = row[header.key];
        const content = header.render ? header.render(value, row) : esc(displayDimensionValue(header.key, value, row));
        return `<td class="${header.number ? 'number exact-number' : ''}" title="${header.title ? esc(header.title(value, row)) : ''}">${content}</td>`;
      }).join('')}</tr>`
    ).join('')}</tbody></table>`;
  }

  function aggregateTable(rows, dimension, metric) {
    const items = orderedItems(rows, dimension, metric);
    els.analysisTable.innerHTML = tableHtml([
      { key: 'displayKey', label: DIMENSIONS[dimension] || dimension },
      {
        key: 'value',
        label: METRICS[metric]?.[0] || metric,
        number: true,
        render: value => esc(exactMetric(metric, value)),
        title: value => exactMetric(metric, value)
      }
    ], items);
  }

  function renderAnalysis(rows) {
    els.stackLabel.classList.toggle('hidden', state.chart !== 'stacked');
    els.analysisTable.classList.toggle('hidden', state.chart !== 'table');
    els.analysisChart.classList.toggle('hidden', state.chart === 'table');
    const items = orderedItems(rows, state.group, state.metric);
    els.analysisChart.title = state.metric === 'costUsd' && rows.some(row => row.costLowerBound)
      ? '当前筛选包含费用下限估算。' : '';

    if (state.chart === 'line') lineChart(els.analysisChart, items, state.metric, false);
    else if (state.chart === 'area') lineChart(els.analysisChart, items, state.metric, true);
    else if (state.chart === 'bar') barChart(els.analysisChart, items, state.metric);
    else if (state.chart === 'stacked') stackedChart(els.analysisChart, rows, state.group, state.stack, state.metric);
    else if (state.chart === 'donut') donutChart(els.analysisChart, items, state.metric);
    else if (state.chart === 'treemap') treemapChart(els.analysisChart, items, state.metric);
    else aggregateTable(rows, state.group, state.metric);
  }

  function renderDevices(rows) {
    const entries = state.ledgers.map(ledger => {
      const id = ledger.device?.id || 'unknown';
      const sum = A.sumRows(rows.filter(row => row.device === id));
      return {
        name: ledger.device?.name || id,
        platform: ledger.device?.platform || 'unknown',
        arch: ledger.device?.arch || '',
        tokens: sum.totalTokens,
        cost: sum.costUsd,
        lowerBound: sum.costLowerBound,
        messages: sum.messages,
        updatedAt: ledger.generatedAt || '',
        scanMs: ledger.scanMs || 0,
        version: ledger.device?.appVersion || '—'
      };
    }).sort((a, b) => b.tokens - a.tokens);

    els.deviceTable.innerHTML = tableHtml([
      { key: 'name', label: '设备' },
      { key: 'platform', label: '平台' },
      { key: 'arch', label: '架构' },
      { key: 'version', label: 'CLI' },
      { key: 'tokens', label: 'Tokens', number: true, render: value => esc(integer(value)), title: value => integer(value) },
      { key: 'cost', label: '订阅等价费用', number: true, render: (value, row) => esc(`${row.lowerBound ? '≥' : ''}${money(value, 4)}`) },
      { key: 'messages', label: '记录', number: true, render: value => esc(integer(value)) },
      { key: 'updatedAt', label: '数据时间', render: value => esc(value ? new Date(value).toLocaleString() : '—') },
      { key: 'scanMs', label: '扫描耗时', number: true, render: value => esc(`${integer(value)} ms`) }
    ], entries);
  }

  function renderRaw(rows) {
    const data = [...rows]
      .sort((a, b) => b.date.localeCompare(a.date) || a.deviceName.localeCompare(b.deviceName))
      .slice(0, 2000);
    els.rawTable.innerHTML = tableHtml([
      { key: 'date', label: '日期' },
      { key: 'deviceName', label: '设备' },
      { key: 'client', label: '工具' },
      { key: 'upstreamVendor', label: '模型厂商' },
      { key: 'routeProvider', label: '路由提供商', render: (value, row) => esc(displayDimensionValue('routeProvider', value, row)) },
      { key: 'routeType', label: '路由类型', render: value => esc(displayDimensionValue('routeType', value)) },
      { key: 'provider', label: '原始 Provider' },
      { key: 'model', label: '模型' },
      { key: 'tier', label: 'Tier' },
      { key: 'input', label: 'Input', number: true, render: value => esc(integer(value)), title: value => integer(value) },
      { key: 'cacheRead', label: 'Cache R', number: true, render: value => esc(integer(value)), title: value => integer(value) },
      { key: 'cacheWrite', label: 'Cache W', number: true, render: value => esc(integer(value)), title: value => integer(value) },
      { key: 'output', label: 'Output', number: true, render: value => esc(integer(value)), title: value => integer(value) },
      { key: 'reasoning', label: 'Reasoning', number: true, render: value => esc(integer(value)), title: value => integer(value) },
      { key: 'messages', label: '记录', number: true, render: value => esc(integer(value)) },
      { key: 'costUsd', label: '费用', number: true, render: (value, row) => esc(`${row.costLowerBound ? '≥' : ''}${money(value, 4)}`) }
    ], data);
  }

  function renderAll() {
    const rows = filtered();
    renderSummary(rows);
    if (state.view === 'overview') {
      lineChart(els.overviewTrend, orderedItems(rows, 'date', state.overviewMetric), state.overviewMetric, true);
      renderRank(els.deviceBars, rows, 'device');
      renderRank(els.routeBars, rows, 'routeProvider');
      renderRank(els.modelBars, rows, 'model');
      renderRank(els.clientBars, rows, 'client');
    } else if (state.view === 'analysis') {
      renderAnalysis(rows);
    } else if (state.view === 'devices') {
      renderDevices(rows);
    } else if (state.view === 'data') {
      renderRaw(rows);
    }
  }

  function closeMobileMenu() {
    els.appShell.classList.remove('mobile-open');
  }

  function selectView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item[data-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.view === view);
    });
    ['overview','analysis','devices','data'].forEach(name => {
      els[`${name}View`].classList.toggle('hidden', name !== view);
    });
    els.viewTitle.textContent = ({
      overview: '概览', analysis: '用量分析', devices: '设备', data: '聚合数据'
    })[view] || 'UsageMesh';
    closeMobileMenu();
    requestAnimationFrame(renderAll);
  }

  function metricOptions(select, selected) {
    select.innerHTML = Object.entries(METRICS)
      .map(([key, [label]]) => `<option value="${key}">${esc(label)}</option>`)
      .join('');
    select.value = selected;
  }

  function initTheme() {
    const saved = localStorage.getItem('tm-theme');
    const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  }

  function initSidebar() {
    const collapsed = localStorage.getItem('tm-sidebar-collapsed') === '1';
    els.appShell.classList.toggle('is-collapsed', collapsed);
    els.sidebarToggle.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
    els.sidebarToggle.setAttribute('aria-label', els.sidebarToggle.title);
  }

  function wire() {
    metricOptions(els.metricSelect, state.metric);
    metricOptions(els.overviewMetric, state.overviewMetric);

    document.querySelectorAll('.nav-item[data-view]').forEach(button => {
      button.addEventListener('click', () => selectView(button.dataset.view));
    });
    els.brandLink.addEventListener('click', event => {
      event.preventDefault();
      selectView('overview');
    });
    document.querySelectorAll('.jump-analysis').forEach(button => {
      button.addEventListener('click', () => {
        state.group = button.dataset.group;
        els.groupSelect.value = state.group;
        state.chart = state.group === 'date' ? 'line' : 'bar';
        els.chartSelect.value = state.chart;
        selectView('analysis');
      });
    });

    els.sidebarToggle.addEventListener('click', () => {
      const collapsed = !els.appShell.classList.contains('is-collapsed');
      els.appShell.classList.toggle('is-collapsed', collapsed);
      localStorage.setItem('tm-sidebar-collapsed', collapsed ? '1' : '0');
      els.sidebarToggle.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
      els.sidebarToggle.setAttribute('aria-label', els.sidebarToggle.title);
      setTimeout(renderAll, 190);
    });
    els.mobileMenuToggle.addEventListener('click', () => els.appShell.classList.add('mobile-open'));
    els.mobileBackdrop.addEventListener('click', closeMobileMenu);

    els.rangeButtons.addEventListener('click', event => {
      const button = event.target.closest('button[data-range]');
      if (!button) return;
      state.range = button.dataset.range;
      els.rangeButtons.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
      els.customRange.classList.toggle('hidden', state.range !== 'custom');
      renderAll();
    });

    [
      [els.deviceFilter, 'device'], [els.clientFilter, 'client'], [els.modelFilter, 'model'],
      [els.upstreamFilter, 'upstreamVendor'], [els.routeProviderFilter, 'routeProvider'],
      [els.routeTypeFilter, 'routeType'], [els.providerFilter, 'provider'], [els.tierFilter, 'tier']
    ].forEach(([element, key]) => {
      element.addEventListener('change', () => {
        state[key] = element.value;
        renderAll();
      });
    });

    els.startDate.addEventListener('change', () => {
      state.customStart = els.startDate.value;
      renderAll();
    });
    els.endDate.addEventListener('change', () => {
      state.customEnd = els.endDate.value;
      renderAll();
    });
    els.metricSelect.addEventListener('change', () => {
      state.metric = els.metricSelect.value;
      renderAll();
    });
    els.overviewMetric.addEventListener('change', () => {
      state.overviewMetric = els.overviewMetric.value;
      renderAll();
    });
    els.groupSelect.addEventListener('change', () => {
      state.group = els.groupSelect.value;
      renderAll();
    });
    els.chartSelect.addEventListener('change', () => {
      state.chart = els.chartSelect.value;
      renderAll();
    });
    els.stackSelect.addEventListener('change', () => {
      state.stack = els.stackSelect.value;
      renderAll();
    });

    els.refreshButton.addEventListener('click', () => {
      if (!state.key) return showUnlock();
      loadAll().catch(error => {
        showUnlock(error.message || String(error));
        setSync('error', '读取失败');
      });
    });

    els.unlockForm.addEventListener('submit', async event => {
      event.preventDefault();
      const password = els.passwordInput.value;
      if (!password || password.length < 8) {
        els.unlockError.textContent = '请输入至少 8 个字符的 Dashboard 密码';
        return;
      }
      els.unlockButton.disabled = true;
      els.unlockButton.textContent = '正在解锁…';
      els.unlockError.textContent = '';
      try {
        state.accessEnvelope = state.accessEnvelope || await fetchAccessEnvelope();
        state.key = await unwrapAccessEnvelope(state.accessEnvelope, password);
        await loadAll();
        els.passwordInput.value = '';
      } catch (error) {
        showUnlock(error.message || String(error));
        if (error.code === 'ACCESS_NOT_FOUND') {
          els.accessHint.innerHTML = '升级 CLI 后在任意已配置设备运行 <code>usagemesh password</code> 一次，然后刷新本页。';
        }
      } finally {
        els.unlockButton.disabled = false;
        els.unlockButton.textContent = '进入 Dashboard';
      }
    });

    els.exportCsv.addEventListener('click', () => {
      const blob = new Blob([A.toCsv(filtered())], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `usagemesh-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    els.themeToggle.addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      const next = dark ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('tm-theme', next);
      renderAll();
    });

    window.addEventListener('resize', () => {
      clearTimeout(window.__tmResize);
      window.__tmResize = setTimeout(renderAll, 120);
      if (window.innerWidth > 820) closeMobileMenu();
    });
  }

  async function boot() {
    state.repo = deriveRepo();
    els.repoBadge.textContent = state.repo || '未指定仓库';
    els.brandLink.href = `${location.pathname}?repo=${encodeURIComponent(state.repo)}`;
    initTheme();
    initSidebar();
    wire();

    if (!state.repo) {
      showUnlock('无法判断数据仓库，请使用 ?repo=OWNER/REPO');
      return;
    }

    const legacy = legacyFragmentKey();
    if (legacy) {
      if (!validateWorkspaceKey(legacy)) {
        showUnlock('旧版 Dashboard key 无效');
        await probeAccess();
        return;
      }
      state.key = legacy;
      try {
        await loadAll();
        return;
      } catch (error) {
        state.key = '';
        showUnlock(error.message || String(error));
      }
    } else {
      showUnlock();
    }

    await probeAccess();
    setTimeout(() => els.passwordInput.focus(), 50);
  }

  boot().catch(error => {
    showUnlock(error.message || String(error));
    setSync('error', '初始化失败');
  });
})();
