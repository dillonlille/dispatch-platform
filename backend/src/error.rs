use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// The error codes the backend itself branches on. The wire format stays the code's
/// text; a code that is only ever produced stays a string literal where it is raised.
/// Compare with `Error::is`/`Error::is_any`/`Code::parse`, never with the text.
macro_rules! codes {
    ($($name:ident => $text:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Code { $($name,)* }
        impl Code {
            pub const ALL: &'static [Code] = &[$(Code::$name,)*];
            pub const fn as_str(self) -> &'static str {
                match self { $(Code::$name => $text,)* }
            }
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(Code::$name),)* _ => None }
            }
        }
    };
}
codes! {
    BrowserLost => "browser_lost",
    BrowserClosed => "browser_closed",
    BrowserCommandTimeout => "browser_command_timeout",
    BrowserNavigationPending => "browser_navigation_pending",
    BrowserScriptFailed => "browser_script_failed",
    BrowserMemoryBusy => "browser_memory_busy",
    BrowserStartFailed => "browser_start_failed",
    BrowserCapacityBusy => "browser_capacity_busy",
    ProviderTimeout => "provider_timeout",
    ProviderUnavailable => "provider_unavailable",
    ProviderNavigationTimeout => "provider_navigation_timeout",
    ProviderContentTimeout => "provider_content_timeout",
    ProviderContentMissing => "provider_content_missing",
    ProviderHoursMismatch => "provider_hours_mismatch",
    ProviderResponseUnreadable => "provider_response_unreadable",
    CortexSourceChanged => "cortex_source_changed",
    CortexContentIncomplete => "cortex_content_incomplete",
    CortexScopeMismatch => "cortex_scope_mismatch",
    CortexTimezoneMismatch => "cortex_timezone_mismatch",
    CortexSourceTooLarge => "cortex_source_too_large",
    CortexStationUnavailable => "cortex_station_unavailable",
    CortexProviderAmbiguous => "cortex_provider_ambiguous",
    CortexInvalidMealEvidence => "cortex_invalid_meal_evidence",
    CortexInvalidIdentity => "cortex_invalid_identity",
    InvalidCortexScope => "invalid_cortex_scope",
    TimecardExtractionFailed => "timecard_extraction_failed",
    InvalidTimecardHours => "invalid_timecard_hours",
    VerificationRequired => "verification_required",
    ManualVerificationRequired => "manual_verification_required",
    VerificationIncomplete => "verification_incomplete",
    InvalidVerificationCode => "invalid_verification_code",
    ConnectionBusy => "connection_busy",
    PrimaryCredentialsRejected => "primary_credentials_rejected",
    SecurityAnswersRejected => "security_answers_rejected",
    InvalidCredentials => "invalid_credentials",
    JobCancelled => "job_cancelled",
    PermissionDenied => "permission_denied",
    ConnectionChanged => "connection_changed",
    DspUnavailable => "dsp_unavailable",
    AccountLocked => "account_locked",
}
impl Code {
    /// A failed attempt with one of these is queued again while attempts remain.
    pub const RETRYABLE: &'static [Code] = &[
        Code::BrowserLost,
        Code::BrowserClosed,
        Code::BrowserCommandTimeout,
        Code::ProviderTimeout,
        Code::ProviderUnavailable,
        Code::ProviderNavigationTimeout,
        Code::ProviderContentTimeout,
        Code::ProviderResponseUnreadable,
        Code::CortexSourceChanged,
        Code::CortexContentIncomplete,
    ];
    /// The job stopped because someone withdrew it or its access; that is not a failure.
    pub const WITHDRAWN: &'static [Code] = &[
        Code::JobCancelled,
        Code::PermissionDenied,
        Code::ConnectionChanged,
        Code::DspUnavailable,
    ];
    /// A verification step may be tried again in the same browser after one of these.
    pub const RECOVERABLE: &'static [Code] = &[
        Code::VerificationIncomplete,
        Code::InvalidVerificationCode,
        Code::ConnectionBusy,
    ];
    /// The provider refused what the owner entered; repeated ones lock further attempts.
    pub const REJECTED_CREDENTIALS: &'static [Code] = &[
        Code::PrimaryCredentialsRejected,
        Code::SecurityAnswersRejected,
        Code::InvalidCredentials,
    ];
    /// Only a person at the provider's own site can clear these; signing in again would not.
    pub const NEEDS_OWNER: &'static [Code] =
        &[Code::ManualVerificationRequired, Code::AccountLocked];
    /// No browser could be admitted right now; the job goes back without using an attempt.
    pub const ADMISSION_BUSY: &'static [Code] =
        &[Code::BrowserMemoryBusy, Code::BrowserCapacityBusy];
    pub fn is_retryable(self) -> bool {
        Self::RETRYABLE.contains(&self)
    }
    /// Classifies a stored or reported code, such as a job's `error` column.
    pub fn text_is_any(text: &str, codes: &[Code]) -> bool {
        Self::parse(text).is_some_and(|code| codes.contains(&code))
    }
}
impl From<Code> for String {
    fn from(code: Code) -> Self {
        code.as_str().to_owned()
    }
}
impl std::fmt::Display for Code {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

type Cause = Box<dyn std::error::Error + Send + Sync + 'static>;
#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub status: u16,
    /// What the operating system or SQLite reported. Never sent to a client.
    cause: Option<Cause>,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: impl Into<String>, status: u16) -> Self {
        Self {
            code: code.into(),
            status,
            cause: None,
        }
    }
    pub(crate) fn caused(code: &str, status: u16, cause: impl Into<Cause>) -> Self {
        Self {
            cause: Some(cause.into()),
            ..Self::new(code, status)
        }
    }
    pub fn known(&self) -> Option<Code> {
        Code::parse(&self.code)
    }
    pub fn is(&self, code: Code) -> bool {
        self.code == code.as_str()
    }
    pub fn is_any(&self, codes: &[Code]) -> bool {
        self.known().is_some_and(|code| codes.contains(&code))
    }
    pub fn is_retryable(&self) -> bool {
        self.is_any(Code::RETRYABLE)
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
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as _)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        super::observability::event(
            "error",
            "storage.io_failed",
            json!({"kind":format!("{:?}",e.kind()),"cause":e.to_string()}),
        );
        Self::caused("operation_failed", 500, e)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        super::observability::event(
            "error",
            "database.failed",
            json!({"code":e.sqlite_error().map(|e| e.extended_code),"cause":e.to_string()}),
        );
        Self::caused("operation_failed", 500, e)
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_retryable_codes_are_exactly_the_ones_jobs_always_retried() {
        let retryable: Vec<_> = Code::RETRYABLE.iter().map(|code| code.as_str()).collect();
        assert_eq!(
            retryable,
            [
                "browser_lost",
                "browser_closed",
                "browser_command_timeout",
                "provider_timeout",
                "provider_unavailable",
                "provider_navigation_timeout",
                "provider_content_timeout",
                "provider_response_unreadable",
                "cortex_source_changed",
                "cortex_content_incomplete",
            ]
        );
        for code in Code::ALL {
            assert_eq!(Code::parse(code.as_str()), Some(*code));
            assert_eq!(code.is_retryable(), retryable.contains(&code.as_str()));
        }
        assert!(Error::new("browser_lost", 503).is_retryable());
        assert!(!Error::new("queue_full", 429).is_retryable());
        assert!(!Code::text_is_any("queue_full", Code::RETRYABLE));
    }
    #[test]
    fn storage_errors_keep_their_cause_and_their_wire_code() {
        use std::error::Error as _;
        let error = Error::from(std::io::Error::other("disk detail"));
        assert_eq!(
            (error.code.as_str(), error.status),
            ("operation_failed", 500)
        );
        assert_eq!(error.source().unwrap().to_string(), "disk detail");
        assert!(Error::new("invalid_input", 400).source().is_none());
    }
}
