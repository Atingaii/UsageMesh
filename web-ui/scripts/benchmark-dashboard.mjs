// Synthetic CPU benchmark. This is not a browser/Web Vitals measurement.
// Run from web-ui: node scripts/benchmark-dashboard.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import * as current from "../src/lib/analytics.ts";
import { sortTableRows } from "../src/lib/tableRows.ts";

const base =
  process.env.USAGEMESH_BENCH_BASE ||
  "4cd5be5bc17fca138ba185cd007191093e6ddd93";
const source = execFileSync(
  "git",
  ["show", `${base}:web-ui/src/lib/analytics.ts`],
  { encoding: "utf8" },
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const before = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const count = 50_000;
const now = new Date();
const rows = Array.from({ length: count }, (_, index) => ({
  id: String(index),
  timestampMs: now.getTime() - (index % 90) * 86_400_000,
  date: "2026-09-01",
  device: `设备 ${index % 12}`,
  tool: "Codex",
  model: `model-${(index * 7919) % 1000}`,
  vendor: "OpenAI",
  routeProvider: "official",
  routeType: "official",
  rawProvider: "openai",
  tier: "Standard",
}));
function measure(run, repeats = 5) {
  run(); // warm-up, excluded
  const times = [];
  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}
const results = [];
function compare(label, oldRun, newRun, repeats) {
  assert.deepEqual(
    newRun(),
    oldRun(),
    `${label}: output must remain identical`,
  );
  const oldMs = measure(oldRun, repeats),
    newMs = measure(newRun, repeats);
  results.push({
    scenario: label,
    beforeMs: +oldMs.toFixed(2),
    afterMs: +newMs.toFixed(2),
    speedup: +(oldMs / newMs).toFixed(2),
  });
}
for (const timeRange of ["all", "30d", "custom"]) {
  const filters = {
    ...current.DEFAULT_FILTERS,
    timeRange,
    customStartDate: new Date(now.getTime() - 30 * 86_400_000)
      .toISOString()
      .slice(0, 16),
    customEndDate: now.toISOString().slice(0, 16),
  };
  compare(
    `filter ${timeRange}, ${count} rows`,
    () =>
      rows
        .filter((row) => before.matchesFilters(row, filters))
        .map((row) => row.id),
    () =>
      rows.filter(current.createFilterPredicate(filters)).map((row) => row.id),
  );
}
compare(
  `model sort, ${count} rows`,
  () =>
    [...rows]
      .sort(
        (a, b) =>
          -a.model.localeCompare(b.model, "zh-CN", { numeric: true }) ||
          a.id.localeCompare(b.id),
      )
      .map((row) => row.id),
  () => sortTableRows(rows, (row) => row.model, false).map((row) => row.id),
  3,
);
const timestamps = rows.slice(0, 10_000).map((row) => row.timestampMs);
compare(
  "timestamp formatting, 10000 values",
  () => timestamps.map(before.dateTime),
  () => timestamps.map(current.dateTime),
  3,
);
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      baseline: base,
      warmupRuns: 1,
      statistic: "median of 5 runs (sort/format: 3)",
      rows: count,
      results,
    },
    null,
    2,
  ),
);
