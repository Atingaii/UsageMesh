# Frontend performance checks

This check targets CPU work in the existing dashboard. It does **not** measure real-user browser responsiveness, rendering, Web Vitals, network latency, GitHub bandwidth, or AES throughput.

## Reproduce

With the existing `web-ui` dependencies installed and Node 24 or another Node version supporting native TypeScript stripping:

```sh
cd web-ui
node scripts/benchmark-dashboard.mjs
npm test -- --run tests/analytics.test.ts tests/tableRows.test.ts tests/table.test.tsx tests/data.test.ts tests/dashboard.test.tsx tests/insights.test.ts
```

The script reads the previous analytics implementation directly from Git commit `4cd5be5bc17fca138ba185cd007191093e6ddd93`, generates 50,000 synthetic rows, and asserts that old and new results are identical before timing. Override `USAGEMESH_BENCH_BASE` to compare another retained revision. It uses one untimed warm-up and reports the median of five runs; sorting and formatting use three measured runs. Formatting uses 10,000 timestamps. The script creates no output files or temporary bundles.

## Recorded sample

Local Node `v24.19.0`, 2026-09-10; milliseconds, synthetic workload:

| Operation | Before | After | Ratio |
| --- | ---: | ---: | ---: |
| Filter all time, 50,000 rows | 18.13 | 1.14 | 15.84× |
| Filter 30 days, 50,000 rows | 28.41 | 9.60 | 2.96× |
| Filter custom minutes, 50,000 rows | 37.92 | 1.02 | 37.04× |
| Natural model-name sort, 50,000 rows | 2753.17 | 115.62 | 23.81× |
| Format 10,000 timestamps | 306.13 | 8.65 | 35.39× |

These timings vary by CPU, runtime, dataset, and system load. They show reduced work in specific functions; they are not an overall page speedup claim.

## Changes and correctness boundaries

- Compile time boundaries and selected dimensions once per batch. All-time filtering skips date parsing. Local dates, date-only legacy rows, future-date exclusion, and inclusive custom ending minutes keep their previous semantics.
- Build filter options without repeatedly concatenating both ledgers. Request filtering runs only on the analysis page. Non-data pages skip filter-option construction and filtered ledger scans.
- Reuse number/date formatters and collation rules. Table sort keys are read once per row. Search filters the existing order and reuses searchable column text while typing; pagination and CSV still include all matching rows.
- Reuse usage arrays when a refreshed encrypted payload is unchanged. A hook-owned memory cache avoids repeated AES decryption, JSON parsing, and normalization. Every refresh still checks the device index, encrypted payload, and independent heartbeat; this does not reduce ledger download bytes.
- Cache hits require a validated envelope with matching nonce and ciphertext in the same repository/key session. Changed or damaged ciphertext is decrypted/failed normally. Removed devices are evicted. Lock, unmount, and a new unlock discard the cache, which is never written to browser storage.
- Memoized overview, analytics, and table components retain their props when unchanged accounting data is refreshed, so status changes do not rebuild their large child trees. Calendar-day changes invalidate date-dependent filtering and period comparisons.

## Browser render sample

A Codex in-app browser check used the development QA harness with 50,000 synthetic records (`qa/subscriptions.html?shell&profile&size=50000`). React Profiler reported 18.6 ms for the workspace/current-subscription mount and 0.9 ms for switching to the closed history list. These are React render durations from one local development run, not page load time, interaction latency, Web Vitals, production guarantees, or a browser before/after comparison. The harness prints `[QA render]` entries only when `profile` is present.
