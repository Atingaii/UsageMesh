(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokenAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Keep this list aligned with the Rust ledger's additive Metrics shape.
  // Session cardinality and duration/performance are deliberately excluded
  // because they cannot be safely summed across every grouping dimension.
  const METRIC_KEYS = ['input','output','cacheRead','cacheWrite','reasoning','messages','costUsd'];

  function totalTokens(row) {
    return Number(row.input || 0)
      + Number(row.output || 0)
      + Number(row.cacheRead || 0)
      + Number(row.cacheWrite || 0)
      + Number(row.reasoning || 0);
  }

  function metricValue(row, metric) {
    return metric === 'totalTokens' ? totalTokens(row) : Number(row[metric] || 0);
  }

  function sumRows(rows) {
    const out = Object.fromEntries(METRIC_KEYS.map(key => [key, 0]));
    for (const row of rows || []) {
      for (const key of METRIC_KEYS) out[key] += Number(row[key] || 0);
    }
    out.totalTokens = totalTokens(out);
    out.costLowerBound = (rows || []).some(row => Boolean(row.costLowerBound));
    return out;
  }

  function rowDimension(row, dimension) {
    if (dimension === 'device') return String(row.deviceName || row.device || '(unknown)');
    const value = row[dimension];
    return value === undefined || value === null || value === '' ? '(未标记)' : String(value);
  }

  function groupRows(rows, dimension, metric) {
    const map = new Map();
    for (const row of rows || []) {
      const key = rowDimension(row, dimension);
      map.set(key, (map.get(key) || 0) + metricValue(row, metric));
    }
    return [...map.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  }

  function groupMatrix(rows, primary, secondary, metric) {
    const xSet = new Set(), stackSet = new Set(), map = new Map();
    for (const row of rows || []) {
      const x = rowDimension(row, primary), stack = rowDimension(row, secondary);
      xSet.add(x); stackSet.add(stack);
      const key = `${x}\u0000${stack}`;
      map.set(key, (map.get(key) || 0) + metricValue(row, metric));
    }
    const sortDimension = (dimension, values) => dimension === 'date'
      ? values.sort()
      : values.sort((a,b) => a.localeCompare(b));
    const xValues = sortDimension(primary, [...xSet]);
    const stacks = [...stackSet].sort((a,b) => a.localeCompare(b));
    return { xValues, stacks, value: (x, stack) => map.get(`${x}\u0000${stack}`) || 0 };
  }

  function filterRows(rows, filters) {
    const {
      start, end, device='*', client='*', model='*', provider='*',
      upstreamVendor='*', routeProvider='*', routeType='*', tier='*'
    } = filters || {};
    return (rows || []).filter(row => {
      if (start && row.date < start) return false;
      if (end && row.date > end) return false;
      if (device !== '*' && row.device !== device) return false;
      if (client !== '*' && row.client !== client) return false;
      if (model !== '*' && row.model !== model) return false;
      if (provider !== '*' && row.provider !== provider) return false;
      if (upstreamVendor !== '*' && row.upstreamVendor !== upstreamVendor) return false;
      if (routeProvider !== '*' && row.routeProvider !== routeProvider) return false;
      if (routeType !== '*' && row.routeType !== routeType) return false;
      if (tier !== '*' && String(row.tier || '') !== tier) return false;
      return true;
    });
  }

  function squarify(items, x, y, width, height) {
    const positive = (items || [])
      .filter(item => Number(item.value) > 0)
      .sort((a,b) => b.value - a.value);
    const total = positive.reduce((sum, item) => sum + Number(item.value), 0);
    if (!total || width <= 0 || height <= 0) return [];
    const horizontal = width >= height;
    let cursor = horizontal ? x : y;
    return positive.map(item => {
      const ratio = Number(item.value) / total;
      const rect = horizontal
        ? { x: cursor, y, width: width * ratio, height }
        : { x, y: cursor, width, height: height * ratio };
      cursor += horizontal ? rect.width : rect.height;
      return { ...item, ...rect };
    });
  }

  function toCsv(rows) {
    const columns = [
      'date','deviceName','platform','client','upstreamVendor','routeProvider',
      'routeType','provider','model','tier','input','cacheRead','cacheWrite',
      'output','reasoning','messages','costUsd','costLowerBound'
    ];
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [
      columns.join(','),
      ...(rows || []).map(row => columns.map(column => quote(row[column])).join(','))
    ].join('\n');
  }

  return {
    METRIC_KEYS, totalTokens, metricValue, sumRows, rowDimension,
    groupRows, groupMatrix, filterRows, squarify, toCsv
  };
});
