use super::{Result, ensure};
use serde_json::Value;
pub fn fields(v: &Value, allowed: &[&str]) -> Result<()> {
    ensure(
        v.as_object()
            .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str()))),
        "invalid_input",
        400,
    )
}
pub fn text<'a>(v: &'a Value, key: &str, min: usize, max: usize) -> Result<&'a str> {
    let s = v[key]
        .as_str()
        .ok_or_else(|| super::Error::new("invalid_input", 400))?;
    ensure(
        (min..=max).contains(&s.chars().count()),
        "invalid_input",
        400,
    )?;
    Ok(s)
}
pub fn name(v: &Value, key: &str, max: usize) -> Result<String> {
    let s = text(v, key, 1, max)?.trim();
    ensure(!s.is_empty(), "invalid_input", 400)?;
    Ok(s.into())
}
pub fn email(v: &Value, key: &str) -> Result<String> {
    let s = text(v, key, 3, 254)?.trim().to_lowercase();
    ensure(s.parse::<lettre::Address>().is_ok(), "invalid_input", 400)?;
    Ok(s)
}
pub fn choice<'a>(v: &'a Value, key: &str, choices: &[&str]) -> Result<&'a str> {
    let s = text(v, key, 0, 200)?;
    ensure(choices.contains(&s), "invalid_input", 400)?;
    Ok(s)
}
pub fn boolean(v: &Value, key: &str) -> Result<bool> {
    v[key]
        .as_bool()
        .ok_or_else(|| super::Error::new("invalid_input", 400))
}
pub fn integer(v: &Value, key: &str, min: i64, max: i64) -> Result<i64> {
    let n = v[key]
        .as_i64()
        .ok_or_else(|| super::Error::new("invalid_input", 400))?;
    ensure((min..=max).contains(&n), "invalid_input", 400)?;
    Ok(n)
}
pub fn timezone(v: &Value, key: &str) -> Result<String> {
    let tz = text(v, key, 1, 80)?;
    ensure(tz.parse::<chrono_tz::Tz>().is_ok(), "invalid_timezone", 400)?;
    Ok(tz.into())
}
pub fn date(value: &str) -> Result<()> {
    ensure(
        value.len() == 10
            && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == value),
        "invalid_date",
        400,
    )
}
pub fn code(value: &str) -> Result<()> {
    ensure(
        !value.is_empty()
            && value.len() <= 32
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "invalid_employee_code",
        400,
    )
}
