//! Weekly scorecards from Cortex's performance API: the datasets behind each scorecard
//! page, one week at a time, published into the DSP's scorecard database. Every row
//! Amazon sends is kept as JSON beside the keys reads filter on. Browser and HTTP
//! data is untrusted input.
use crate::{
    Error, Result,
    collectors::{AddedStorage, Provider},
    contracts::{ScorecardDatasetCount, ScorecardPublication, ScorecardWeek, ScorecardWeeks},
    db::{Db, DspLease, Kind, Store, at, now, s},
    ensure,
};
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

pub const JOB_KIND: &str = "cortex.scorecard.collect";
pub const ADAPTER_VERSION: i64 = 1;
/// The scorecard database beside `cortex.sqlite`.
pub static STORAGE: AddedStorage = AddedStorage {
    id: "scorecard",
    kind: Kind::Scorecard,
    marker: "storage.scorecard",
    source: "scorecard-v1",
    verify,
};
/// How far back a schedule collects weeks it has never seen.
pub const BACKFILL_WEEKS: usize = 26;
/// How many recent weeks a schedule collects again, so dispute outcomes arrive.
pub const REFRESH_WEEKS: usize = 4;
pub const REFRESH_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// A week found not posted yet is asked for again this much later: daily for the
/// newest week, weekly for older ones Amazon may never post.
pub const RECHECK_NEWEST_AFTER_MS: i64 = 20 * 60 * 60 * 1000;
pub const RECHECK_OLDER_AFTER_MS: i64 = REFRESH_AFTER_MS;
/// Jobs one scheduled run queues at most; the queue admits five active per DSP.
pub const MAX_JOBS_PER_RUN: usize = 4;
/// Rows one dataset may hold, well above any week seen.
pub const MAX_ROWS: usize = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeFrame {
    Weekly,
    Daily,
}
impl TimeFrame {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Weekly => "Weekly",
            Self::Daily => "Daily",
        }
    }
}
/// One dataset of the performance API and the table that holds its rows.
pub struct Dataset {
    pub id: &'static str,
    pub table: &'static str,
    pub time_frame: TimeFrame,
    /// A `program` the page sends with the request.
    pub program: Option<&'static str>,
    /// The row field that says whether the row counts against the scorecard.
    pub impact: Option<&'static str>,
}
/// Every dataset a week's collection reads. The first six back the scorecard
/// pages' spreadsheets; the rest are the DSP's own weekly numbers.
pub const DATASETS: &[Dataset] = &[
    Dataset {
        id: "da_dsp_station_weekly_performance",
        table: "driver_scorecards",
        time_frame: TimeFrame::Weekly,
        program: Some("AMZL"),
        impact: None,
    },
    Dataset {
        id: "da_dsp_weekly_rts_deep_dive",
        table: "returns_to_station",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: Some("impacting_dcr"),
    },
    Dataset {
        id: "da_dsp_station_daily_dsb_dnr_tba",
        table: "delivery_concessions",
        time_frame: TimeFrame::Daily,
        program: None,
        impact: Some("dsb_flag"),
    },
    Dataset {
        id: "da_dsp_weekly_cdf_deep_dive",
        table: "customer_feedback",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: Some("cdf_impact_flag"),
    },
    Dataset {
        id: "da_dsp_daily_psb_stop",
        table: "pickup_failures",
        time_frame: TimeFrame::Daily,
        program: None,
        impact: None,
    },
    Dataset {
        id: "da_dsp_station_daily_safety_oss_events_intraday",
        table: "safety_events",
        time_frame: TimeFrame::Daily,
        program: None,
        impact: Some("oss_impact_flag"),
    },
    Dataset {
        id: "da_dsp_station_weekly_safety_oss_v2",
        table: "driver_safety",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_station_weekly_quality",
        table: "dsp_quality",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_station_weekly_team",
        table: "dsp_team",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_station_weekly_compliance",
        table: "dsp_compliance",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_station_weekly_safety_oss_v2",
        table: "dsp_safety",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_station_weekly_working_device",
        table: "dsp_working_device",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_weekly_cdf",
        table: "dsp_feedback",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
    Dataset {
        id: "dsp_weekly_psb",
        table: "dsp_pickups",
        time_frame: TimeFrame::Weekly,
        program: None,
        impact: None,
    },
];
/// The DSP's own scorecard row: a week without one is not posted yet.
pub const POSTED_SIGNAL: &str = "dsp_station_weekly_quality";
pub fn dataset(id: &str) -> Option<&'static Dataset> {
    DATASETS.iter().find(|d| d.id == id)
}
fn verify(db: &Db) -> Result<()> {
    ensure(
        db.all("SELECT version FROM scorecard_schema", [])? == vec![json!({"version":1})],
        "unsupported_scorecard_schema",
        503,
    )?;
    // Missing initialized tables fail closed, rather than recreating lost data.
    for table in ["scorecard_publications", "scorecard_weeks"]
        .into_iter()
        .chain(DATASETS.iter().map(|d| d.table))
    {
        db.one(&format!("SELECT count(*) FROM {table} WHERE 0"), [])?;
    }
    Ok(())
}

// Amazon's scorecard week runs Sunday to Saturday and is named after the ISO week
// of its Saturday: 2026-W38 is September 13 to 19, 2026.
pub fn parse_week(week: &str) -> Result<(i32, u32)> {
    let invalid = || Error::new("invalid_week", 400);
    let (year, number) = week.split_once("-W").ok_or_else(invalid)?;
    ensure(year.len() == 4 && number.len() == 2, "invalid_week", 400)?;
    let year: i32 = year.parse().map_err(|_| invalid())?;
    let number: u32 = number.parse().map_err(|_| invalid())?;
    ensure((2000..=2100).contains(&year), "invalid_week", 400)?;
    NaiveDate::from_isoywd_opt(year, number, Weekday::Sat).ok_or_else(invalid)?;
    Ok((year, number))
}
/// The week's first and last day: its Sunday and its Saturday.
pub fn week_days(week: &str) -> Result<(NaiveDate, NaiveDate)> {
    let (year, number) = parse_week(week)?;
    let saturday = NaiveDate::from_isoywd_opt(year, number, Weekday::Sat)
        .ok_or_else(|| Error::new("invalid_week", 400))?;
    Ok((saturday - Duration::days(6), saturday))
}
/// The week a Saturday ends.
fn week_of(saturday: NaiveDate) -> String {
    let iso = saturday.iso_week();
    format!("{}-W{:02}", iso.year(), iso.week())
}
/// The most recent week that ended before `today`.
pub fn last_completed_week(today: NaiveDate) -> String {
    let back = (today.weekday().num_days_from_sunday() + 1) % 7;
    let back = if back == 0 { 7 } else { back };
    week_of(today - Duration::days(i64::from(back)))
}
/// `week` and the `count` weeks before it, newest first.
pub fn weeks_before(week: &str, count: usize) -> Result<Vec<String>> {
    let (_, saturday) = week_days(week)?;
    Ok((0..=count)
        .map(|index| week_of(saturday - Duration::weeks(index as i64)))
        .collect())
}
/// `week` in the DSP's local calendar, or the last completed one.
pub fn week_or_latest(week: Option<&str>, today: NaiveDate) -> Result<String> {
    match week {
        Some(week) => {
            parse_week(week)?;
            ensure(
                week <= last_completed_week(today).as_str(),
                "week_not_completed",
                400,
            )?;
            Ok(week.to_owned())
        }
        None => Ok(last_completed_week(today)),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Collection {
    #[serde(rename = "scorecard")]
    Scorecard,
}
/// One week of one station's scorecard, as a job asks for it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub collection: Collection,
    pub week: String,
    pub station: String,
}
impl Request {
    /// Whether a job request or a collection names the scorecard collection.
    pub fn is(value: &Value) -> bool {
        value.get("collection") == Some(&json!("scorecard"))
    }
    pub fn parse(value: &Value) -> Result<Option<Self>> {
        if !Self::is(value) {
            return Ok(None);
        }
        let request: Self =
            serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_input", 400))?;
        request.validate()?;
        Ok(Some(request))
    }
    pub fn validate(&self) -> Result<()> {
        parse_week(&self.week)?;
        ensure(
            (3..=8).contains(&self.station.len())
                && self
                    .station
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            "invalid_station",
            400,
        )
    }
    /// The interval a dataset takes for this week.
    pub fn interval(&self, dataset: &Dataset) -> Result<(String, String)> {
        Ok(match dataset.time_frame {
            TimeFrame::Weekly => (self.week.clone(), self.week.clone()),
            TimeFrame::Daily => {
                let (first, last) = week_days(&self.week)?;
                (first.to_string(), last.to_string())
            }
        })
    }
}

/// One dataset's rows for the week, as objects, with the address they came from.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetCapture {
    pub id: String,
    pub from: String,
    pub to: String,
    pub source_url: String,
    pub rows: Vec<Value>,
}
/// A week's scorecard as collected, before publication.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub version: u32,
    pub collection: Collection,
    pub week: String,
    pub station: String,
    pub company_id: String,
    pub dsp_code: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub posted: bool,
    pub datasets: Vec<DatasetCapture>,
}
/// An identifier as the API and the page spell them.
pub fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
}
impl Capture {
    pub fn validate(&self, request: &Request) -> Result<()> {
        request.validate()?;
        ensure(self.version == 1, "scorecard_capture_invalid", 502)?;
        ensure(
            self.week == request.week && self.station == request.station,
            "scorecard_scope_mismatch",
            502,
        )?;
        ensure(
            token(&self.company_id, 128) && token(&self.dsp_code, 32),
            "scorecard_capture_invalid",
            502,
        )?;
        ensure(
            self.started_at > 0 && self.finished_at >= self.started_at,
            "scorecard_capture_invalid",
            502,
        )?;
        ensure(
            self.datasets.len() == DATASETS.len(),
            "scorecard_capture_invalid",
            502,
        )?;
        for (dataset, captured) in DATASETS.iter().zip(&self.datasets) {
            ensure(captured.id == dataset.id, "scorecard_capture_invalid", 502)?;
            let (from, to) = request.interval(dataset)?;
            ensure(
                captured.from == from && captured.to == to,
                "scorecard_scope_mismatch",
                502,
            )?;
            ensure(
                captured.rows.len() <= MAX_ROWS,
                "scorecard_source_too_large",
                502,
            )?;
            ensure(
                captured.source_url.len() <= 2048,
                "scorecard_capture_invalid",
                502,
            )?;
            ensure(
                captured.rows.iter().all(Value::is_object),
                "scorecard_row_invalid",
                502,
            )?;
        }
        let posted = self
            .datasets
            .iter()
            .find(|d| d.id == POSTED_SIGNAL)
            .is_some_and(|d| !d.rows.is_empty());
        ensure(posted == self.posted, "scorecard_capture_invalid", 502)
    }
    pub fn row_count(&self) -> usize {
        self.datasets.iter().map(|d| d.rows.len()).sum()
    }
}

/// What fixture mode collects: a small, complete week.
pub fn fixture(request: &Request) -> Result<Capture> {
    request.validate()?;
    let started_at = now();
    let (first, last) = week_days(&request.week)?;
    let drivers = ["driver-1", "driver-2", "driver-3"];
    let mut datasets = Vec::new();
    for dataset in DATASETS {
        let (from, to) = request.interval(dataset)?;
        let rows: Vec<Value> = match dataset.id {
            "da_dsp_station_weekly_performance" => drivers
                .iter()
                .enumerate()
                .map(|(i, driver)| {
                    json!({"transporter_id":driver,"da_name":format!("Fixture Driver {}", i + 1),"week":"38","year":2026,
                        "data_date":request.week,"station_code":request.station,"dsp_code":"FXTR",
                        "da_overall_score":90 - i as i64,"da_overall_tier":"Fantastic","delivered":1000 + i as i64,
                        "cdf_metric_dpmo":100 * i as i64,"dsb_metric_dpmo":0,"rts_metric_adjusted":0})
                })
                .collect(),
            "da_dsp_station_weekly_safety_oss_v2" => drivers
                .iter()
                .map(|driver| {
                    json!({"transporter_id":driver,"data_date":request.week,
                        "speeding_rate":0,"seatbelt_rate":0})
                })
                .collect(),
            "da_dsp_weekly_rts_deep_dive" => vec![
                json!({"transporter_id":"driver-1","tracking_id":"TBA000000000001",
                    "data_date":request.week,"delivery_planned_date":first.to_string(),
                    "impacting_dcr":"Y","rts_reason_code":"BUSINESS CLOSED","weekly_exemption":0}),
                json!({"transporter_id":"driver-2","tracking_id":"TBA000000000002",
                    "data_date":request.week,"delivery_planned_date":last.to_string(),
                    "impacting_dcr":"N","rts_reason_code":"CUSTOMER UNAVAILABLE","weekly_exemption":1}),
            ],
            "da_dsp_station_daily_dsb_dnr_tba" => vec![json!({"transporter_id":"driver-3",
                "tracking_id":"TBA000000000003","data_date":first.to_string(),"dsb_flag":1,
                "delivery_type":"Residential"})],
            "da_dsp_weekly_cdf_deep_dive" => vec![
                json!({"transporter_id":"driver-1","tracking_id":"TBA000000000004",
                    "data_date":request.week,"cdf_impact_flag":"Y","negative_feedback_flag":1,
                    "driver_was_unprofessional":1}),
                json!({"transporter_id":"driver-2","tracking_id":"TBA000000000005",
                    "data_date":request.week,"cdf_impact_flag":"N","negative_feedback_flag":0,
                    "delivered_with_care":1}),
            ],
            "da_dsp_daily_psb_stop" => vec![],
            "da_dsp_station_daily_safety_oss_events_intraday" => vec![json!({
                "transporter_id":"driver-3","event_id":"90000001","data_date":last.to_string(),
                "oss_impact_flag":1,"dashboard_metric_type":"Speeding"})],
            "dsp_station_weekly_quality" => vec![json!({"dsp_code":"FXTR",
                "station_code":request.station,"data_date":request.week,
                "dsp_final_score":88.5,"dsp_final_tier":"Great"})],
            "dsp_weekly_cdf" => vec![json!({"dsp_code":"FXTR","data_date":request.week,
                "positive_response_cnt":40,"negative_response_cnt":1,"no_feedback_cnt":900})],
            "dsp_weekly_psb" => vec![json!({"dsp_code":"FXTR","data_date":request.week,
                "total_stops":12,"failed_stops":0})],
            _ => vec![json!({"dsp_code":"FXTR","station_code":request.station,
                "data_date":request.week})],
        };
        datasets.push(DatasetCapture {
            id: dataset.id.into(),
            source_url: format!(
                "fixture://performance/api/v1/getData?dataSetId={}",
                dataset.id
            ),
            from,
            to,
            rows,
        });
    }
    let capture = Capture {
        version: 1,
        collection: Collection::Scorecard,
        week: request.week.clone(),
        station: request.station.clone(),
        company_id: "company-fixture".into(),
        dsp_code: "FXTR".into(),
        started_at,
        finished_at: now().max(started_at),
        posted: true,
        datasets,
    };
    capture.validate(request)?;
    Ok(capture)
}

/// The columns a row is indexed by, read from its fields when it has them.
struct Keys {
    data_date: Option<String>,
    transporter_id: Option<String>,
    tracking_id: Option<String>,
    event_id: Option<String>,
    impact: Option<i64>,
}
fn text(row: &Value, key: &str) -> Option<String> {
    match row.get(key)? {
        Value::String(value) if !value.is_empty() => Some(value.chars().take(256).collect()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}
fn keys(dataset: &Dataset, row: &Value) -> Keys {
    let impact = dataset.impact.and_then(|field| match row.get(field)? {
        Value::String(value) => match value.as_str() {
            "Y" | "y" | "true" | "TRUE" | "1" => Some(1),
            "N" | "n" | "false" | "FALSE" | "0" => Some(0),
            _ => None,
        },
        Value::Bool(value) => Some(i64::from(*value)),
        Value::Number(value) => value.as_i64().filter(|v| *v == 0 || *v == 1),
        _ => None,
    });
    Keys {
        data_date: text(row, "data_date"),
        transporter_id: text(row, "transporter_id"),
        tracking_id: text(row, "tracking_id"),
        event_id: text(row, "event_id"),
        impact,
    }
}

impl Store {
    pub fn scorecard(&self, id: &str) -> Result<DspLease<'_>> {
        self.added_storage(id, Provider::Cortex, &STORAGE)
    }
    /// Today, where the DSP is.
    fn scorecard_today(&self, id: &str) -> Result<NaiveDate> {
        let tz: chrono_tz::Tz = self
            .find_dsp(id)?
            .timezone
            .parse()
            .map_err(|_| Error::new("invalid_timezone", 400))?;
        Ok(chrono::Utc::now().with_timezone(&tz).date_naive())
    }
    /// The station the DSP's profile names, which every scorecard request carries.
    fn scorecard_station(&self, id: &str) -> Result<String> {
        let station = self.profile(id)?.station_code;
        ensure(!station.is_empty(), "scorecard_station_required", 409)?;
        Ok(station)
    }
    pub(crate) fn scorecard_request(&self, id: &str, week: &str) -> Result<Value> {
        let request = Request {
            collection: Collection::Scorecard,
            week: week.into(),
            station: self.scorecard_station(id)?,
        };
        request.validate()?;
        Ok(serde_json::to_value(request)?)
    }
    /// Queues `week`, or the most recent completed one, answering with the job.
    pub fn enqueue_scorecard(
        &self,
        id: &str,
        actor: Option<&str>,
        key: &str,
        week: Option<&str>,
    ) -> Result<Value> {
        let week = week_or_latest(week, self.scorecard_today(id)?)?;
        let request = self.scorecard_request(id, &week)?;
        let job = self
            .enqueue_batch(id, actor, &[(key.into(), Provider::Cortex, request)])?
            .remove(0);
        Ok(serde_json::to_value(job)?)
    }
    pub(crate) fn scorecard_schedule_ready(&self, id: &str) -> Result<()> {
        self.scorecard_station(id).map(|_| ())
    }
    /// The weeks a scheduled run collects: the newest completed week until it is
    /// posted, weeks never seen back to the backfill limit, and recent weeks
    /// collected long enough ago that disputes may have been decided.
    pub fn scorecard_jobs(&self, id: &str) -> Result<Vec<(String, Value)>> {
        let today = self.scorecard_today(id)?;
        let station = self.scorecard_station(id)?;
        let db = self.scorecard(id)?;
        let mut jobs = Vec::new();
        for (index, week) in weeks_before(&last_completed_week(today), BACKFILL_WEEKS)?
            .iter()
            .enumerate()
        {
            let state = db.one(
                "SELECT checked_at,posted FROM scorecard_weeks WHERE week=? AND station=?",
                [week, &station],
            )?;
            let publication = db.one(
                "SELECT collected_at FROM scorecard_publications WHERE week=? AND station=? AND active=1",
                [week, &station],
            )?;
            let age = |value: &Value, key: &str| {
                chrono::DateTime::parse_from_rfc3339(s(value, key))
                    .map(|at| now() - at.timestamp_millis())
                    .unwrap_or(i64::MAX)
            };
            let due = match (&state, &publication) {
                (_, Some(publication)) => {
                    index < REFRESH_WEEKS && age(publication, "collected_at") >= REFRESH_AFTER_MS
                }
                (Some(state), None) => {
                    age(state, "checked_at")
                        >= if index == 0 {
                            RECHECK_NEWEST_AFTER_MS
                        } else {
                            RECHECK_OLDER_AFTER_MS
                        }
                }
                (None, None) => true,
            };
            if due {
                jobs.push((
                    format!("scorecard:{week}"),
                    self.scorecard_request(id, week)?,
                ));
                if jobs.len() >= MAX_JOBS_PER_RUN {
                    break;
                }
            }
        }
        Ok(jobs)
    }
    /// Stores a week's capture as its active publication, or records that the week
    /// is not posted yet. One transaction: a reader never sees part of a week.
    pub fn publish_scorecard(&self, id: &str, job: &str, capture: &Capture) -> Result<()> {
        let request: Value = serde_json::from_str(&self.job_row(job, Some(id))?.request)?;
        let request = Request::parse(&request)?.ok_or_else(|| Error::new("invalid_input", 400))?;
        capture.validate(&request)?;
        let db = self.scorecard(id)?;
        let checked_at = at(capture.finished_at);
        db.transaction(|| {
            if !capture.posted {
                // A week published before stays published; only the check is noted.
                db.exec(
                    "INSERT INTO scorecard_weeks(week,station,checked_at,posted,publication_id) \
                     VALUES (?,?,?,0,NULL) ON CONFLICT(week,station) DO UPDATE SET \
                     checked_at=excluded.checked_at",
                    params![capture.week, capture.station, checked_at],
                )?;
                return Ok(());
            }
            let publication = crate::crypto::id("scorecard")?;
            db.exec(
                "INSERT INTO scorecard_publications(id,job_id,week,station,company_id,dsp_code,started_at,\
                 collected_at,active,row_count,adapter_version) VALUES (?,?,?,?,?,?,?,?,0,?,?)",
                params![
                    publication,
                    job,
                    capture.week,
                    capture.station,
                    capture.company_id,
                    capture.dsp_code,
                    at(capture.started_at),
                    checked_at,
                    capture.row_count() as i64,
                    ADAPTER_VERSION
                ],
            )?;
            for (dataset, captured) in DATASETS.iter().zip(&capture.datasets) {
                let sql = format!(
                    "INSERT INTO {}(publication_id,row_index,week,data_date,transporter_id,tracking_id,\
                     event_id,impact,row) VALUES (?,?,?,?,?,?,?,?,?)",
                    dataset.table
                );
                for (index, row) in captured.rows.iter().enumerate() {
                    let keys = keys(dataset, row);
                    db.exec(
                        &sql,
                        params![
                            publication,
                            index as i64,
                            capture.week,
                            keys.data_date,
                            keys.transporter_id,
                            keys.tracking_id,
                            keys.event_id,
                            keys.impact,
                            row.to_string()
                        ],
                    )?;
                }
            }
            db.exec(
                "UPDATE scorecard_publications SET active=0 WHERE week=? AND station=? AND company_id=? AND active=1",
                params![capture.week, capture.station, capture.company_id],
            )?;
            db.exec(
                "UPDATE scorecard_publications SET active=1 WHERE id=?",
                [&publication],
            )?;
            db.exec(
                "INSERT INTO scorecard_weeks(week,station,checked_at,posted,publication_id) \
                 VALUES (?,?,?,1,?) ON CONFLICT(week,station) DO UPDATE SET \
                 checked_at=excluded.checked_at,posted=1,publication_id=excluded.publication_id",
                params![capture.week, capture.station, checked_at, publication],
            )?;
            Ok(())
        })
    }
    /// Every week checked so far at the DSP's station, newest first, with its
    /// active publication and how many rows each table holds for it.
    pub fn scorecard_weeks(&self, id: &str) -> Result<ScorecardWeeks> {
        let today = self.scorecard_today(id)?;
        let station = self.profile(id)?.station_code;
        let db = self.scorecard(id)?;
        // Row counts by publication, one query per table.
        let mut counts: HashMap<String, Vec<ScorecardDatasetCount>> = HashMap::new();
        for dataset in DATASETS {
            for row in db.all(
                &format!(
                    "SELECT publication_id,count(*) rows FROM {} GROUP BY publication_id",
                    dataset.table
                ),
                [],
            )? {
                counts
                    .entry(s(&row, "publication_id").to_owned())
                    .or_default()
                    .push(ScorecardDatasetCount {
                        id: dataset.id.into(),
                        table: dataset.table.into(),
                        rows: row["rows"].as_i64().unwrap_or(0) as usize,
                    });
            }
        }
        let mut weeks = Vec::new();
        for state in db.all(
            "SELECT w.week,w.checked_at,w.posted,p.id,p.station,p.dsp_code,p.collected_at,p.row_count \
             FROM scorecard_weeks w LEFT JOIN scorecard_publications p \
             ON p.week=w.week AND p.station=w.station AND p.active=1 \
             WHERE w.station=? ORDER BY w.week DESC",
            [&station],
        )? {
            let publication = state["id"].as_str().map(|publication| {
                let mut datasets: Vec<ScorecardDatasetCount> = DATASETS
                    .iter()
                    .map(|dataset| ScorecardDatasetCount {
                        id: dataset.id.into(),
                        table: dataset.table.into(),
                        rows: 0,
                    })
                    .collect();
                for counted in counts.get(publication).into_iter().flatten() {
                    if let Some(dataset) = datasets.iter_mut().find(|d| d.id == counted.id) {
                        dataset.rows = counted.rows;
                    }
                }
                ScorecardPublication {
                    id: publication.into(),
                    week: s(&state, "week").into(),
                    station: s(&state, "station").into(),
                    dsp_code: s(&state, "dsp_code").into(),
                    collected_at: s(&state, "collected_at").into(),
                    row_count: state["row_count"].as_i64().unwrap_or(0) as usize,
                    datasets,
                }
            });
            weeks.push(ScorecardWeek {
                week: s(&state, "week").into(),
                posted: state["posted"] == 1,
                checked_at: s(&state, "checked_at").into(),
                publication,
            });
        }
        Ok(ScorecardWeeks {
            station,
            latest_week: last_completed_week(today),
            weeks,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }
    #[test]
    fn weeks_run_sunday_to_saturday_and_are_named_after_the_saturday() {
        assert_eq!(
            week_days("2026-W38").unwrap(),
            (date("2026-09-13"), date("2026-09-19"))
        );
        assert_eq!(week_of(date("2026-09-19")), "2026-W38");
        // Every day of the following week still sees week 38 as the last completed one.
        for day in ["2026-09-20", "2026-09-23", "2026-09-26"] {
            assert_eq!(last_completed_week(date(day)), "2026-W38", "{day}");
        }
        assert_eq!(last_completed_week(date("2026-09-27")), "2026-W39");
        assert_eq!(
            weeks_before("2026-W02", 3).unwrap(),
            ["2026-W02", "2026-W01", "2025-W52", "2025-W51"]
        );
        for invalid in ["2026-W00", "2026-W54", "2026-38", "26-W38", "2026-W3"] {
            assert!(parse_week(invalid).is_err(), "{invalid}");
        }
        assert!(week_or_latest(Some("2026-W39"), date("2026-09-25")).is_err());
        assert_eq!(
            week_or_latest(None, date("2026-09-25")).unwrap(),
            "2026-W38"
        );
    }
    #[test]
    fn requests_are_recognized_by_their_collection() {
        assert!(
            Request::parse(&json!({"date":"2026-09-13"}))
                .unwrap()
                .is_none()
        );
        let request =
            Request::parse(&json!({"collection":"scorecard","week":"2026-W38","station":"DOT4"}))
                .unwrap()
                .unwrap();
        assert_eq!(
            request
                .interval(dataset("da_dsp_daily_psb_stop").unwrap())
                .unwrap()
                .0,
            "2026-09-13"
        );
        assert!(
            Request::parse(&json!({"collection":"scorecard","week":"2026-W38","station":"dot4"}))
                .is_err()
        );
        assert!(
            Request::parse(
                &json!({"collection":"scorecard","week":"2026-W38","station":"DOT4","extra":1})
            )
            .is_err()
        );
    }
    #[test]
    fn the_fixture_is_a_valid_posted_week_and_its_keys_are_read_from_rows() {
        let request =
            Request::parse(&json!({"collection":"scorecard","week":"2026-W38","station":"DOT4"}))
                .unwrap()
                .unwrap();
        let capture = fixture(&request).unwrap();
        assert!(capture.posted);
        assert_eq!(capture.datasets.len(), DATASETS.len());
        let returns = dataset("da_dsp_weekly_rts_deep_dive").unwrap();
        let rows = &capture
            .datasets
            .iter()
            .find(|d| d.id == returns.id)
            .unwrap()
            .rows;
        let first = keys(returns, &rows[0]);
        assert_eq!(first.impact, Some(1));
        assert_eq!(first.tracking_id.as_deref(), Some("TBA000000000001"));
        assert_eq!(keys(returns, &rows[1]).impact, Some(0));
        let concessions = dataset("da_dsp_station_daily_dsb_dnr_tba").unwrap();
        let rows = &capture
            .datasets
            .iter()
            .find(|d| d.id == concessions.id)
            .unwrap()
            .rows;
        assert_eq!(keys(concessions, &rows[0]).impact, Some(1));
        assert_eq!(
            keys(concessions, &rows[0]).data_date.as_deref(),
            Some("2026-09-13")
        );
        let mut other = capture.clone();
        other.posted = false;
        assert!(other.validate(&request).is_err());
    }
}
