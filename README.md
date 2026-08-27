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

`setup` uses the GitHub credential to identify the current account, finds that account's `UsageMesh` fork, asks for a dashboard password, performs the first full scan, and installs the native periodic scheduler unless you pass `--no-schedule`.

Credential lookup order is: explicit `--token` → `USAGEMESH_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` → authenticated `gh auth token` → **hidden PAT prompt**. Regular users should avoid `--token` so credentials are not left in shell history.

### 4. Open your dashboard

```bash
usagemesh dashboard
```

The URL is derived from the actual fork. For example, if the GitHub account is `alice` and the fork is still named `UsageMesh`, the URL is `https://alice.github.io/UsageMesh/`. If the fork was renamed, initialize with `usagemesh setup --repo OWNER/RENAMED_REPO`; the dashboard URL is then generated from that real repository name.

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

**Analysis** is a diagnostic workbench rather than a duplicate overview. It focuses on cache efficiency, average request size/cost, top-contributor concentration, configurable contribution dimensions, a device × model matrix, and high-consumption device/model/client/tier combinations.

## What is uploaded

Each device publishes an encrypted snapshot to an isolated `um-ledger-*` branch. A small `um-index` branch lists device snapshot branch names. Dashboard password material is a password-wrapped workspace key on `um-dashboard`.

UsageMesh is not designed to upload raw prompts, responses, reasoning text, source code, project content, full session transcripts, API keys or GitHub credentials.

## Security model

The dashboard password itself is never stored in the browser. After unlock, the decrypted workspace key is kept only in `sessionStorage`: normal refreshes stay unlocked, while closing the browser session requires the password again. See [SECURITY.md](SECURITY.md) for the threat model and limitations.

A pasted GitHub credential is stored only in the local UsageMesh configuration so scheduled sync can run non-interactively; Unix configuration files are mode `0600`. Use a short-lived, repository-scoped token and protect the operating-system account itself.

No client-side system can promise “absolute security.” UsageMesh instead minimizes privilege, encrypts data before upload, avoids secrets in URLs, and documents the remaining trust boundaries explicitly.

## Cost semantics

Dashboard cost values are **usage estimates / subscription-equivalent estimates**, not provider invoices and not a promise about a subscription's internal quota accounting. Model-specific rules are kept out of onboarding docs; see [docs/PRICING.md](docs/PRICING.md).

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
