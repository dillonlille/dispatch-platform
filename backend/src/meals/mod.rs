pub mod assessment;
mod comparison;
mod sync;
// Cortex meal evidence and atomic publication. Browser data is untrusted input.
use crate::{
    Error, Result,
    collectors::Provider,
    db::{Store, at, now, s},
    ensure,
};
use chrono::{NaiveDate, TimeZone, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub date: String,
    pub station: String,
    pub service_area_id: String,
    pub provider: String,
    pub timezone: String,
}
// The server pins the DSP's profile when queuing first-use discovery. Keep this
// request unchanged after resolving it, so retries remain idempotent.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CollectionRequest {
    Scoped(Scope),
    Discover(Discovery),
}
impl CollectionRequest {
    pub fn validate_scope(&self, scope: &Scope) -> Result<()> {
        scope.validate()?;
        let matches = match self {
            Self::Scoped(expected) => scope == expected,
            Self::Discover(discovery) => {
                scope == &discovery.scope(&scope.service_area_id, &scope.provider)?
                    && !["ALL_DSPS", "ALL_DRIVERS"].contains(&scope.provider.as_str())
            }
        };
        ensure(matches, "cortex_scope_mismatch", 502)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub date: String,
    pub station: String,
    pub timezone: String,
    pub dsp_name: String,
    pub dsp_abbreviation: String,
}
impl Discovery {
    pub fn scope(&self, service_area_id: &str, provider: &str) -> Result<Scope> {
        let scope = Scope {
            date: self.date.clone(),
            station: self.station.clone(),
            timezone: self.timezone.clone(),
            service_area_id: service_area_id.into(),
            provider: provider.into(),
        };
        scope.validate()?;
        Ok(scope)
    }
}
fn token(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 256
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:#".contains(&b))
}
fn label(v: &str) -> bool {
    !v.trim().is_empty() && v.len() <= 256 && !v.chars().any(char::is_control)
}
impl Scope {
    pub fn validate(&self) -> Result<()> {
        let tz: chrono_tz::Tz = self
            .timezone
            .parse()
            .map_err(|_| Error::new("invalid_timezone", 400))?;
        let date = NaiveDate::parse_from_str(&self.date, "%Y-%m-%d")
            .map_err(|_| Error::new("invalid_date", 400))?;
        ensure(
            date.to_string() == self.date
                && self.date.as_str() >= "2000-01-01"
                && date <= Utc::now().with_timezone(&tz).date_naive(),
            "invalid_date",
            400,
        )?;
        ensure(
            (3..=8).contains(&self.station.len())
                && self
                    .station
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                && [&self.service_area_id, &self.provider].iter().all(|v| {
                    !v.is_empty()
                        && v.len() <= 128
                        && v.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                })
                && self.provider != "ALL_DSPS",
            "invalid_cortex_scope",
            400,
        )
    }
    pub fn request(value: &Value, timezone: &str) -> Result<Self> {
        crate::validate::fields(
            value,
            &[
                "requestId",
                "date",
                "station",
                "serviceAreaId",
                "provider",
                "timezone",
            ],
        )?;
        let scope = Self {
            date: s(value, "date").into(),
            station: s(value, "station").into(),
            service_area_id: s(value, "serviceAreaId").into(),
            provider: s(value, "provider").into(),
            timezone: if value.get("timezone").is_some() {
                crate::validate::timezone(value, "timezone")?
            } else {
                timezone.into()
            },
        };
        scope.validate()?;
        Ok(scope)
    }
    pub fn list_path(&self) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("navMenuVariant", "external")
            .append_pair("provider", &self.provider)
            .append_pair("selectedDay", &self.date)
            .append_pair("serviceAreaId", &self.service_area_id);
        format!("/operations/execution/itineraries?{}", query.finish())
    }
    pub fn detail_path(&self, id: &str) -> String {
        self.list_path().replacen(
            "/itineraries?",
            &format!(
                "/itineraries/{}/documentType/Itinerary?",
                url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
            ),
            1,
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Meal {
    pub id: String,
    pub start: i64,
    pub end: Option<i64>,
    pub last_delivery: Option<i64>,
    pub first_delivery: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Itinerary {
    pub id: String,
    pub transporter_id: String,
    pub driver: String,
    pub route: String,
    pub observed_at: i64,
    pub route_complete: bool,
    pub delivery_coverage: Coverage,
    pub meals: Vec<Meal>,
    /// The Cortex page this route was read from. Set by the collector, never by
    /// page content; captures from before links were retained carry none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    Complete,
    Unavailable,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub scope: Scope,
    pub started_at: i64,
    pub finished_at: i64,
    pub itineraries: Vec<Itinerary>,
}
impl Capture {
    pub fn validate(&self, expected: &Scope) -> Result<()> {
        expected.validate()?;
        ensure(&self.scope == expected, "cortex_scope_mismatch", 502)?;
        ensure(
            self.started_at > 0
                && self.started_at <= self.finished_at
                && self.finished_at <= now() + 60000
                && self.finished_at - self.started_at <= 1800000,
            "invalid_cortex_capture",
            502,
        )?;
        ensure(
            self.itineraries.len() <= 1000,
            "invalid_cortex_capture",
            502,
        )?;
        let date = NaiveDate::parse_from_str(&expected.date, "%Y-%m-%d").unwrap();
        let tz: chrono_tz::Tz = expected.timezone.parse().unwrap();
        let start = tz
            .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .ok_or_else(|| Error::new("invalid_date", 400))?
            .timestamp_millis();
        let end = start + 48 * 3600000;
        let valid_time =
            |time: i64| time >= start && time < end && time <= self.finished_at + 60000;
        let mut ids = HashSet::new();
        for route in &self.itineraries {
            ensure(
                token(&route.id)
                    && token(&route.transporter_id)
                    && label(&route.driver)
                    && label(&route.route)
                    && ids.insert(&route.id),
                "invalid_cortex_identity",
                502,
            )?;
            ensure(
                route.observed_at >= self.started_at
                    && route.observed_at <= self.finished_at
                    && route.meals.len() <= 16,
                "invalid_cortex_capture",
                502,
            )?;
            if let Some(url) = &route.source_url {
                ensure(
                    crate::validate::source_url(url).is_ok()
                        && url.ends_with(&expected.detail_path(&route.id)),
                    "invalid_cortex_capture",
                    502,
                )?;
            }
            let mut meal_ids = HashSet::new();
            let mut ordered = route.meals.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|meal| meal.start);
            for (index, meal) in ordered.iter().enumerate() {
                ensure(
                    token(&meal.id) && meal_ids.insert(&meal.id) && valid_time(meal.start),
                    "invalid_cortex_meal",
                    502,
                )?;
                if let Some(end) = meal.end {
                    ensure(
                        valid_time(end) && end >= meal.start && end - meal.start <= 12 * 3600000,
                        "invalid_cortex_meal",
                        502,
                    )?;
                }
                ensure(
                    meal.last_delivery
                        .is_none_or(|time| valid_time(time) && time <= meal.start)
                        && meal.first_delivery.is_none_or(|time| {
                            valid_time(time) && meal.end.is_some_and(|end| time >= end)
                        })
                        && (route.delivery_coverage == Coverage::Complete
                            || (meal.last_delivery.is_none() && meal.first_delivery.is_none())),
                    "invalid_cortex_delivery_boundary",
                    502,
                )?;
                if index > 0 {
                    ensure(
                        ordered[index - 1].end.is_some_and(|end| end <= meal.start),
                        "overlapping_cortex_meals",
                        502,
                    )?;
                }
            }
        }
        Ok(())
    }
}
struct Boundaries {
    prior: Option<i64>,
    next: Option<i64>,
    before: &'static str,
    after: &'static str,
}
fn boundaries(route: &Itinerary, meal: &Meal) -> Boundaries {
    if route.delivery_coverage != Coverage::Complete {
        return Boundaries {
            prior: None,
            next: None,
            before: "unavailable",
            after: if meal.end.is_none() {
                "pending"
            } else {
                "unavailable"
            },
        };
    }
    let prior = meal.last_delivery;
    let next = meal.first_delivery;
    Boundaries {
        prior,
        next,
        before: if prior.is_some() {
            "verified"
        } else {
            "absent"
        },
        after: if meal.end.is_none() {
            "pending"
        } else if next.is_some() {
            "verified"
        } else if route.route_complete {
            "absent"
        } else {
            "pending"
        },
    }
}
pub fn comparison_meal(route: &Itinerary, meal: &Meal) -> Value {
    let b = boundaries(route, meal);
    json!({"mealId":meal.id,"lastDelivery":b.prior.map(at),"start":at(meal.start),"end":meal.end.map(at),
        "firstDelivery":b.next.map(at),"beforeStatus":b.before,"afterStatus":b.after})
}
impl Store {
    pub fn publish_meals(
        &self,
        dsp: &str,
        job: &str,
        capture: &Capture,
        expected: &Scope,
    ) -> Result<Value> {
        capture.validate(expected)?;
        let db = self.collector(dsp, Provider::Cortex)?;
        db.transaction(|| {
            // Recovered workers may repeat publication after a crash between databases.
            if let Some(existing)=db.one("SELECT id FROM meal_publications WHERE job_id=?",[job])? {return Ok(existing);}
            let previous=db.one("SELECT id,collected_at FROM meal_publications WHERE \
                active=1 AND report_date=? AND station=? AND service_area_id=? AND \
                provider=?",params![expected.date,expected.station,expected.service_area_id,expected.provider])?;
            if let Some(previous)=&previous {
                ensure(s(previous,"collected_at")<=at(capture.finished_at).as_str(),"cortex_stale_capture",409)?;
                let ids:HashSet<_>=capture.itineraries.iter().map(|i|i.id.as_str()).collect();
                for route in db.all("SELECT itinerary_id FROM meal_itineraries WHERE publication_id=?",[s(previous,"id")])? {
                    ensure(ids.contains(s(&route,"itinerary_id")),"cortex_membership_regressed",409)?;
                }
            }
            let id=super::crypto::id("pub")?;
            let meals=capture.itineraries.iter().map(|r|r.meals.len()).sum::<usize>();
            let gaps=capture.itineraries.iter().flat_map(|r|r.meals.iter().map(move|m|boundaries(r,
                m))).filter(|b|b.prior.is_some()&&b.next.is_some()).count();
            db.exec("INSERT INTO \
                meal_publications(id,job_id,report_date,station,service_area_id,provider,timezone,started_at,\
                collected_at,itinerary_count,meal_count,verified_gap_count,adapter_version) VALUES (?,?,?,?,?,\
                ?,?,?,?,?,?,?,3)",params![id,job,expected.date,expected.station,
                expected.service_area_id,expected.provider,expected.timezone,
                at(capture.started_at),at(capture.finished_at),capture.itineraries.len() as i64,
                meals as i64,gaps as i64])?;
            for route in &capture.itineraries {
                let state=if route.meals.is_empty(){"none_recorded"}
                else if route.meals.iter().any(|m|m.end.is_none()){"in_progress"}else{"recorded"};

                db.exec("INSERT INTO meal_itineraries VALUES \
                    (?,?,?,?,?,?,?,?,?)",params![id,route.id,route.transporter_id,
                route.driver,route.route,at(route.observed_at),route.route_complete,
                if route.delivery_coverage==Coverage::Complete{"complete"}else{"unavailable"},
                state])?;
                if let Some(url)=&route.source_url {
                    db.exec("INSERT INTO meal_sources VALUES (?,?,?)",params![id,route.id,url])?;
                }
                for meal in &route.meals {
                    let b=boundaries(route,meal);
                    db.exec("INSERT INTO \
                        meal_records(publication_id,itinerary_id,meal_id,last_delivery_at,started_at,ended_at,\
                first_delivery_at,before_status,after_status) VALUES (?,?,?,?,?,?,?,?,?)",
                params![id,route.id,meal.id,b.prior.map(at),at(meal.start),
                meal.end.map(at),b.next.map(at),b.before,b.after])?;
                }
            }
            if let Some(previous)=previous {db.exec("UPDATE meal_publications SET active=0 WHERE id=?",[s(&previous,"id")])?;}
            db.exec("UPDATE meal_publications SET active=1 WHERE id=?",[&id])?;
            // Keep the active version and four prior accepted versions per scope.
            db.exec("DELETE FROM meal_publications WHERE active=0 AND report_date=? AND \
                station=? AND service_area_id=? AND provider=? AND id NOT IN (SELECT id FROM \
                meal_publications WHERE active=0 AND report_date=? AND station=? AND \
                service_area_id=? AND provider=? ORDER BY collected_at DESC,id DESC LIMIT \
                4)",params![expected.date,expected.station,expected.service_area_id,
                expected.provider,expected.date,expected.station,expected.service_area_id,
                expected.provider])?;
            Ok(json!({"id":id,"itineraries":capture.itineraries.len(),"meals":meals,"verifiedGapPairs":gaps}))
        })
    }
    pub fn meal_publications(&self, dsp: &str, date: &str) -> Result<Value> {
        ensure(
            NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok(),
            "invalid_date",
            400,
        )?;
        Ok(json!(self.collector(dsp, Provider::Cortex)?.all(
            "SELECT id,job_id \
            jobId,report_date date,station,service_area_id \
            serviceAreaId,provider,timezone,started_at startedAt,collected_at \
            collectedAt,itinerary_count itineraryCount,meal_count \
            mealCount,verified_gap_count verifiedGapPairs FROM meal_publications WHERE \
            report_date=? AND active=1 ORDER BY station,service_area_id,provider",
            [date]
        )?))
    }
}
// Used only by the explicitly configured synthetic provider mode.
pub fn fixture(scope: &Scope) -> Capture {
    let tz: chrono_tz::Tz = scope.timezone.parse().unwrap();
    let date = NaiveDate::parse_from_str(&scope.date, "%Y-%m-%d").unwrap();
    let start = tz
        .from_local_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp_millis();
    let observed = now();
    Capture {
        scope: scope.clone(),
        started_at: observed,
        finished_at: observed,
        itineraries: vec![Itinerary {
            id: "fixture-itinerary".into(),
            transporter_id: "fixture-driver".into(),
            driver: "Fixture Driver".into(),
            route: "CX1".into(),
            observed_at: observed,
            route_complete: true,
            delivery_coverage: Coverage::Complete,
            meals: vec![Meal {
                id: "meal-1".into(),
                start,
                end: Some(start + 1800000),
                last_delivery: Some(start - 300000),
                first_delivery: Some(start + 2100000),
            }],
            source_url: None,
        }],
    }
}
