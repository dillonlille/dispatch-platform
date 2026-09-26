use super::{Error, Result, ensure};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
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
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC supports any key length");
    mac.update(value.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}
pub fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
pub fn hash_password(value: &str) -> Result<String> {
    ensure(
        (15..=128).contains(&value.chars().count()) && !compromised_password(value),
        "invalid_password",
        400,
    )?;
    Argon2::default()
        .hash_password_with_salt(value.as_bytes(), &random::<16>()?)
        .map(|h| h.to_string())
        .map_err(|_| Error::new("password_failed", 500))
}
fn compromised_password(value: &str) -> bool {
    // Kept local so password material (including a derived prefix) never leaves Dispatch.
    const COMMON: &[&str] = &[
        "123456789012345",
        "1234567890123456",
        "111111111111111",
        "aaaaaaaaaaaaaaa",
        "abcdefghijklmno",
        "administrator123",
        "changemechangeme",
        "correcthorsebatterystaple",
        "iloveyouiloveyou",
        "letmeinletmeinletmein",
        "passwordpassword",
        "password123456",
        "qwertyqwertyqwerty",
        "qwertyuiopasdfgh",
        "thisisapassword",
        "welcome123456789",
    ];
    let folded = value.trim().to_lowercase();
    COMMON.contains(&folded.as_str())
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
            &Nonce::from(nonce),
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
    let nonce = Nonce::try_from(B64.decode(nonce).map_err(|_| invalid())?.as_slice())
        .map_err(|_| invalid())?;
    let body = B64.decode(body).map_err(|_| invalid())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| invalid())?;
    let plain = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &body,
                aad: binding.as_bytes(),
            },
        )
        .map_err(|_| invalid())?;
    Ok(serde_json::from_slice(&plain)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Written by argon2 0.5, aes-gcm 0.10, hmac 0.12 and sha2 0.10. Stored passwords,
    // sealed credentials and signed values must keep working across library updates.
    const PASSWORD: &str = "$argon2id$v=19$m=19456,t=2,p=1$C6TJINtK+QXKynKYz7+0yw$\
        yaNW7UfSOeGStcAIvDqRZmRukfwf9cJZmg80zWOqwMs";
    const SEALED: &str = "-jO4ORfuqy5LGd8k.Cwg6GUBJeaWuE_rJf8QCFxRxd6FMav27VPtiLKJ4xAte6VN8vzVoHrSI1QGVyrnGsixXMpgjZA";

    #[test]
    fn values_written_by_earlier_libraries_still_verify() {
        let key = [7u8; 32];
        assert!(check_password("correct horse battery", PASSWORD));
        assert!(!check_password("correct horse batterz", PASSWORD));
        assert_eq!(
            decrypt(&key, "dsp_vector:paycom:2", SEALED).unwrap(),
            json!({"username":"vector","answers":[1,2,3]})
        );
        assert!(decrypt(&key, "dsp_other:paycom:2", SEALED).is_err());
        assert!(decrypt(&[8u8; 32], "dsp_vector:paycom:2", SEALED).is_err());
        assert_eq!(
            sign(&key, "session:vector"),
            "1E5nOJSJz28c6CcrnFuGjlPdjVDlS7Kvti2nyJJN8lA"
        );
        assert_eq!(
            sha("dispatch"),
            "db8d1b6d64e4ec90ceb335fc4344e75799fdc20cd236d27cc85ed4783a33d3fa"
        );
    }

    #[test]
    fn new_values_keep_the_same_parameters_and_round_trip() {
        let key = [7u8; 32];
        let hash = hash_password("correct horse battery").unwrap();
        assert!(
            hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
            "{hash}"
        );
        assert!(check_password("correct horse battery", &hash));
        assert_ne!(hash, hash_password("correct horse battery").unwrap());
        let sealed = encrypt(&key, "binding", &json!({"a":1})).unwrap();
        assert_eq!(decrypt(&key, "binding", &sealed).unwrap(), json!({"a":1}));
        let (nonce, body) = sealed.split_once('.').unwrap();
        assert!(decrypt(&key, "binding", &format!("{nonce}A.{body}")).is_err());
    }

    #[test]
    fn new_passwords_are_long_and_not_common() {
        for value in [
            "short-password",
            "passwordpassword",
            " CorrectHorseBatteryStaple ",
        ] {
            assert_eq!(hash_password(value).unwrap_err().code, "invalid_password");
        }
        assert!(hash_password("a unique dispatch password").is_ok());
    }
}
