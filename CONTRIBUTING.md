# Contributing

Contributions are welcome. Keep changes small, auditable and privacy-preserving.

Before opening a pull request:

```bash
cargo test --workspace
cd web-ui
npm install
npm run typecheck
npm run build
```

Do not commit real PATs, pair codes, workspace keys, decrypted ledgers, prompts, responses or private usage exports. Pricing changes should include a source note and regression test. Dashboard changes should preserve the separation between Overview (status) and Analysis (diagnostics).
