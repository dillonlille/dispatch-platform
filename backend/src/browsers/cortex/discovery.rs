use super::*;
use crate::{
    job_metrics::Recorder,
    meals::{CollectionRequest, Scope},
};
// The page is between documents or signing in again; ask it again.
const PAGE_NOT_READY: &[crate::Code] = &[
    crate::Code::BrowserNavigationPending,
    crate::Code::BrowserScriptFailed,
    crate::Code::VerificationRequired,
];

const DISCOVER: &str = include_str!("discovery.js");

impl Driver {
    pub async fn resolve_scope(
        &mut self,
        request: &CollectionRequest,
        metrics: &Recorder,
    ) -> Result<Scope> {
        let discovery = match request {
            CollectionRequest::Scoped(scope) => {
                scope.validate()?;
                return Ok(scope.clone());
            }
            CollectionRequest::Discover(discovery) => discovery,
        };
        discovery.scope("discovery", "discovery")?;
        let path = |area: Option<&str>| {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query
                .append_pair("navMenuVariant", "external")
                .append_pair("selectedDay", &discovery.date);
            if let Some(area) = area {
                query.append_pair("serviceAreaId", area);
            }
            format!(
                "{}/operations/execution/itineraries?{}",
                self.origin,
                query.finish()
            )
        };
        self.page.start_navigation(&path(None)).await?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut area = None;
        let mut last_error = "cortex_content_incomplete".to_owned();
        while Instant::now() < deadline {
            let result = async {
                let frame = self.page.frame().await?;
                let url = url::Url::parse(s(&frame, "url"))
                    .map_err(|_| Error::new("cortex_content_incomplete", 502))?;
                ensure(
                    url.origin().ascii_serialization() == self.origin,
                    "verification_required",
                    409,
                )?;
                let input = json!({"origin":self.origin,"request":discovery});
                self.browser
                    .evaluate(&self.page.id, &call(DISCOVER, &input))
                    .await
            }
            .await;
            match result {
                Ok(value) if value.get("scope").is_some() => {
                    let scope: Scope = serde_json::from_value(value["scope"].clone())?;
                    request.validate_scope(&scope)?;
                    return Ok(scope);
                }
                Ok(value) if value.get("serviceAreaId").is_some() => {
                    let found = s(&value, "serviceAreaId");
                    discovery.scope(found, "discovery")?;
                    if area.as_deref() != Some(found) {
                        self.page.start_navigation(&path(Some(found))).await?;
                        area = Some(found.to_owned());
                        metrics.detail("scope_navigation");
                    } else {
                        metrics.detail("scope_settling");
                    }
                }
                Ok(value) => {
                    let error = s(&value, "error");
                    metrics.detail(s(&value, "reason"));
                    if ["cortex_timezone_mismatch", "cortex_source_too_large"].contains(&error) {
                        return Err(Error::new(error, 502));
                    }
                    last_error = if [
                        "cortex_station_unavailable",
                        "cortex_provider_ambiguous",
                        "cortex_scope_mismatch",
                    ]
                    .contains(&error)
                    {
                        error
                    } else {
                        "cortex_content_incomplete"
                    }
                    .into();
                }
                Err(error) if error.is_any(PAGE_NOT_READY) => {
                    metrics.detail(&error.code);
                    last_error = error.code
                }
                Err(error) => return Err(error),
            }
            sleep(Duration::from_millis(300)).await;
        }
        Err(Error::new(&last_error, 502))
    }
}
