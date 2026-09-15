use super::{Error, Result, ensure};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0; N];
    getrandom::fill(&mut out).map_err(|_| Error::new("entropy_unavailable", 500))?;
    Ok(out)
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn id(prefix: &str) -> Result<String> {
    Ok(format!("{prefix}_{}", hex(&random::<16>()?)))
}
pub fn token() -> Result<String> {
    Ok(B64.encode(random::<32>()?))
}
pub fn sha(value: impl AsRef<[u8]>) -> String {
    hex(&Sha256::digest(value))
}
pub fn sign(key: &[u8], value: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC supports any key length");
    mac.update(value.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}
pub fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
pub fn hash_password(value: &str) -> Result<String> {
    ensure(
        (12..=128).contains(&value.chars().count()),
        "invalid_password",
        400,
    )?;
    let salt =
        SaltString::encode_b64(&random::<16>()?).map_err(|_| Error::new("password_failed", 500))?;
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| Error::new("password_failed", 500))
}
pub fn check_password(value: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded).is_ok_and(|h| {
        Argon2::default()
            .verify_password(value.as_bytes(), &h)
            .is_ok()
    })
}
pub fn encrypt(key: &[u8], binding: &str, value: &serde_json::Value) -> Result<String> {
    let nonce = random::<12>()?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::new("invalid_key", 500))?;
    let body = serde_json::to_vec(value)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &body,
                aad: binding.as_bytes(),
            },
        )
        .map_err(|_| Error::new("encryption_failed", 500))?;
    Ok(format!("{}.{}", B64.encode(nonce), B64.encode(encrypted)))
}
pub fn decrypt(key: &[u8], binding: &str, value: &str) -> Result<serde_json::Value> {
    let invalid = || Error::new("credentials_unavailable", 409);
    let (nonce, body) = value.split_once('.').ok_or_else(invalid)?;
    let nonce = B64.decode(nonce).map_err(|_| invalid())?;
    ensure(nonce.len() == 12, "credentials_unavailable", 409)?;
    let body = B64.decode(body).map_err(|_| invalid())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| invalid())?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &body,
                aad: binding.as_bytes(),
            },
        )
        .map_err(|_| invalid())?;
    Ok(serde_json::from_slice(&plain)?)
}
