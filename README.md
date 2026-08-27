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
| **Fork-owned** | Your fork is the workspace. Your dashboard lives at `https://<you>.github.io/UsageMesh/`. |
| **Diagnostic analytics** | Overview answers “how much”; Analysis explains concentration, efficiency and high-consumption combinations. |

## Quick start

### 1. Fork this repository

Fork `Atingaii/UsageMesh` to your own account and keep the fork **public**. The browser dashboard must be able to read ciphertext without a server-side GitHub session; device details are encrypted before upload.

GitHub does not automatically execute workflows in a new public fork. Open the fork's **Actions** tab once, enable workflows, then run **Deploy Dashboard**. The workflow attempts to enable Pages automatically. If GitHub blocks that API action, use **Settings → Pages → Source → GitHub Actions** and rerun it.

### 2. Install the CLI

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

`setup` discovers your `UsageMesh` fork, asks for a dashboard password, performs the first full scan, and installs the native periodic scheduler unless you pass `--no-schedule`.

### 3. Open your dashboard

```bash
usagemesh dashboard
```

The URL is derived from your fork, for example `https://alice.github.io/UsageMesh/`.

## GitHub authentication

UsageMesh needs write access to **your fork only** so each device can update its encrypted ledger branch.

If GitHub CLI is already authenticated, UsageMesh can use that credential:

```bash
gh auth login
gh auth status
usagemesh setup
```

For least privilege, create a **fine-grained personal access token** after you fork:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Select your account as **Resource owner**.
3. Choose **Only select repositories** → your `UsageMesh` fork.
4. Grant **Contents: Read and write**. If available and you want API-assisted Pages initialization, also grant **Pages: Read and write**.
5. Set a reasonable expiration date and generate the token.
6. Run `usagemesh setup` and paste the `github_pat_...` value at the hidden prompt.

Never paste a PAT into a shell command, README, issue, screenshot or pair code. UsageMesh never uploads your GitHub credential. A pasted credential is kept only in this machine's local configuration so scheduled sync can continue; on Unix the file is mode `0600`. Use a short-lived, repository-scoped token and protect the operating-system account itself.

## Add another device

On an existing device:

```bash
usagemesh invite
```

Copy the generated `usagemesh join '...'` command to the new device, install UsageMesh there, and run it. The pair code contains the workspace encryption key and repository identity, **not** your GitHub token; treat the pair code as a secret anyway.

Then verify:

```bash
usagemesh sync --full
usagemesh status
```

## Dashboard information architecture

**Overview** is intentionally concise: total usage, equivalent cost, trend, current devices and recent activity.

**Analysis** is a diagnostic workbench rather than a duplicate overview. It focuses on cache efficiency, average request size/cost, top-contributor concentration, configurable contribution dimensions, a device × model matrix, and high-consumption device/model/client/tier combinations.

## What is uploaded

Each device publishes an encrypted snapshot to an isolated `um-ledger-*` branch. A small `um-index` branch lists device snapshot branch names. Dashboard password material is a password-wrapped workspace key on `um-dashboard`.

UsageMesh is not designed to upload raw prompts, responses, reasoning text, source code, project content, full session transcripts, API keys or GitHub credentials.

## Security model

The dashboard password itself is never stored in the browser. After unlock, the decrypted workspace key is kept only in `sessionStorage`: normal refreshes stay unlocked, while closing the browser session requires the password again. See [SECURITY.md](SECURITY.md) for the threat model and limitations.

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

## License and attribution

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
