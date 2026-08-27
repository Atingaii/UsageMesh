# Security

UsageMesh is a client-side, GitHub-backed system. Its security goal is to keep usage details confidential even when the synchronization repository is public, while keeping setup practical for a personal multi-device workspace.

## Data stored on GitHub

Device ledgers are encrypted with AES-256-GCM before upload. Each device writes to an isolated `um-ledger-*` branch. GitHub stores ciphertext, a random nonce, limited envelope metadata and device-index branch names; it does not receive the plaintext workspace key.

The dashboard password does not encrypt every ledger directly. UsageMesh generates a random 256-bit workspace key and wraps that key with a password-derived AES-256-GCM key. The password itself is not uploaded.

## Password compatibility and KDF

Dashboard access manifests are versioned and carry their own PBKDF2 iteration count. Existing v1 workspaces created with the earlier 310,000-iteration PBKDF2-HMAC-SHA256 setting remain readable with the **same existing password**. A software update does not replace the workspace key, rewrite the access manifest, or force a password reset.

Newly created or explicitly changed dashboard passwords use PBKDF2-HMAC-SHA256 with 600,000 iterations, a random 128-bit salt and AES-256-GCM key wrapping. New passwords must be at least 12 bytes. The browser accepts the bounded historical iteration range used by valid UsageMesh v1 manifests, so backward compatibility does not weaken the new default.

PBKDF2 raises the cost of password guessing but cannot make a weak password strong. Because a public workspace exposes the encrypted access manifest, an attacker can attempt password guesses offline. Use a unique passphrase rather than a reused or predictable password.

## Browser session

The dashboard never persists the plaintext password. After a successful unlock, the decrypted workspace key is kept only in the current page's JavaScript memory. It is **not** written to `localStorage`, `sessionStorage`, IndexedDB, the URL, cookies, or GitHub.

Refreshing, closing, or recreating the page therefore requires the same dashboard password again. The manual **Lock** action also discards the in-memory key immediately.

The static dashboard ships a restrictive Content Security Policy: scripts must come from the deployed site itself; network connections are limited to the site and `raw.githubusercontent.com`; objects and form submission are disabled; and referrer data is suppressed. UsageMesh does not load third-party analytics or third-party JavaScript at runtime.

These controls materially reduce the attack surface, but a browser or operating system that is already compromised remains outside the protection boundary. A malicious browser extension with sufficient privileges, malware, or code executing inside a compromised trusted origin may still observe decrypted data while the page is unlocked.

## GitHub credentials

A GitHub credential is required for device-side writes. It is not embedded in pair codes, ledger envelopes, dashboard URLs or uploaded snapshots. If a PAT is pasted during setup, the current CLI stores it in the local UsageMesh configuration so scheduled sync can run without interaction. Unix configuration files are created with mode `0600`; other platforms rely on the current user's profile permissions.

Use a fine-grained PAT scoped to the UsageMesh fork with the shortest practical expiration. Revoke and replace it immediately if exposed. Native OS secret-store integration remains a future hardening opportunity; until then, local account compromise is inside the threat boundary.

## Request-level metadata

UsageMesh may upload request metadata such as timestamp, model, token buckets, duration, service tier and an explicitly recorded reasoning/thinking effort label. This metadata is inside the AES-GCM encrypted ledger. UsageMesh does not intentionally upload prompts, model responses, reasoning text, source code or full transcripts.

Reasoning effort is recorded only when a source client log exposes an explicit field such as `reasoningEffort`, `reasoning.effort`, `thinkingLevel` or a thinking/reasoning budget. UsageMesh does not infer an effort label from model name, token count or output shape. A missing value is therefore shown as unknown rather than guessed.

## Automatic updates

Starting with v2.0.2, normal synchronization checks the latest stable `Atingaii/UsageMesh` GitHub Release. An update is installed only after the platform archive's SHA-256 matches the checksum published with that release. Release candidates are prereleases and are not promoted to `latest` until supported-platform builds and installer smoke tests succeed.

This checksum protects against accidental corruption and mismatched downloads, but it does **not** create an independent trust root: the archive and checksum are distributed through the same upstream GitHub repository. Automatic updates therefore trust GitHub HTTPS delivery, the upstream repository and release workflow, and the maintainer account. Environments requiring pinned versions or an external software-supply-chain policy can set `USAGEMESH_AUTO_UPDATE=0` and manage the binary separately.

An automatic CLI upgrade replaces the executable in place. It does not rewrite the workspace key, dashboard password, device identity or GitHub credential.

## Pair codes

Pair codes contain repository identity, synchronization configuration and the workspace encryption key. They do **not** contain the GitHub PAT. Possession of a pair code may be sufficient to decrypt ledger data if ciphertext is accessible, so pair codes must be treated as secrets.

## Threat boundary

UsageMesh is designed to protect ciphertext at rest in a public GitHub workspace and to minimize browser-side secret persistence. It cannot protect against root/admin malware on a device, a compromised browser while the dashboard is unlocked, a leaked pair code/workspace key, an offline attack against a weak password, or compromise of the trusted upstream release channel. It also cannot guarantee the accuracy of upstream client logs or pricing metadata.

## Reporting

Do not publish live PATs, pair codes, workspace keys or decrypted ledgers in public issues. For a suspected credential leak, revoke the credential first, then file a sanitized report.