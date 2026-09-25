use super::*;
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
    pub profile: DspProfile,
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
/// One queued email as platform Diagnostics lists it. What it was for is known only for
/// mail queued since the outbox recorded it; an invitation's row lasts as long as the
/// invitation does.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MailMessage {
    pub id: String,
    /// `invitation`, `reset`, or none for older mail.
    pub kind: Option<String>,
    /// `pending`, `sent` or `failed`.
    pub status: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub attempts: i64,
    pub queued_at: Option<String>,
    pub sent_at: Option<String>,
    pub last_attempt_at: Option<String>,
    /// When a pending message is tried next.
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub recipient: Option<String>,
    pub role: Option<String>,
    /// The invitation is for the DSP's owner, who also sets the DSP up.
    pub owner: bool,
    pub dsp_name: Option<String>,
    /// Who invited them; none when a platform owner did.
    pub invited_by: Option<String>,
    pub accepted_at: Option<String>,
    /// Owner invitations only: the DSP's setup is finished.
    pub setup_complete: Option<bool>,
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
    pub profile: DspProfile,
    /// Every role of the DSP, sent only to a platform owner so they can look through one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub roles: Option<Vec<RoleSummary>>,
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
    pub source: RuntimeSource,
}

/// What the running build was made from, so the dashboard can link its source.
#[derive(Clone, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSource {
    /// Set only on Production, which runs published releases.
    pub version: Option<String>,
    pub commit: Option<String>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AccountSession {
    pub id: String,
    pub current: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub created_at: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub expires_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct DspProfile {
    pub abbreviation: String,
    pub station_code: String,
    pub setup_required: bool,
    pub removed: bool,
    pub support_visible: bool,
}
