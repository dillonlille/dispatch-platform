use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub remember_me: bool,
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
    pub dsp_profile: Option<DspSetupRequest>,
}
impl InvitationRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let mut input: Self = request(value)?;
        input.first_name = v::name(value, "firstName", 100)?;
        input.last_name = v::name(value, "lastName", 100)?;
        v::text(value, "password", 8, 128)?;
        if input.dsp_profile.is_some() {
            input.dsp_profile = Some(DspSetupRequest::parse(&value["dspProfile"])?);
        }
        Ok(input)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DspSetupRequest {
    pub name: String,
    pub abbreviation: String,
    pub station_code: String,
    pub timezone: String,
}
impl DspSetupRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        let mut input: Self = request(value)?;
        input.name = v::name(value, "name", 100)?;
        input.abbreviation = v::name(value, "abbreviation", 16)?;
        input.timezone = v::timezone(value, "timezone")?;
        let station = v::text(value, "stationCode", 3, 8)?;
        ensure(
            station.bytes().all(|b| b.is_ascii_alphanumeric()),
            "invalid_input",
            400,
        )?;
        input.station_code = station.to_uppercase();
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
