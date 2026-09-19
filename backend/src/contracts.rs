//! Typed boundaries: what routes answer with, what they accept, and the closed sets of
//! text the database stores. The wire format and the stored schema do not change when
//! an endpoint moves here.
use super::{
    Error, Result,
    collectors::Provider,
    db::{self, FromRow, Row},
    ensure, text_enum, validate as v,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub fn request<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_input", 400))
}
fn invalid_record() -> Error {
    Error::new("invalid_stored_record", 500)
}

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum Environment {
        Preview => "preview",
        Production => "production",
    }
}
impl Environment {
    pub fn is_preview(self) -> bool {
        self == Self::Preview
    }
    pub fn is_production(self) -> bool {
        self == Self::Production
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum ProviderMode {
        Fixture => "fixture",
        Native => "native",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum DspStatus {
        Provisioning => "provisioning",
        Active => "active",
        Suspended => "suspended",
        Failed => "failed",
    }
}
text_enum! {
    pub enum UserStatus {
        Active => "active",
        Disabled => "disabled",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum ConnectionStatus {
        NotConnected => "not_connected",
        Ready => "ready",
        SigningIn => "signing_in",
        NeedsVerification => "needs_verification",
        Error => "error",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum OwnerStatus {
        Active => "active",
        Invited => "invited",
        Missing => "missing",
    }
}
text_enum! {
    /// What a schedule collects: one provider's data, or every scheduled provider's.
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum ScheduleCollection {
        Paycom => "paycom",
        MealBreak => "meal_break",
        Both => "both",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum Cadence {
        Interval => "interval",
        Daily => "daily",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum Presence {
        Active => "active",
        Idle => "idle",
        Offline => "offline",
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}
impl LoginRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let mut input: Self = request(value)?;
        input.email = v::email(value, "email")?;
        v::text(value, "password", 0, 128)?;
        Ok(input)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordRequest {
    pub current_password: String,
    pub password: String,
}
impl PasswordRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let input = request(value)?;
        v::text(value, "currentPassword", 0, 128)?;
        v::text(value, "password", 8, 128)?;
        Ok(input)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetRequest {
    pub token: String,
    pub password: String,
}
impl ResetRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let input = request(value)?;
        v::text(value, "token", 43, 43)?;
        v::text(value, "password", 8, 128)?;
        Ok(input)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvitationRequest {
    pub first_name: String,
    pub last_name: String,
    pub password: String,
}
impl InvitationRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let mut input: Self = request(value)?;
        input.first_name = v::name(value, "firstName", 100)?;
        input.last_name = v::name(value, "lastName", 100)?;
        v::text(value, "password", 8, 128)?;
        Ok(input)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionRequest {
    pub request_id: String,
    pub date: Option<String>,
}
impl CollectionRequest {
    pub fn parse(value: &Value, require_date: bool) -> Result<Self> {
        let input: Self = request(value)?;
        v::text(value, "requestId", 1, 128)?;
        if require_date || value.get("date").is_some() {
            v::date(v::text(value, "date", 10, 10)?)?;
        }
        Ok(input)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub platform_owner: bool,
}
impl PublicUser {
    pub fn name(&self) -> String {
        format!("{} {}", self.first_name, self.last_name)
    }
}
impl FromRow for PublicUser {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            email: row.get("email")?,
            first_name: row.get("first_name")?,
            last_name: row.get("last_name")?,
            platform_owner: row.get("platform_owner")?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Dsp {
    pub id: String,
    pub name: String,
    pub environment: Environment,
    pub status: DspStatus,
    pub timezone: String,
    pub permanent: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub created_at: String,
}
impl FromRow for Dsp {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            environment: row.get("environment")?,
            status: row.get("status")?,
            timezone: row.get("timezone")?,
            permanent: row.get("permanent")?,
            revision: row.get("revision")?,
            created_at: row.get("created_at")?,
        })
    }
}
/// A DSP as the session lists it: who owns it, the caller's role, and its collection state.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DspSummary {
    #[serde(flatten)]
    pub dsp: Dsp,
    #[cfg_attr(test, ts(type = "unknown"))]
    pub profile: Value,
    pub owner_email: Option<String>,
    pub owner_status: OwnerStatus,
    pub paycom: ConnectionStatus,
    pub last_collection: Option<String>,
    pub role: Option<String>,
    /// The query's own columns, which earlier releases sent along. No dashboard reads
    /// them; they stay until a release has shipped without a reader that could.
    #[serde(flatten)]
    #[cfg_attr(test, ts(skip))]
    pub legacy: DspSummaryLegacy,
}
#[derive(Clone, Debug, Serialize)]
pub struct DspSummaryLegacy {
    pub member_role: Option<String>,
    pub owner_email: Option<String>,
    pub platform_email: Option<String>,
    pub invite_email: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub user_id: String,
    pub dsp_id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub role_id: Option<String>,
    pub owner: bool,
    pub status: Presence,
}
/// A role as the team pages list it. The counts are only known to the list.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub name: String,
    pub owner: bool,
    pub permissions: Vec<String>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub members: Option<i64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub invitations: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RoleSummary {
    pub id: String,
    pub name: String,
    pub owner: bool,
}
/// What opening a DSP answers with: the signed view token and what the role may do.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DspView {
    pub dsp: Dsp,
    pub role: RoleSummary,
    pub permissions: Vec<String>,
    pub token: String,
    #[cfg_attr(test, ts(type = "unknown"))]
    pub profile: Value,
    /// Every role of the DSP, sent only to a platform owner so they can look through one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub roles: Option<Vec<RoleSummary>>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub provider: String,
    pub enabled: bool,
    pub status: ConnectionStatus,
    pub error: Option<String>,
    pub updated_at: String,
    pub last_verified_at: Option<String>,
    pub account_label: Option<String>,
    /// The browser session a member can take over, while one waits for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub verification_session_id: Option<String>,
}
impl FromRow for Connection {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            provider: row.get("provider")?,
            enabled: row.get("enabled")?,
            status: row.get("status")?,
            error: row.get("error")?,
            updated_at: row.get("updated_at")?,
            last_verified_at: row.get("verified_at")?,
            account_label: row.get("account_label")?,
            verification_session_id: None,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CollectionSchedule {
    pub id: String,
    pub name: String,
    pub collection: ScheduleCollection,
    pub cadence: Cadence,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub interval_minutes: Option<i64>,
    pub local_time: String,
    pub enabled: bool,
    pub next_run: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CollectionSchedules {
    pub timezone: String,
    pub dsp_name: String,
    pub schedules: Vec<CollectionSchedule>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    pub next_run: String,
}
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub user: PublicUser,
    pub csrf: String,
    pub dsps: Vec<DspSummary>,
    pub development: bool,
    pub environment: Environment,
    pub release: String,
    pub provider_mode: ProviderMode,
}

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum JobStatus {
        Queued => "queued",
        Running => "running",
        WaitingVerification => "waiting_verification",
        Succeeded => "succeeded",
        Failed => "failed",
        Cancelled => "cancelled",
    }
}
/// The SQL list of a group of job statuses, for `concat!` into a statement:
/// `active` jobs are not finished yet, `leased` ones are held by a worker.
#[macro_export]
macro_rules! job_statuses {
    (active) => {
        "('queued','running','waiting_verification')"
    };
    (leased) => {
        "('running','waiting_verification')"
    };
}
impl JobStatus {
    pub const ACTIVE: &'static [JobStatus] =
        &[Self::Queued, Self::Running, Self::WaitingVerification];
    pub const LEASED: &'static [JobStatus] = &[Self::Running, Self::WaitingVerification];
    pub fn is_active(self) -> bool {
        Self::ACTIVE.contains(&self)
    }
    /// A worker holds the job.
    pub fn is_leased(self) -> bool {
        Self::LEASED.contains(&self)
    }
}
/// A job kind some registered provider runs. Anything else is not a stored job.
#[derive(Clone, Copy, Debug)]
pub struct JobKind(Provider);
impl Serialize for JobKind {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.job_kind())
    }
}
impl<'de> Deserialize<'de> for JobKind {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let kind = String::deserialize(deserializer)?;
        Provider::from_job_kind(&kind)
            .map(Self)
            .map_err(|_| serde::de::Error::custom("unknown job kind"))
    }
}
impl JobKind {
    pub fn provider(self) -> Provider {
        self.0
    }
}
impl rusqlite::types::FromSql for JobKind {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let kind = Provider::from_job_kind(value.as_str()?);
        kind.map(Self)
            .map_err(|_| rusqlite::types::FromSqlError::InvalidType)
    }
}
// A progress update may only move a claimed job between these active states.
pub enum ActiveJobStatus {
    Running,
    WaitingVerification,
}
impl ActiveJobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::WaitingVerification => "waiting_verification",
        }
    }
}
/// A row of `jobs`, as the queue and the workers read it.
#[derive(Clone, Debug)]
pub struct JobRow {
    pub id: String,
    pub dsp_id: String,
    pub environment: Environment,
    pub kind: JobKind,
    pub status: JobStatus,
    pub progress: i64,
    pub message: String,
    pub attempt: i64,
    pub max_attempts: i64,
    pub available_at: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub release: String,
    pub actor_id: Option<String>,
    pub lease_owner: Option<String>,
    pub lease_until: Option<i64>,
    pub connection_revision: i64,
    pub idempotency_key: String,
    pub request: String,
}
impl FromRow for JobRow {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            dsp_id: row.get("dsp_id")?,
            environment: row.get("environment")?,
            kind: row.get("kind")?,
            status: row.get("status")?,
            progress: row.get("progress")?,
            message: row.get("message")?,
            attempt: row.get("attempt")?,
            max_attempts: row.get("max_attempts")?,
            available_at: row.get("available_at")?,
            created_at: row.get("created_at")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            error: row.get("error")?,
            release: row.get("release")?,
            actor_id: row.get("actor_id")?,
            lease_owner: row.get("lease_owner")?,
            lease_until: row.get("lease_until")?,
            connection_revision: row.get("connection_revision")?,
            idempotency_key: row.get("idempotency_key")?,
            request: row.get("request")?,
        })
    }
}
impl JobRow {
    pub fn provider(&self) -> Provider {
        self.kind.provider()
    }
    pub fn held_by(&self, owner: &str) -> bool {
        self.lease_owner.as_deref() == Some(owner) && self.status.is_leased()
    }
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicJob {
    pub id: String,
    pub dsp_id: String,
    pub dsp_name: String,
    pub environment: Environment,
    #[cfg_attr(test, ts(type = "\"paycom.collect\" | \"cortex.meal_breaks.collect\""))]
    pub kind: JobKind,
    pub status: JobStatus,
    pub progress: u8,
    pub message: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub available_at: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub release: String,
    pub actor_id: Option<String>,
    #[cfg_attr(test, ts(type = "Array<unknown>"))]
    pub metrics: Vec<Value>,
}
impl PublicJob {
    pub fn new(row: JobRow, dsp_name: String, metrics: Vec<Value>) -> Result<Self> {
        ensure(
            (0..=100).contains(&row.progress),
            "invalid_stored_record",
            500,
        )?;
        Ok(Self {
            id: row.id,
            dsp_id: row.dsp_id,
            dsp_name,
            environment: row.environment,
            kind: row.kind,
            status: row.status,
            progress: row.progress as u8,
            message: row.message,
            attempt: u32::try_from(row.attempt).map_err(|_| invalid_record())?,
            max_attempts: u32::try_from(row.max_attempts).map_err(|_| invalid_record())?,
            available_at: db::at(row.available_at),
            created_at: row.created_at,
            started_at: row.started_at,
            completed_at: row.completed_at,
            error: row.error,
            release: row.release,
            actor_id: row.actor_id,
            metrics,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn missing_or_mistyped_fields_do_not_become_empty_values() {
        for input in [
            json!({"email":"a@example.com"}),
            json!({"email":"a@example.com","password":123}),
            json!({"email":"a@example.com","password":"","extra":true}),
        ] {
            assert!(LoginRequest::parse(&input).is_err());
        }
        assert!(CollectionRequest::parse(&json!({"requestId":"test","date":null}), false).is_err());
        assert!(CollectionRequest::parse(&json!({"requestId":"test"}), true).is_err());
        assert!(
            CollectionRequest::parse(&json!({"requestId":"test","date":"2026-02-30"}), false)
                .is_err()
        );
        assert!(JobStatus::parse("finished").is_none());
        let list = |statuses: &[JobStatus]| {
            let quoted: Vec<_> = statuses
                .iter()
                .map(|s| format!("'{}'", s.as_str()))
                .collect();
            format!("({})", quoted.join(","))
        };
        assert_eq!(crate::job_statuses!(active), list(JobStatus::ACTIVE));
        assert_eq!(crate::job_statuses!(leased), list(JobStatus::LEASED));
        assert!(serde_json::from_value::<JobStatus>(json!("finished")).is_err());
    }
}

/// The TypeScript the dashboard compiles against, written from the types above into
/// `shared/contracts/generated`. `npm run contracts:generate` rewrites the files; every
/// other test run fails when they no longer match, so the two sides cannot drift.
#[cfg(test)]
mod generated {
    use super::*;
    use std::{collections::BTreeMap, path::PathBuf};
    use ts_rs::TS;

    macro_rules! exported {
        ($cfg:expr, $($ty:ty),* $(,)?) => {
            BTreeMap::from([$((
                <$ty>::output_path().expect("named type"),
                <$ty>::export_to_string($cfg).expect("exportable type"),
            )),*])
        };
    }
    fn bindings() -> BTreeMap<PathBuf, String> {
        let cfg = ts_rs::Config::new();
        exported!(
            &cfg,
            Cadence,
            CollectionSchedule,
            CollectionSchedules,
            Connection,
            ConnectionStatus,
            Dsp,
            DspStatus,
            DspSummary,
            DspView,
            Environment,
            JobStatus,
            Member,
            OwnerStatus,
            Presence,
            ProviderMode,
            PublicJob,
            PublicUser,
            Role,
            RoleSummary,
            ScheduleCollection,
            SchedulePreview,
            SessionResponse,
        )
    }
    #[test]
    fn typescript_contracts_match_the_rust_types() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shared/contracts/generated");
        let bindings = bindings();
        if std::env::var_os("DISPATCH_UPDATE_CONTRACTS").is_some() {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (file, text) in &bindings {
                std::fs::write(dir.join(file), text).unwrap();
            }
        }
        let mut stored = BTreeMap::new();
        for entry in std::fs::read_dir(&dir).expect("shared/contracts/generated") {
            let path = entry.unwrap().path();
            let name = PathBuf::from(path.file_name().unwrap());
            stored.insert(name, std::fs::read_to_string(&path).unwrap());
        }
        assert!(
            stored == bindings,
            "shared/contracts/generated is out of date: run `npm run contracts:generate`"
        );
    }
    #[test]
    fn the_job_kinds_written_for_typescript_are_the_registered_ones() {
        let kinds: Vec<_> = Provider::ALL
            .iter()
            .map(|p| format!("{:?}", p.job_kind()))
            .collect();
        let cfg = ts_rs::Config::new();
        assert!(
            PublicJob::export_to_string(&cfg)
                .unwrap()
                .contains(&kinds.join(" | "))
        );
    }
}
