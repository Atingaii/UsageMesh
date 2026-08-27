from pathlib import Path
import json


def must_replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing replacement anchor in {path}: {old[:80]!r}")
    updated = text.replace(old, new, count)
    p.write_text(updated)


# Request-level reasoning effort from explicit client log evidence.
must_replace(
    "rust-cli/src/collector.rs",
    "            reasoning_effort: None,\n",
    "            reasoning_effort: evidence::reasoning_effort_for_message(\n"
    "                &route_evidence,\n"
    "                &client,\n"
    "                &message.session_id,\n"
    "                message.timestamp,\n"
    "            ),\n",
)

# Stronger password wrapping for newly created/changed passwords while keeping
# the envelope format versioned and iteration-driven so old 310k manifests keep working.
must_replace(
    "rust-cli/src/crypto.rs",
    "pub const ACCESS_PBKDF2_ITERATIONS: u32 = 310_000;",
    "pub const ACCESS_PBKDF2_ITERATIONS: u32 = 600_000;",
)
must_replace(
    "rust-cli/src/crypto.rs",
    "    if password.as_bytes().len() < 8 {\n        bail!(\"dashboard password must be at least 8 bytes long\")\n    }",
    "    if password.as_bytes().len() < 12 {\n        bail!(\"dashboard password must be at least 12 bytes long for new access manifests\")\n    }",
)
must_replace(
    "rust-cli/src/crypto.rs",
    "    {\n        bail!(\"unsupported dashboard access envelope\");\n    }\n    let salt = URL_SAFE_NO_PAD.decode(&envelope.salt)?;",
    "    {\n        bail!(\"unsupported dashboard access envelope\");\n    }\n    // Keep older v1 PBKDF2 envelopes compatible while rejecting maliciously\n    // tiny or pathological iteration counts. Existing 310k manifests remain valid.\n    if !(100_000..=5_000_000).contains(&envelope.iterations) {\n        bail!(\"dashboard access envelope has an unsafe PBKDF2 iteration count\");\n    }\n    let salt = URL_SAFE_NO_PAD.decode(&envelope.salt)?;",
)

# New/changed passwords get a mature minimum, but browser unlock compatibility
# is governed by the existing encrypted access envelope, not this CLI validator.
must_replace(
    "rust-cli/src/main.rs",
    "    if password.as_bytes().len() < 8 {\n        bail!(\"dashboard password must be at least 8 bytes long\")\n    }",
    "    if password.as_bytes().len() < 12 {\n        bail!(\"dashboard password must be at least 12 bytes long\")\n    }",
)
must_replace(
    "rust-cli/src/main.rs",
    "Dashboard password (hidden, min 8 chars): ",
    "Dashboard password (hidden, min 12 chars): ",
)
must_replace(
    "rust-cli/src/main.rs",
    "    fn short_dashboard_password_is_rejected() {\n        assert!(validate_dashboard_password(\"1234567\").is_err());\n        assert!(validate_dashboard_password(\"12345678\").is_ok());\n    }",
    "    fn short_dashboard_password_is_rejected_for_new_manifests() {\n        assert!(validate_dashboard_password(\"12345678\").is_err());\n        assert!(validate_dashboard_password(\"correct-horse-battery\").is_ok());\n    }",
)

# Fix one Rust compatibility detail in the newly-added evidence scanner.
must_replace(
    "rust-cli/src/evidence.rs",
    ".to_ascii_lowercase().replace(['_', ' '], \"-\");",
    ".to_ascii_lowercase().replace('_', \"-\").replace(' ', \"-\");",
)
must_replace(
    "rust-cli/src/evidence.rs",
    "use chrono::{DateTime, NaiveDateTime, Utc};",
    "use chrono::{DateTime, NaiveDateTime};",
)

# Browser secret hardening: the decrypted workspace key lives only in React
# memory. A reload/close requires the same existing password again.
app_path = Path("web-ui/src/app.tsx")
app = app_path.read_text()
start = app.index("const REMEMBERED_WORKSPACE_KEY_PREFIX")
end = app.index("interface AccessEnvelope", start)
app = app[:start] + app[end:]
app = app.replace("  const [isRestoringSession, setIsRestoringSession] = useState(true);\n", "", 1)
restore_start = app.index("  useEffect(() => {\n    let cancelled = false;\n    const repo = repoFromLocation();\n    const remembered = readRememberedWorkspaceKey(repo);")
restore_end = app.index("  }, []);\n", restore_start) + len("  }, []);\n")
app = app[:restore_start] + app[restore_end:]
app = app.replace("      rememberWorkspaceKey(next.repo, key);\n", "", 1)
app = app.replace("    forgetRememberedWorkspaceKey(repoFromLocation());\n", "", 1)
restore_line = "  if (!dataset && isRestoringSession) return <div className={isDarkMode ? 'dark' : ''}><div className=\"min-h-screen bg-[var(--bg-main)] text-[var(--text-primary)] grid place-items-center\"><div className=\"flex items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-4 py-3 text-xs text-[var(--text-muted)] shadow-sm\"><RefreshCw className=\"h-4 w-4 animate-spin text-[var(--accent-blue)]\" /><span>正在恢复登录...</span></div></div></div>;\n"
if restore_line not in app:
    raise SystemExit("restore screen anchor missing")
app = app.replace(restore_line, "", 1)
app = app.replace(
    "    try { await onUnlock(password); } finally { setLoading(false); }",
    "    try { await onUnlock(password); setPassword(''); } finally { setLoading(false); }",
    1,
)
app = app.replace(
    '<input type="password" value={password}',
    '<input type="password" autoComplete="current-password" spellCheck={false} autoCapitalize="none" value={password}',
    1,
)
app = app.replace(
    "输入 Dashboard 密码。密码只在当前页面参与 PBKDF2 + AES-GCM 解密，不会发送给 GitHub，也不会出现在网址中。",
    "输入原来的 Dashboard 密码即可。密码只在当前页面参与 PBKDF2 + AES-GCM 解密；解密后的工作区密钥只保留在页面内存，刷新或关闭页面后需要重新输入密码。",
    1,
)
anchor = "  ) throw new Error('Dashboard 访问配置不受支持');\n\n  const material = await crypto.subtle.importKey"
replacement = "  ) throw new Error('Dashboard 访问配置不受支持');\n  // v1 envelopes are iteration-driven: existing 310k manifests remain valid,\n  // while new/changed passwords use the stronger device-side default.\n  if (!Number.isInteger(envelope.iterations) || envelope.iterations < 100_000 || envelope.iterations > 5_000_000) {\n    throw new Error('Dashboard 访问配置的 KDF 参数无效');\n  }\n\n  const material = await crypto.subtle.importKey"
if anchor not in app:
    raise SystemExit("KDF browser anchor missing")
app = app.replace(anchor, replacement, 1)
app_path.write_text(app)

# GitHub Pages cannot set arbitrary response headers, so enforce the strongest
# useful client-side policy available from the static document itself.
index = Path("web-ui/index.html")
html = index.read_text()
meta_anchor = '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
meta = meta_anchor + (
    '    <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; base-uri \'none\'; object-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; connect-src \'self\' https://raw.githubusercontent.com; form-action \'none\'; upgrade-insecure-requests" />\n'
    '    <meta name="referrer" content="no-referrer" />\n'
)
if "Content-Security-Policy" not in html:
    if meta_anchor not in html:
        raise SystemExit("index meta anchor missing")
    html = html.replace(meta_anchor, meta, 1)
index.write_text(html)

# Version bump.
must_replace("rust-cli/Cargo.toml", 'version = "2.1.0"', 'version = "2.2.0"')
package = Path("web-ui/package.json")
data = json.loads(package.read_text())
data["version"] = "2.2.0"
package.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

print("v2.2 source migration applied")