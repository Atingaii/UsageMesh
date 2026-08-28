<p align="center">
  <img src="docs/assets/usagemesh-hero.svg" alt="UsageMesh — AI coding usage, across every device" width="100%" />
</p>

<p align="center">
  <strong>Local-first, serverless usage analytics for AI coding tools.</strong><br/>
  Collect on each device, sync encrypted ledgers through your own GitHub fork, and host the dashboard on your own GitHub Pages site.
</p>

<p align="center"><a href="README.zh-CN.md">简体中文</a> · <a href="SECURITY.md">Security</a> · <a href="docs/PRICING.md">Cost semantics</a></p>

## Why UsageMesh

UsageMesh is for people who use AI coding tools on more than one machine and want one trustworthy view of usage without running a server.

| | |
|---|---|
| **Cross-device** | macOS, Windows and Linux devices contribute to one workspace. |
| **Local-first** | Usage is scanned locally; raw prompts, responses, source code and full transcripts are not uploaded by design. |
| **Encrypted by default** | Device ledgers are encrypted with AES-256-GCM before they are written to GitHub. |
| **Serverless** | GitHub branches are the data transport and GitHub Pages hosts the dashboard. |
| **Fork-owned** | Your fork is the workspace. Your dashboard lives at `https://<you>.github.io/<repo>/`. |
| **Diagnostic analytics** | Overview answers “how much”; Analysis explains concentration, efficiency and high-consumption combinations. |

## Quick start

### 1. Fork this repository and enable Pages

Fork `Atingaii/UsageMesh` to your own account and keep the fork **public**. The browser dashboard must be able to read ciphertext without a server-side GitHub session; device details are encrypted before upload.

GitHub does not automatically execute workflows in a new public fork. Open your fork's **Actions** tab once, enable workflows, then run **Deploy Dashboard**. If Pages is not enabled yet, choose **Settings → Pages → Source → GitHub Actions** and rerun **Deploy Dashboard**.

### 2. Prepare GitHub authentication — GitHub CLI is not required

UsageMesh needs write access to **your fork only** so each device can update its encrypted ledger branches. The recommended least-privilege path is a fine-grained personal access token:

1. Open GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, or go directly to [Generate new token](https://github.com/settings/personal-access-tokens/new).
2. Select your own account as **Resource owner**.
3. Choose **Only select repositories** and select your `UsageMesh` fork only.
4. Grant **Contents: Read and write**. Device synchronization does not require additional repository permissions.
5. Set a reasonable expiration date and generate the token. Copy the `github_pat_...` value while GitHub shows it.

**Do not put the PAT in the install command.** Later, when you run `usagemesh setup`, UsageMesh will show a hidden prompt if no other GitHub credential is available:

```text
GitHub token (hidden; stored locally for scheduled sync):
```

Paste the `github_pat_...` value and press Enter. No characters are echoed while pasting; that is expected.

If GitHub CLI is already installed and authenticated, you may use it instead:

```bash
gh auth login
gh auth status
```

UsageMesh will automatically try `gh auth token`. **GitHub CLI is optional and is not a UsageMesh dependency.**

### 3. Install and initialize UsageMesh

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Atingaii/UsageMesh/main/install.sh | sh
usagemesh setup
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Atingaii/UsageMesh/main/install.ps1 | iex
usagemesh setup
```

`setup` uses the GitHub credential to identify the current account, finds that account's `UsageMesh` fork, asks for a dashboard password, performs the first **full** scan, and installs an OS-supervised **resident sync agent** unless you pass `--no-schedule`. The resident agent scans incrementally every 30 seconds after that first baseline; a version, ledger-schema or pricing-policy migration may deliberately rebuild the full local history once. New dashboard passwords must be at least 12 characters/bytes; existing workspaces keep their existing password unchanged across upgrades.

A full sync also synchronizes the fork's `main` branch with the current `Atingaii/UsageMesh` upstream before publishing usage data. This is the automatic repair path for users who forked an older version: they do not need to click GitHub's **Sync fork** button manually.

Credential lookup order is: explicit `--token` → `USAGEMESH_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` → authenticated `gh auth token` → **hidden PAT prompt**. Regular users should avoid `--token` so credentials are not left in shell history.

### 4. Open your dashboard

```bash
usagemesh dashboard
```

The URL is derived from the actual fork. For example, if the GitHub account is `alice` and the fork is still named `UsageMesh`, the URL is `https://alice.github.io/UsageMesh/`. If the fork was renamed, initialize with `usagemesh setup --repo OWNER/RENAMED_REPO`; the dashboard URL is then generated from that real repository name.

## Zero-touch updates

Starting with **UsageMesh v2.0.2**, normal synchronization is also the update mechanism. Each resident-agent synchronization pass can discover the latest **stable** GitHub Release. If a newer version exists, UsageMesh downloads the platform-specific release archive and its SHA-256 checksum, verifies it, synchronizes the workspace fork with the current upstream, replaces the CLI in place, and resumes synchronization automatically. The next pass sees the new app version and performs one full migration scan before returning to incremental operation.

Upgrades do **not** recreate the workspace or reset credentials. The repository, workspace key, dashboard password, device identity and GitHub credential remain unchanged. Starting with **v2.5.0**, normal installations use a single OS-supervised resident process with a **30-second incremental loop** instead of launching a new one-shot sync process every 30 seconds; devices intentionally configured with `--no-schedule` remain manual.

Stable releases are only promoted to `latest` after the supported platform builds and installer smoke tests pass. Failed candidates remain prereleases and are therefore ignored by automatic updates.

Automatic updates can be disabled for controlled environments with `USAGEMESH_AUTO_UPDATE=0`. Re-running the original installer remains a recovery option; on an already configured machine the installer detects the workspace and performs the full refresh automatically, without requiring a second command.

## Resident synchronization and presence

Starting with **v2.5.0**, UsageMesh keeps one lightweight synchronization loop resident under the native OS supervisor: macOS uses `launchd` with `RunAtLoad` + `KeepAlive`; Linux prefers a `systemd --user` service with `Restart=always` and attempts to enable user lingering, with a cron watchdog fallback; Windows starts a hidden resident PowerShell loop through Task Scheduler at sign-in. Each loop waits for the current scan to finish before sleeping 30 seconds, so routine synchronization no longer creates overlapping timer ticks.

The first local scan is full. Normal subsequent scans are incremental and intentionally re-read only a short two-day overlap window so sessions that are still being appended can be reconciled safely. Full rescans are reserved for explicit `sync --full` and migrations such as a new UsageMesh version, ledger schema or pricing policy.

Device presence is separate from usage freshness. A small per-device `um-presence-*` branch receives a heartbeat about once per minute, while the larger encrypted `um-ledger-*` snapshot is replaced only when accounting changes or a migration requires refreshed metadata. The dashboard uses presence heartbeats for **Online / Heartbeat delayed / Offline** status and keeps the “last sync” timestamp tied to the usage ledger.

## Dashboard freshness

Once **Deploy Dashboard** has been enabled in a fork, each deployment builds the dashboard from the current `Atingaii/UsageMesh` upstream source rather than trusting a potentially stale copy of `web-ui` in the fork. The workflow also runs once per day, so an existing user's Pages site keeps receiving current dashboard fixes without requiring a new fork.

The deployed site includes `/build-info.json` with the workspace repository and the exact upstream dashboard commit used for that build. This makes stale-deployment problems diagnosable instead of silently looking like a password or data error.

## Add another device

On an existing device:

```bash
usagemesh invite
```

Copy the generated `usagemesh join '...'` command to the new device. The pair code contains the workspace encryption key and repository identity, **not** your GitHub token; treat it as a secret anyway.

The new device still needs its own GitHub write credential. It can use a fine-grained PAT or an already-authenticated GitHub CLI session. A successful `join` performs the initial full sync, so an immediate `sync --full` is normally unnecessary.

Verify with:

```bash
usagemesh status
```

## Pages troubleshooting

First confirm the fork's latest **Actions → Deploy Dashboard** run is green and **Settings → Pages** uses **GitHub Actions**. Then use the exact URL from:

```bash
usagemesh dashboard
```

If it still does not open:

```bash
curl -I "$(usagemesh dashboard)"
nslookup github.io
```

A `200` means Pages is online; retry with a private window or hard refresh. A `404` usually indicates the wrong repository path/case or a deployment that has not propagated yet. A DNS-resolution error means the current network cannot resolve or reach `github.io`; that is independent of UsageMesh synchronization.

Dashboard assets use relative URLs, so a renamed fork does not depend on a hard-coded `/UsageMesh/` asset prefix.

## Dashboard information architecture

**Overview** is intentionally concise: total usage, equivalent cost, trend, current devices and recent activity.

**Analysis** is a diagnostic workbench rather than a duplicate overview. It includes a near-real-time request feed with exact event time, model, speed/tier, token buckets, duration when the source records it, per-request estimated cost, and **reasoning/thinking effort when the source client explicitly records it**. UsageMesh recognizes common `reasoningEffort`, nested `reasoning.effort`, `thinkingLevel` and thinking/reasoning budget shapes across text-based client logs. It does not infer effort from model names or token counts, so clients that do not expose the field correctly remain `—` instead of receiving a guessed value.

## What is uploaded

Each device publishes an encrypted snapshot to an isolated `um-ledger-*` branch and a tiny liveness heartbeat to a matching `um-presence-*` branch. A small `um-index` branch lists device snapshot branch names. Presence contains only the hashed device identifier, heartbeat time and app version; usage rows and request metadata remain encrypted in the ledger. Dashboard password material is a password-wrapped workspace key on `um-dashboard`.

UsageMesh is not designed to upload raw prompts, responses, reasoning text, source code, project content, full session transcripts, API keys or GitHub credentials. Request-level metadata is inside the encrypted ledger.

## Security model

The dashboard password itself is never stored in the browser. After unlock, the decrypted workspace key is kept only in the current page's memory — **not** in `localStorage`, `sessionStorage`, IndexedDB, cookies or the URL. Refreshing or closing the page requires the same password again.

Existing v1 password manifests remain backward compatible: a workspace created with the earlier 310,000-iteration PBKDF2 setting still unlocks with its original password. Newly created or explicitly changed passwords use PBKDF2-HMAC-SHA256 with **600,000 iterations**, a random salt and AES-256-GCM wrapping. The static dashboard also ships a restrictive Content Security Policy and does not load third-party JavaScript or analytics. See [SECURITY.md](SECURITY.md) for the complete threat model.

A pasted GitHub credential is stored only in the local UsageMesh configuration so scheduled sync can run non-interactively; Unix configuration files are mode `0600`. Use a short-lived, repository-scoped token and protect the operating-system account itself.

No client-side system can promise “absolute security.” UsageMesh instead minimizes privilege, encrypts data before upload, avoids persistent browser decryption keys and URL secrets, restricts the browser network surface, and documents the remaining trust boundaries explicitly.

## Cost semantics

Dashboard cost values are **compatibility-card USD estimates**, not provider invoices or subscription quota meters. GPT-5.6 Sol is pinned to the widely used undiscounted relay card; see [docs/PRICING.md](docs/PRICING.md) for the exact buckets, long-context rule and local-only route evidence precedence.

The Dashboard's custom time range accepts local date and time down to the minute. Schema-v7 devices rebuild the aggregate ledger into minute buckets so totals, trends and request details use the same boundaries; legacy day-only snapshots fall back to date filtering until that device updates.

## Development

```bash
cargo test --workspace
cd web-ui
npm install
npm run typecheck
npm run build
```

## 友情链接

开源技术和开发者交流，欢迎访问 [Linux DO](https://linux.do/)。

## License and attribution

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
