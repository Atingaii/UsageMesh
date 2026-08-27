from pathlib import Path

path = Path('scripts/apply-v220.py')
source = path.read_text()
# crypto.rs has a semicolon after bail!, while main.rs intentionally does not.
# Patch only the first occurrence in the migration source (the crypto anchor).
source = source.replace(
    '        bail!(\\"dashboard password must be at least 8 bytes long\\")\\n    }',
    '        bail!(\\"dashboard password must be at least 8 bytes long\\");\\n    }',
    1,
)
namespace = {'__name__': '__main__', '__file__': str(path)}
exec(compile(source, str(path), 'exec'), namespace)

# Use realistic millisecond timestamps in the effort selector test. Tiny fixture
# numbers are interpreted as Unix seconds by the production normalizer.
evidence = Path('rust-cli/src/evidence.rs')
text = evidence.read_text()
text = text.replace(
    'EffortPoint { timestamp_ms: Some(1_000_000), effort: "low".to_string() },\n'
    '                EffortPoint { timestamp_ms: Some(1_010_000), effort: "high".to_string() },',
    'EffortPoint { timestamp_ms: Some(1_000_000_000_000), effort: "low".to_string() },\n'
    '                EffortPoint { timestamp_ms: Some(1_000_000_010_000), effort: "high".to_string() },',
    1,
)
text = text.replace(
    'reasoning_effort_for_message(&bundle, "codebuddy", "s-1", 1_011_000)',
    'reasoning_effort_for_message(&bundle, "codebuddy", "s-1", 1_000_000_011_000)',
    1,
)
evidence.write_text(text)

# Permanent regression test: an access manifest created by the previous 310k
# PBKDF2 release must still unlock with exactly the same password after v2.2.
crypto = Path('rust-cli/src/crypto.rs')
text = crypto.read_text()
anchor = '''    #[test]\n    fn password_wrap_round_trip() {\n        let key = generate_key();\n        let wrapped = wrap_dashboard_key("Owner/Repo", &key, "correct horse battery").unwrap();\n        assert_eq!(\n            unwrap_dashboard_key("owner/repo", &wrapped, "correct horse battery").unwrap(),\n            key\n        );\n        assert!(unwrap_dashboard_key("owner/repo", &wrapped, "wrong password").is_err());\n    }\n'''
legacy = anchor + '''\n    #[test]\n    fn legacy_310k_access_manifest_keeps_original_password() {\n        let repo = "Owner/Repo";\n        let password = "original password";\n        let encoded_dashboard_key = generate_key();\n        let salt = [7u8; 16];\n        let nonce_bytes = [9u8; 12];\n        let wrapping_key = derive_password_key(password, &salt, 310_000);\n        let cipher = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();\n        let aad = format!("{ACCESS_AAD_PREFIX}{}", repo.to_ascii_lowercase());\n        let ciphertext = cipher\n            .encrypt(\n                Nonce::from_slice(&nonce_bytes),\n                Payload { msg: encoded_dashboard_key.as_bytes(), aad: aad.as_bytes() },\n            )\n            .unwrap();\n        let envelope = DashboardAccessEnvelope {\n            schema_version: 1,\n            kind: "usagemesh-dashboard-access".to_string(),\n            kdf: "PBKDF2-HMAC-SHA256".to_string(),\n            iterations: 310_000,\n            salt: URL_SAFE_NO_PAD.encode(salt),\n            algorithm: "AES-256-GCM".to_string(),\n            nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),\n            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),\n            updated_at: "2026-08-27T00:00:00Z".to_string(),\n        };\n        assert_eq!(\n            unwrap_dashboard_key(repo, &envelope, password).unwrap(),\n            encoded_dashboard_key\n        );\n    }\n'''
if 'legacy_310k_access_manifest_keeps_original_password' not in text:
    if anchor not in text:
        raise SystemExit('crypto password test anchor missing')
    text = text.replace(anchor, legacy, 1)
crypto.write_text(text)
