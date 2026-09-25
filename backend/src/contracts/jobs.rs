use super::*;
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
        #[derive(PartialOrd, Ord)]
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
pub struct JobKind {
    provider: Provider,
    kind: &'static str,
}
impl Serialize for JobKind {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.kind)
    }
}
impl<'de> Deserialize<'de> for JobKind {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let kind = String::deserialize(deserializer)?;
        Self::parse(&kind).map_err(|_| serde::de::Error::custom("unknown job kind"))
    }
}
impl JobKind {
    pub fn parse(kind: &str) -> Result<Self> {
        let (provider, kind) = Provider::from_job_kind(kind)?;
        Ok(Self { provider, kind })
    }
    pub fn provider(self) -> Provider {
        self.provider
    }
    pub fn as_str(self) -> &'static str {
        self.kind
    }
}
impl rusqlite::types::FromSql for JobKind {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        Self::parse(value.as_str()?).map_err(|_| rusqlite::types::FromSqlError::InvalidType)
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
    #[cfg_attr(
        test,
        ts(
            type = "\"paycom.collect\" | \"cortex.meal_breaks.collect\" | \"cortex.scorecard.collect\""
        )
    )]
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
    pub metrics: Vec<JobMetrics>,
}
impl PublicJob {
    pub fn new(row: JobRow, dsp_name: String, metrics: Vec<JobMetrics>) -> Result<Self> {
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
