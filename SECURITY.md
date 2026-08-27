# Security

UsageMesh is a client-side, GitHub-backed system. Its goal is to keep usage details confidential even when the synchronization repository is public.

## Data stored on GitHub

Device ledgers are encrypted with AES-256-GCM before upload. Each device writes to an isolated `um-ledger-*` branch. GitHub stores ciphertext, nonce, limited envelope metadata and the device-index branch names; it does not need the workspace key.

The dashboard password wraps the random 256-bit workspace key using PBKDF2-HMAC-SHA256 and AES-256-GCM. The password itself is not uploaded.

## Browser session

The dashboard never persists the plaintext password. After unlock, the decrypted workspace key is stored only in `sessionStorage`. Reloading the same browser session stays unlocked; closing the browser session removes that remembered key. The manual Lock action removes it immediately.

This reduces long-lived browser secret storage but does not make a compromised browser origin safe. Malicious code executing in the UsageMesh page origin could access decrypted data while the page is unlocked.

## GitHub credentials

A GitHub credential is required for device-side writes. It is not embedded in pair codes, ledger envelopes, dashboard URLs or uploaded snapshots. If a PAT is pasted during setup, the current CLI stores it in the local UsageMesh configuration so scheduled sync can run without interaction. Unix configuration files are created with mode `0600`; other platforms rely on the current user's profile permissions.

Use a fine-grained PAT scoped to the UsageMesh fork with the shortest practical expiration. Revoke and replace it immediately if exposed. Native OS secret-store integration is a future hardening target; until then, local account compromise is inside the threat boundary.

## Pair codes

Pair codes contain repository identity, sync interval and workspace encryption key. They do **not** contain the GitHub PAT. Possession of a pair code may be sufficient to decrypt ledger data if ciphertext is accessible, so pair codes must be treated as secrets.

## Not protected against

UsageMesh cannot protect data from malware/root access on a device, a compromised browser origin while unlocked, a leaked pair code/workspace key, or a weak/reused dashboard password. It also cannot guarantee the correctness of upstream tool logs or provider pricing metadata.

## Reporting

Do not publish live PATs, pair codes, workspace keys or decrypted ledgers in public issues. For a suspected credential leak, revoke the credential first, then file a sanitized report.
