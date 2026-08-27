use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::model::{DashboardAccessEnvelope, EncryptedLedger, Ledger};

const LEDGER_AAD_PREFIX: &str = "usagemesh-ledger-v2:";
const ACCESS_AAD_PREFIX: &str = "usagemesh-dashboard-access-v1:";
pub const ACCESS_PBKDF2_ITERATIONS: u32 = 310_000;

pub fn generate_key() -> String {
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    URL_SAFE_NO_PAD.encode(key)
}

pub fn decode_key(value: &str) -> Result<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim())
        .context("dashboard key is not valid base64url")?;
    if bytes.len() != 32 {
        bail!("dashboard key must decode to exactly 32 bytes");
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

pub fn device_hash(device_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device_id.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

pub fn encrypt_ledger(ledger: &Ledger, encoded_key: &str) -> Result<EncryptedLedger> {
    let key = decode_key(encoded_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256 key length is fixed");
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let hash = device_hash(&ledger.device.id);
    let aad = format!("{LEDGER_AAD_PREFIX}{hash}");
    let plaintext = serde_json::to_vec(ledger)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("failed to encrypt ledger"))?;
    Ok(EncryptedLedger {
        schema_version: 2,
        kind: "usagemesh-encrypted-ledger".to_string(),
        device_hash: hash,
        updated_at: ledger.generated_at.clone(),
        algorithm: "AES-256-GCM".to_string(),
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

pub fn decrypt_ledger(envelope: &EncryptedLedger, encoded_key: &str) -> Result<Ledger> {
    let key = decode_key(encoded_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256 key length is fixed");
    let nonce = URL_SAFE_NO_PAD.decode(&envelope.nonce)?;
    if nonce.len() != 12 {
        bail!("invalid ledger nonce");
    }
    let ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext)?;
    let aad = format!("{LEDGER_AAD_PREFIX}{}", envelope.device_hash);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("ledger authentication failed"))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn derive_password_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

/// Wrap the existing random workspace dashboard key with a memorable password.
/// The password itself is never stored; browsers derive the same wrapping key
/// with WebCrypto PBKDF2 and decrypt this tiny manifest locally.
pub fn wrap_dashboard_key(
    repo: &str,
    encoded_dashboard_key: &str,
    password: &str,
) -> Result<DashboardAccessEnvelope> {
    decode_key(encoded_dashboard_key)?;
    if password.as_bytes().len() < 8 {
        bail!("dashboard password must be at least 8 bytes long");
    }

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let wrapping_key = derive_password_key(password, &salt, ACCESS_PBKDF2_ITERATIONS);
    let cipher = Aes256Gcm::new_from_slice(&wrapping_key).expect("AES-256 key length is fixed");
    let aad = format!("{ACCESS_AAD_PREFIX}{}", repo.trim().to_ascii_lowercase());
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: encoded_dashboard_key.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("failed to wrap dashboard key"))?;

    Ok(DashboardAccessEnvelope {
        schema_version: 1,
        kind: "usagemesh-dashboard-access".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        iterations: ACCESS_PBKDF2_ITERATIONS,
        salt: URL_SAFE_NO_PAD.encode(salt),
        algorithm: "AES-256-GCM".to_string(),
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
}

pub fn unwrap_dashboard_key(
    repo: &str,
    envelope: &DashboardAccessEnvelope,
    password: &str,
) -> Result<String> {
    if envelope.schema_version != 1
        || envelope.kind != "usagemesh-dashboard-access"
        || envelope.kdf != "PBKDF2-HMAC-SHA256"
        || envelope.algorithm != "AES-256-GCM"
    {
        bail!("unsupported dashboard access envelope");
    }
    let salt = URL_SAFE_NO_PAD.decode(&envelope.salt)?;
    let nonce = URL_SAFE_NO_PAD.decode(&envelope.nonce)?;
    if salt.len() != 16 || nonce.len() != 12 {
        bail!("invalid dashboard access envelope");
    }
    let wrapping_key = derive_password_key(password, &salt, envelope.iterations);
    let cipher = Aes256Gcm::new_from_slice(&wrapping_key).expect("AES-256 key length is fixed");
    let ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext)?;
    let aad = format!("{ACCESS_AAD_PREFIX}{}", repo.trim().to_ascii_lowercase());
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("dashboard password is incorrect"))?;
    let encoded = String::from_utf8(plaintext).context("invalid wrapped dashboard key")?;
    decode_key(&encoded)?;
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DeviceInfo, Metrics, PricingInfo};

    fn ledger() -> Ledger {
        Ledger {
            schema_version: 4,
            generated_at: "2026-08-26T00:00:00Z".into(),
            device: DeviceInfo {
                id: "mac".into(),
                name: "Mac".into(),
                platform: "macos".into(),
                arch: "aarch64".into(),
                hostname: "mac".into(),
                app_version: "1".into(),
            },
            rows: vec![],
            totals: Metrics {
                input: 10,
                output: 3,
                ..Default::default()
            },
            scan_ms: 5,
            pricing: PricingInfo::default(),
        }
    }

    #[test]
    fn ledger_round_trip() {
        let key = generate_key();
        let original = ledger();
        let encrypted = encrypt_ledger(&original, &key).unwrap();
        let decoded = decrypt_ledger(&encrypted, &key).unwrap();
        assert_eq!(decoded.totals.total_tokens(), 13);
        assert_ne!(
            encrypted.ciphertext,
            serde_json::to_string(&original).unwrap()
        );
    }

    #[test]
    fn wrong_ledger_key_fails_authentication() {
        let encrypted = encrypt_ledger(&ledger(), &generate_key()).unwrap();
        assert!(decrypt_ledger(&encrypted, &generate_key()).is_err());
    }

    #[test]
    fn password_wrap_round_trip() {
        let key = generate_key();
        let wrapped = wrap_dashboard_key("Owner/Repo", &key, "correct horse battery").unwrap();
        assert_eq!(
            unwrap_dashboard_key("owner/repo", &wrapped, "correct horse battery").unwrap(),
            key
        );
        assert!(unwrap_dashboard_key("owner/repo", &wrapped, "wrong password").is_err());
    }
}
