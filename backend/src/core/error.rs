use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub status: u16,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: impl Into<String>, status: u16) -> Self {
        Self {
            code: code.into(),
            status,
        }
    }
}
pub fn ensure(ok: bool, code: &str, status: u16) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::new(code, status))
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        super::observability::event(
            "error",
            "storage.io_failed",
            json!({"kind":format!("{:?}",e.kind())}),
        );
        Self::new("operation_failed", 500)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        super::observability::event(
            "error",
            "database.failed",
            json!({"code":e.sqlite_error().map(|e| e.extended_code)}),
        );
        Self::new("operation_failed", 500)
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new("invalid_input", 400)
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":self.code,"message":self.code.replace('_'," ")})),
        )
            .into_response()
    }
}
