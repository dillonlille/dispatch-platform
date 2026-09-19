//! Typed boundaries for authentication and collection jobs. Other endpoints can
//! migrate independently without changing their wire format or stored schema.
use super::{Error, Result, collectors::Provider, db, ensure, validate as v};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub fn request<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_input", 400))
}
fn stored<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_stored_record", 500))
}
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Preview,
    Production,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderMode {
    Fixture,
    Native,
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub platform_owner: bool,
}
impl PublicUser {
    pub fn from_row(row: &Value) -> Result<Self> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            email: String,
            first_name: String,
            last_name: String,
            platform_owner: i64,
        }
        let row: Row = stored(row)?;
        ensure(
            [0, 1].contains(&row.platform_owner),
            "invalid_stored_record",
            500,
        )?;
        Ok(Self {
            id: row.id,
            email: row.email,
            first_name: row.first_name,
            last_name: row.last_name,
            platform_owner: row.platform_owner == 1,
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub user: PublicUser,
    pub csrf: String,
    pub dsps: Value,
    pub development: bool,
    pub environment: Environment,
    pub release: String,
    pub provider_mode: ProviderMode,
}
impl SessionResponse {
    pub fn environment(value: &str) -> Result<Environment> {
        stored(&Value::String(value.into()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    WaitingVerification,
    Succeeded,
    Failed,
    Cancelled,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicJob {
    pub id: String,
    pub dsp_id: String,
    pub dsp_name: String,
    pub environment: Environment,
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
    pub metrics: Vec<Value>,
}
impl PublicJob {
    pub fn from_row(value: &Value, name: &Value, metrics: Vec<Value>) -> Result<Self> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            dsp_id: String,
            environment: Environment,
            kind: JobKind,
            status: JobStatus,
            progress: u8,
            message: String,
            attempt: u32,
            max_attempts: u32,
            available_at: i64,
            created_at: String,
            #[serde(deserialize_with = "nullable")]
            started_at: Option<String>,
            #[serde(deserialize_with = "nullable")]
            completed_at: Option<String>,
            #[serde(deserialize_with = "nullable")]
            error: Option<String>,
            release: String,
            #[serde(deserialize_with = "nullable")]
            actor_id: Option<String>,
        }
        let row: Row = stored(value)?;
        ensure(row.progress <= 100, "invalid_stored_record", 500)?;
        Ok(Self {
            id: row.id,
            dsp_id: row.dsp_id,
            dsp_name: stored(name)?,
            environment: row.environment,
            kind: row.kind,
            status: row.status,
            progress: row.progress,
            message: row.message,
            attempt: row.attempt,
            max_attempts: row.max_attempts,
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
        assert!(PublicUser::from_row(&json!({"id":"user"})).is_err());
        assert!(stored::<JobStatus>(&json!("finished")).is_err());
        assert!(PublicJob::from_row(&json!({"id":"job"}), &json!("DSP"), vec![]).is_err());
    }
}
