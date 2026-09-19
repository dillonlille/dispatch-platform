use super::*;
use crate::{collection_checkpoint::Checkpoint, job_metrics::Recorder};
use chrono::{Datelike, NaiveDate};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    future::Future,
    sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
};
const API: &str = "https://time-and-attendance.paycomonline.net/api/cl/timecard-search/employees";
const FIELDS: &[&str] = &[
    "allocationCategories",
    "approvalMode",
    "eeCodes",
    "endDate",
    "getCount",
    "highlighting",
    "isAdvancedFilterApplied",
    "loadTotals",
    "minWageUrl",
    "onlyBorrowedEmployees",
    "payClassCodes",
    "q",
    "selectedColumns",
    "selectedEarnings",
    "skip",
    "sortParams",
    "startDate",
    "take",
];
fn valid(ok: bool) -> Result<()> {
    ensure(ok, "roster_not_complete", 409)
}
fn codes(value: &Value) -> Result<BTreeSet<String>> {
    let values = value
        .as_array()
        .ok_or_else(|| Error::new("roster_not_complete", 409))?;
    valid(!values.is_empty() && values.len() <= 5000)?;
    let mut codes = BTreeSet::new();
    for value in values {
        let code = value.as_str().unwrap_or("");
        valid(
            code.len() == 4
                && code.bytes().all(|b| b.is_ascii_alphanumeric())
                && codes.insert(code.to_ascii_uppercase()),
        )?;
    }
    Ok(codes)
}
fn date(value: &str) -> Result<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| Error::new("invalid_period", 409))?;
    ensure(parsed.to_string() == value, "invalid_period", 409)?;
    Ok(parsed)
}
fn selected_body(body: &Value, today: NaiveDate) -> Result<(Value, Value, BTreeSet<String>)> {
    let object = body
        .as_object()
        .ok_or_else(|| Error::new("roster_not_complete", 409))?;
    valid(object.len() == FIELDS.len() && FIELDS.iter().all(|key| object.contains_key(*key)))?;
    let codes = codes(&body["eeCodes"])?;
    valid(
        body["isAdvancedFilterApplied"].is_boolean()
            && (body["q"].is_null() || body["q"] == "")
            && body["onlyBorrowedEmployees"] == false
            && (body["skip"].is_null() || body["skip"] == 0)
            && (body["take"].is_null()
                || body["take"]
                    .as_u64()
                    .is_some_and(|n| n >= codes.len() as u64))
            && (body["getCount"].is_null() || body["getCount"] == true),
    )?;
    let start = date(s(body, "startDate"))?;
    let end = date(s(body, "endDate"))?;
    ensure(
        start.weekday() == chrono::Weekday::Sun
            && end.weekday() == chrono::Weekday::Sat
            && (end - start).num_days() == 13,
        "invalid_period",
        409,
    )?;
    let offset = (today - start).num_days().div_euclid(14) * 14;
    let start = start
        .checked_add_signed(chrono::Duration::days(offset))
        .ok_or_else(|| Error::new("invalid_period", 409))?;
    let dates = (0..14)
        .map(|i| (start + chrono::Duration::days(i)).to_string())
        .collect::<Vec<_>>();
    let period = json!({"start":dates[0],"end":dates[13],"key":format!("{}_{}",dates[0],dates[13]),"dates":dates});
    let mut selected = body.clone();
    selected["startDate"] = period["start"].clone();
    selected["endDate"] = period["end"].clone();
    selected["isAdvancedFilterApplied"] = json!(false);
    selected["selectedEarnings"] = json!([]);
    selected["approvalMode"] = Value::Null;
    Ok((selected, period, codes))
}
fn employees(raw: &Value, expected: &BTreeSet<String>) -> Result<Vec<Value>> {
    valid(codes(&raw["eeCodes"])? == *expected)?;
    let rows = raw["employees"]
        .as_array()
        .ok_or_else(|| Error::new("roster_not_complete", 409))?;
    valid(rows.len() == expected.len())?;
    let mut seen = BTreeSet::new();
    let mut employees = Vec::new();
    for row in rows {
        let code = s(row, "employeeCode");
        valid(
            expected.contains(&code.to_ascii_uppercase())
                && seen.insert(code.to_ascii_uppercase())
                && !s(row, "fullName").trim().is_empty()
                && row["eestatus"] == "A",
        )?;
        let selections = row["allocation"]["selections"]
            .as_array()
            .ok_or_else(|| Error::new("roster_not_complete", 409))?;
        valid(selections.len() == 2)?;
        let department = selections
            .iter()
            .find(|v| v["categoryName"] == "Department")
            .ok_or_else(|| Error::new("roster_not_complete", 409))?;
        let station = selections
            .iter()
            .find(|v| v["categoryName"] == "Delivery Station Code")
            .ok_or_else(|| Error::new("roster_not_complete", 409))?;
        valid(department["isDepartment"] == true && station["isDepartment"] == false)?;
        for item in [department, station] {
            valid(item["code"].is_string() && item["description"].is_string())?;
        }
        for key in [
            "position",
            "payClassCode",
            "terminalCode",
            "payType",
            "primarySupervisor",
        ] {
            valid(row[key].is_string())?;
        }
        valid(row["missingPunches"].is_i64())?;
        for number in [
            &row["totals"]["totalHours"],
            &row["totals"]["otHours"],
            &row["approvalPercentages"]["employee"],
            &row["approvalPercentages"]["supervisor"],
        ] {
            valid(number.as_f64().is_some_and(f64::is_finite))?;
        }
        employees.push(json!({"code":code,"name":row["fullName"],"department":department["description"],"position":row["position"],"station":station["code"],"active":true}));
    }
    Ok(employees)
}
fn hours(value: &Value) -> Option<f64> {
    value["totalHours"]
        .as_f64()
        .or_else(|| value["hours"].as_f64())
}
pub(super) fn project(record: &Value, employee: &str) -> Result<Vec<Value>> {
    let error = || Error::new("invalid_timecard_hours", 409);
    let days = record["days"].as_array().ok_or_else(error)?;
    let additional = record["additionalRows"].as_array().ok_or_else(error)?;
    ensure(
        days.len() == 14 && additional.len() <= 200,
        "invalid_timecard_hours",
        409,
    )?;
    let base = days
        .iter()
        .map(|day| {
            hours(day)
                .or_else(|| {
                    // DOM extraction folds all pay-code punches into the day.
                    // Only row zero determines whether the leading row is empty;
                    // additional rows contribute their own reported hours below.
                    let no_missing_leading = day["missingPunch"] == false
                        || day["unresolvedSlots"].as_array().is_some_and(|slots| {
                            !slots.is_empty()
                                && slots.iter().all(|slot| {
                                    slot.as_str().is_some_and(|slot| slot.contains(':'))
                                })
                        });
                    if no_missing_leading
                        && day["punches"].as_array().is_some_and(|punches| {
                            punches
                                .iter()
                                .all(|punch| punch["rowIndex"].as_u64().is_some_and(|row| row > 0))
                        })
                    {
                        Some(0.)
                    } else {
                        None
                    }
                })
                .ok_or_else(error)
        })
        .collect::<Result<Vec<_>>>()?;
    let rows = days
        .iter()
        .enumerate()
        .map(|(index, day)| {
            base[index]
                + additional
                    .iter()
                    .filter(|r| r["date"] == day["date"])
                    .map(|r| hours(r).unwrap_or(0.))
                    .sum::<f64>()
        })
        .collect::<Vec<_>>();
    let reported = days
        .iter()
        .enumerate()
        .map(|(index, day)| {
            let totals = std::iter::once(day)
                .chain(additional.iter().filter(|r| r["date"] == day["date"]))
                .filter_map(|r| r["totalHours"].as_f64())
                .collect::<Vec<_>>();
            if totals.is_empty() {
                rows[index]
            } else {
                totals.iter().sum()
            }
        })
        .collect::<Vec<_>>();
    let matches = |values: &[f64]| {
        values.iter().all(|v| v.is_finite() && *v >= 0.)
            && record["weeklyTotals"].as_array().is_some_and(|totals| {
                totals.len() == 2
                    && totals.iter().enumerate().all(|(i, t)| {
                        t.as_f64().is_some_and(|v| {
                            (values[i * 7..i * 7 + 7].iter().sum::<f64>() - v).abs() < 0.011
                        })
                    })
            })
            && record["periodTotalHours"]
                .as_f64()
                .is_some_and(|v| (values.iter().sum::<f64>() - v).abs() < 0.011)
    };
    let values = [rows, base, reported]
        .into_iter()
        .find(|h| matches(h))
        .ok_or_else(|| Error::new("provider_hours_mismatch", 409))?;
    days.iter().enumerate().map(|(index,day)|{
        let mut punches=Vec::new(); let mut pending=Value::Null; let mut pending_kind=Value::Null; let mut row=Value::Null;
        for punch in day["punches"].as_array().ok_or_else(error)? {
            if row!=punch["rowIndex"] && !pending.is_null() {
                punches.push(json!({"in":pending,"out":null,"hours":null,"inKind":pending_kind,"outKind":null}));
                pending=Value::Null; pending_kind=Value::Null;
            }
            row=punch["rowIndex"].clone();
            let kind = if s(punch,"kind").is_empty() {Value::Null} else {punch["kind"].clone()};
            if s(punch,"slot").starts_with('i') {
                if !pending.is_null() {punches.push(json!({"in":pending,"out":null,"hours":null,"inKind":pending_kind,"outKind":null}));}
                pending=punch["displayTime"].clone(); pending_kind=kind;
            } else {
                punches.push(json!({"in":pending,"out":punch["displayTime"],"hours":null,"inKind":pending_kind,"outKind":kind}));
                pending=Value::Null; pending_kind=Value::Null;
            }
        }
        if !pending.is_null(){punches.push(json!({"in":pending,"out":null,"hours":null,"inKind":pending_kind,"outKind":null}));}
        Ok(json!({"employeeCode":employee,"date":day["date"],"hours":(values[index]*100.).round()/100.,"status":if day["missingPunch"]==true{"Missing punch"}else if punches.is_empty(){"No punches"}else{"Complete"},"punches":punches}))
    }).collect()
}
impl Driver {
    pub async fn collect<F, Fut>(
        &mut self,
        timezone: &str,
        selected_date: Option<NaiveDate>,
        metrics: &Recorder,
        checkpoint: Option<&Checkpoint>,
        mut progress: F,
    ) -> Result<Value>
    where
        F: FnMut(i64, String) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.credentials = Value::Null;
        self.assistance = None;
        progress(10, "Reading employee roster".into()).await?;
        self.new_page().await?;
        let api = if self.fixture {
            format!("{}/api/cl/timecard-search/employees", self.origin)
        } else {
            API.into()
        };
        self.command(
            "Fetch.enable",
            json!({"patterns":[{"urlPattern":api,"requestStage":"Request"}]}),
        )
        .await?;
        self.navigate(SEARCH).await?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let observed = loop {
            ensure(Instant::now() < deadline, "provider_timeout", 504)?;
            let event = self.browser.event(&self.page.id).await?;
            if event.is_null() {
                continue;
            }
            self.command(
                "Fetch.continueRequest",
                json!({"requestId":event["requestId"]}),
            )
            .await?;
            if event["request"]["url"] == api && event["request"]["method"] == "POST" {
                break event["request"].clone();
            }
        };
        self.command("Fetch.disable", json!({})).await?;
        let zone: chrono_tz::Tz = timezone
            .parse()
            .map_err(|_| Error::new("invalid_timezone", 400))?;
        let body: Value = serde_json::from_str(s(&observed, "postData"))
            .map_err(|_| Error::new("roster_not_complete", 409))?;
        let (body, period, codes) = selected_body(
            &body,
            selected_date.unwrap_or_else(|| chrono::Utc::now().with_timezone(&zone).date_naive()),
        )?;
        let mut headers = serde_json::Map::new();
        if let Some(values) = observed["headers"].as_object() {
            for (key, value) in values {
                if [
                    "accept",
                    "authorization",
                    "content-type",
                    "x-xsrf-token",
                    "x-csrf-token",
                    "x-requested-with",
                ]
                .contains(&key.to_ascii_lowercase().as_str())
                {
                    headers.insert(key.clone(), value.clone());
                }
            }
        }
        let input = json!({"url":api,"body":body.to_string(),"headers":headers});
        // Start a bounded fetch in the isolated world, then poll. No command holds
        // the browser transport for a network-length timeout.
        self.evaluate(&format!(r#"(()=>{{globalThis.dispatchRoster=null;(async input=>{{try{{
            const response=await fetch(input.url,{{method:'POST',credentials:'include',redirect:'error',cache:'no-store',headers:input.headers,body:input.body,signal:AbortSignal.timeout(55000)}});
            if(response.status!==200||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||'')||!response.body)throw 0;
            const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{{fatal:true}});let size=0,text='';
            for(;;){{const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2097152){{await reader.cancel();throw 0;}}text+=decoder.decode(part.value,{{stream:true}});}}
            text+=decoder.decode();globalThis.dispatchRoster={{ok:true,value:JSON.parse(text)}};
        }}catch{{globalThis.dispatchRoster={{ok:false}};}}}})({input});return true;}})()"#)).await?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let raw = loop {
            ensure(Instant::now() < deadline, "provider_timeout", 504)?;
            let value = self.evaluate("globalThis.dispatchRoster").await?;
            if !value.is_null() {
                ensure(value["ok"] == true, "provider_unavailable", 502)?;
                break value["value"].clone();
            }
            sleep(Duration::from_millis(200)).await;
        };
        self.evaluate("delete globalThis.dispatchRoster").await?;
        let employees = employees(&raw, &codes)?;
        let resume = if let Some(checkpoint) = checkpoint {
            Some(checkpoint.prepare(&period, &employees, timezone).await?)
        } else {
            None
        };
        let (token, mut pages) = resume.map(|r| (r.token, r.pages)).unwrap_or_default();
        metrics.resumed(pages.len());
        let todo = employees
            .iter()
            .enumerate()
            .filter_map(|(index, employee)| {
                (!pages.contains_key(s(employee, "code"))).then_some(index)
            })
            .collect::<Vec<_>>();
        let mut second = if todo.len() > 1 {
            Some(Page::open(self.browser.clone(), self.origin.clone()).await?)
        } else {
            None
        };
        let direct = Direct::new(&todo);
        let queue = Queue {
            employees: &employees,
            todo,
            next: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            progress: tokio::sync::Mutex::new((pages.len(), progress)),
            origin: &self.origin,
            period: &period,
            metrics,
            checkpoint,
            token: &token,
            direct,
        };
        // Drain both lanes even when one fails. Dropping a sibling's in-flight
        // CDP command intentionally closes the shared browser transport.
        let (first, second) = tokio::join!(queue.lane(&mut self.page), async {
            if let Some(page) = &mut second {
                queue.lane(page).await
            } else {
                Ok(BTreeMap::new())
            }
        });
        pages.extend(first?);
        pages.extend(second?);
        let timecards = employees
            .iter()
            .flat_map(|employee| pages.remove(s(employee, "code")).unwrap_or_default())
            .collect::<Vec<_>>();
        ensure(
            timecards.len() == employees.len() * 14,
            "roster_not_complete",
            409,
        )?;
        let sources = employees
            .iter()
            .map(|employee| json!({"employeeCode":employee["code"],"periodKey":period["key"],"url":source_url(&self.origin, employee, &period)}))
            .collect::<Vec<_>>();
        Ok(
            json!({"employees":employees,"timecards":timecards,"sources":sources,"from":period["start"],"to":period["end"],"collectedAt":db::iso()}),
        )
    }
}

struct Queue<'a, F> {
    employees: &'a [Value],
    todo: Vec<usize>,
    next: AtomicUsize,
    stopped: AtomicBool,
    progress: tokio::sync::Mutex<(usize, F)>,
    origin: &'a str,
    period: &'a Value,
    metrics: &'a Recorder,
    checkpoint: Option<&'a Checkpoint>,
    token: &'a str,
    direct: Direct,
}
impl<F, Fut> Queue<'_, F>
where
    F: FnMut(i64, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    async fn lane(&self, page: &mut Page) -> Result<BTreeMap<String, Vec<Value>>> {
        let result = self.read_queue(page).await;
        if result.is_err() {
            self.stopped.store(true, Ordering::SeqCst);
        }
        result
    }
    async fn read_queue(&self, page: &mut Page) -> Result<BTreeMap<String, Vec<Value>>> {
        let mut pages = BTreeMap::new();
        while !self.stopped.load(Ordering::SeqCst) {
            let Some(&index) = self.todo.get(self.next.fetch_add(1, Ordering::SeqCst)) else {
                break;
            };
            let employee = &self.employees[index];
            let records = read_timecard(
                page,
                self.origin,
                employee,
                self.period,
                self.metrics,
                index + 1,
                &self.direct,
            )
            .await?;
            if let Some(checkpoint) = self.checkpoint {
                checkpoint
                    .save(self.token, employee, self.period, &records)
                    .await?;
            }
            pages.insert(s(employee, "code").to_owned(), records);
            page.collect_garbage().await?;
            let mut progress = self.progress.lock().await;
            progress.0 += 1;
            let done = progress.0;
            (progress.1)(
                20 + (done * 70 / self.employees.len()) as i64,
                format!("Reading timecards ({done} of {})", self.employees.len()),
            )
            .await?;
        }
        Ok(pages)
    }
}

/// Whether this job may read timecards from responses. A page can fill or change
/// its table after loading, which a response would miss while still validating, so
/// each job first requires a response to equal a rendered read that has punches.
/// One disagreement keeps the whole job on rendered reads.
///
/// That proves one employee. A few more, chosen at random in each job, are also
/// rendered after their response is read, so a difference limited to some
/// employees cannot be published for long without failing a collection.
struct Direct {
    state: AtomicU8,
    sample: HashSet<usize>,
}
impl Direct {
    const ENABLED: u8 = 1;
    const DISABLED: u8 = 2;
    const VERIFYING: u8 = 3;
    const SAMPLE: usize = 4;
    /// `todo` holds employee indexes in reading order. The first two are rendered
    /// before any response is trusted, and a short roster gains little from
    /// responses, so neither is sampled.
    fn new(todo: &[usize]) -> Self {
        let mut sample = HashSet::new();
        let later = todo.get(2..).unwrap_or_default();
        if todo.len() >= 20 {
            let mut random = [0u8; 8 * Self::SAMPLE * 4];
            // Without entropy the first later employees are checked instead.
            let drawn = getrandom::fill(&mut random).is_ok();
            for (index, bytes) in random.chunks_exact(8).enumerate() {
                if sample.len() == Self::SAMPLE {
                    break;
                }
                let position = if drawn {
                    u64::from_le_bytes(bytes.try_into().expect("eight bytes")) as usize
                } else {
                    index
                };
                sample.insert(later[position % later.len()] + 1);
            }
        }
        Self {
            state: AtomicU8::new(0),
            sample,
        }
    }
    fn enabled(&self) -> bool {
        self.state.load(Ordering::SeqCst) == Self::ENABLED
    }
    async fn verify(
        &self,
        page: &Page,
        origin: &str,
        employee: &Value,
        period: &Value,
        rendered: &[Value],
    ) -> Result<()> {
        let punched = rendered
            .iter()
            .any(|card| card["punches"].as_array().is_some_and(|p| !p.is_empty()));
        // One lane verifies; the other keeps rendering until the result is known.
        if !punched
            || self
                .state
                .compare_exchange(0, Self::VERIFYING, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return Ok(());
        }
        let response = read_response(page, origin, employee, period, true).await;
        self.state.store(
            if response
                .as_ref()
                .is_ok_and(|r| r.as_deref() == Some(rendered))
            {
                Self::ENABLED
            } else {
                Self::DISABLED
            },
            Ordering::SeqCst,
        );
        response.map(|_| ())
    }
}
async fn read_timecard(
    page: &mut Page,
    origin: &str,
    employee: &Value,
    period: &Value,
    metrics: &Recorder,
    ordinal: usize,
    direct: &Direct,
) -> Result<Vec<Value>> {
    // The provider's response already holds the whole timecard, so once this job
    // has proven that, read it without rendering. Anything a response cannot fully
    // validate still falls through to a rendered read.
    if direct.enabled() {
        metrics.page_start(ordinal, 1);
        match read_response(page, origin, employee, period, false).await {
            Ok(Some(records)) => {
                metrics.page_stage(ordinal, "extraction");
                metrics.direct();
                metrics.page_finish(ordinal, None);
                if !direct.sample.contains(&ordinal) {
                    return Ok(records);
                }
                let rendered =
                    read_rendered(page, origin, employee, period, metrics, ordinal, true).await?;
                // A punch can land between the two reads; only a response that
                // still disagrees with the rendered page is a provider mismatch.
                let agrees = rendered == records
                    || read_response(page, origin, employee, period, true)
                        .await?
                        .is_some_and(|again| again == rendered);
                ensure(agrees, "provider_response_mismatch", 502)?;
                metrics.spot_checked();
                return Ok(rendered);
            }
            Ok(None) => metrics.page_cancel(ordinal),
            Err(error) => {
                metrics.page_finish(ordinal, Some(&error.code));
                return Err(error);
            }
        }
    }
    let records = read_rendered(page, origin, employee, period, metrics, ordinal, false).await?;
    direct
        .verify(page, origin, employee, period, &records)
        .await?;
    Ok(records)
}
/// A rendered read with its one local retry. A verification read re-reads an
/// employee that already counts as completed, so only its failures are recorded.
async fn read_rendered(
    page: &mut Page,
    origin: &str,
    employee: &Value,
    period: &Value,
    metrics: &Recorder,
    ordinal: usize,
    verification: bool,
) -> Result<Vec<Value>> {
    for attempt in 1..=2 {
        metrics.page_start(ordinal, attempt);
        let result = read_once(
            page,
            origin,
            employee,
            period,
            metrics,
            ordinal,
            verification,
        )
        .await;
        if verification && result.is_ok() {
            metrics.page_cancel(ordinal);
        } else {
            metrics.page_finish(
                ordinal,
                result.as_ref().err().map(|error| error.code.as_str()),
            );
        }
        let retry = result.as_ref().err().is_some_and(|error| {
            [
                "provider_navigation_timeout",
                "provider_content_timeout",
                "provider_content_missing",
                "browser_navigation_pending",
            ]
            .contains(&error.code.as_str())
        });
        if attempt == 2 || !retry {
            return result;
        }
        // Only this page is reloaded. Authentication, throttling, extraction and
        // validation failures stay fail-closed and use the job policy if allowed.
        page.reset().await?;
        sleep(Duration::from_millis(1000 + (ordinal as u64 * 347 % 1000))).await;
    }
    unreachable!()
}
/// The extractor accepts two forms of a timecard address. The second marks a read
/// that only checks another read of the same employee and publishes nothing new.
/// The provider's own timecard page for one employee and pay period. This is the
/// link retained with a publication; it carries identifiers only, never a session.
pub(super) fn source_url(origin: &str, employee: &Value, period: &Value) -> String {
    format!(
        "{origin}/v4/cl/web.php/timecard/index?firstrefno={}&perioddates={}&formtype=SUMMARY",
        s(employee, "code"),
        s(period, "key")
    )
}
fn timecard_url(origin: &str, employee: &Value, period: &Value, verification: bool) -> String {
    format!(
        "{}&dispatch_timecards={}",
        source_url(origin, employee, period),
        if verification { 2 } else { 1 }
    )
}
/// Fetch one timecard inside the authenticated tab and extract it from a detached
/// document: no provider script runs and the HTML never leaves the page. `None`
/// means "use a rendered read" (wrong origin, redirect, unexpected response, or
/// records that fail validation); only throttling and server errors stop the job.
async fn read_response(
    page: &Page,
    origin: &str,
    employee: &Value,
    period: &Value,
    verification: bool,
) -> Result<Option<Vec<Value>>> {
    let source = timecard_url(origin, employee, period, verification);
    let frame = page.frame().await?;
    if !s(&frame, "url").starts_with(&format!("{origin}/")) || !page.trusted(s(&frame, "url")) {
        return Ok(None);
    }
    let config = json!({"employeeCode":employee["code"],"period":period,"sourceUrl":source});
    let extractor = include_str!("timecard.js").trim().trim_end_matches(';');
    let started = page
        .evaluate(&format!(
            r#"(()=>{{globalThis.dispatchTimecard=null;(async()=>{{try{{
            const response=await fetch({source},{{credentials:'include',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)}});
            if(response.status===429||response.status>=500)throw 'unavailable';
            if(response.status!==200||!/^text\/html(?:;|$)/i.test(response.headers.get('content-type')||'')||!response.body)throw 'response';
            const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{{fatal:true}});let text='',size=0;
            for(;;){{const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2097152){{await reader.cancel();throw 'response';}}text+=decoder.decode(part.value,{{stream:true}});}}
            text+=decoder.decode();const document=new DOMParser().parseFromString(text,'text/html'),location={{href:{source}}};
            globalThis.dispatchTimecard={{ok:true,record:({extractor})({config})}};
          }}catch(error){{globalThis.dispatchTimecard={{ok:false,unavailable:error==='unavailable'}};}}}})();return true;}})()"#,
            source = json!(source)
        ))
        .await;
    if started.is_err() {
        return Ok(None);
    }
    let deadline = Instant::now() + Duration::from_secs(35);
    let outcome = loop {
        if Instant::now() >= deadline {
            return Ok(None);
        }
        match page.evaluate("globalThis.dispatchTimecard").await {
            Ok(value) if !value.is_null() => break value,
            Ok(_) => sleep(Duration::from_millis(100)).await,
            Err(_) => return Ok(None),
        }
    };
    let _ = page.evaluate("delete globalThis.dispatchTimecard").await;
    ensure(outcome["unavailable"] != true, "provider_unavailable", 502)?;
    if outcome["ok"] != true {
        return Ok(None);
    }
    Ok(project(&outcome["record"], s(employee, "code")).ok())
}
async fn read_once(
    page: &Page,
    origin: &str,
    employee: &Value,
    period: &Value,
    metrics: &Recorder,
    ordinal: usize,
    verification: bool,
) -> Result<Vec<Value>> {
    let source = timecard_url(origin, employee, period, verification);
    page.monitor_loading().await?;
    let previous_loader = page.start_navigation(&source).await?;
    let started = Instant::now();
    let mut content_started = None;
    let mut missing_since = None;
    let mut candidate: Option<(Vec<Value>, Instant)> = None;
    loop {
        if let Some(content) = content_started {
            ensure(
                Instant::now() < content + Duration::from_secs(30),
                "provider_content_timeout",
                504,
            )?;
        } else {
            ensure(
                started.elapsed() < Duration::from_secs(45),
                "provider_navigation_timeout",
                504,
            )?;
        }
        let frame = page.navigation(&previous_loader).await?;
        if frame.is_null() {
            sleep(Duration::from_millis(200)).await;
            continue;
        }
        ensure(
            s(&frame, "url") == "about:blank" || page.trusted(s(&frame, "url")),
            "authentication_failed",
            409,
        )?;
        if s(&frame, "loaderId") != previous_loader && s(&frame, "url") != "about:blank" {
            // A completed redirect away from the requested employee cannot be
            // mistaken for a slowly rendering timecard (including same-origin login).
            ensure(s(&frame, "url") == source, "authentication_failed", 409)?;
            content_started.get_or_insert_with(Instant::now);
            metrics.page_stage(ordinal, "content");
            match page.evaluate("({parsed:document.readyState!=='loading',complete:document.readyState==='complete',present:!!document.querySelector('#tbltimesheet')&&!!document.querySelector('#periodtotals'),login:!document.querySelector('#tbltimesheet')&&Array.from(document.querySelectorAll('input[type=password]')).some(e=>e.offsetParent!==null&&e.getClientRects().length>0),status:performance.getEntriesByType('navigation')[0]?.responseStatus||0})").await {
                Ok(value) => {
                    let status = value["status"].as_u64().unwrap_or(0);
                    ensure(![401,403].contains(&status) && value["login"] != true, "authentication_failed", 409)?;
                    ensure(status != 429 && status < 500, "provider_unavailable", 502)?;
                    let loading = page.loading(s(&frame,"loaderId")).await?;
                    metrics.page_loading(ordinal, loading["pending"].as_u64().map(|n| n as usize),
                        if value["complete"] == true { "complete" } else if value["parsed"] == true { "interactive" } else { "loading" });
                    if value["complete"] == true && value["present"] == true
                        && (loading["known"] != true || loading["pending"] == 0) { break; }
                    let quiet = loading["known"] == true && loading["failed"] == false
                        && loading["pending"] == 0 && loading["quietMs"].as_u64().unwrap_or(0) >= 750;
                    if value["parsed"] == true && value["present"] == true && quiet {
                        // Validate the actual data, then require it to remain stable
                        // across polls. Images/fonts do not hold up a valid timecard.
                        match extract(page, employee, period, &source).await {
                            Ok(records) => {
                                if let Some((previous, since)) = &candidate
                                    && *previous == records && since.elapsed() >= Duration::from_millis(750) {
                                    metrics.page_stage(ordinal, "extraction");
                                    if value["complete"] != true { metrics.early_ready(); }
                                    return Ok(records);
                                }
                                if candidate.as_ref().is_none_or(|(previous,_)| *previous != records) {
                                    candidate = Some((records, Instant::now()));
                                }
                            }
                            Err(error) if value["complete"] == true => return Err(error),
                            Err(error) if ["timecard_extraction_failed","invalid_timecard_hours","provider_hours_mismatch","browser_navigation_pending"].contains(&error.code.as_str()) => {candidate=None;}
                            Err(error) => return Err(error),
                        }
                    } else { candidate = None; }
                    if value["complete"] == true && value["present"] != true {
                        let missing = missing_since.get_or_insert_with(Instant::now);
                        ensure(missing.elapsed() < Duration::from_secs(3), "provider_content_missing", 502)?;
                    } else { missing_since = None; }
                }
                Err(error) if error.code == "browser_navigation_pending" => (),
                Err(error) => return Err(error),
            }
        }
        sleep(Duration::from_millis(200)).await;
    }
    metrics.page_stage(ordinal, "extraction");
    extract(page, employee, period, &source).await
}
async fn extract(
    page: &Page,
    employee: &Value,
    period: &Value,
    source: &str,
) -> Result<Vec<Value>> {
    let config = json!({"employeeCode":employee["code"],"period":period,"sourceUrl":source});
    let record = page
        .evaluate(&format!(
            "({})({config})",
            include_str!("timecard.js").trim().trim_end_matches(';')
        ))
        .await
        .map_err(|error| {
            if error.code == "browser_script_failed" {
                Error::new("timecard_extraction_failed", 502)
            } else {
                error
            }
        })?;
    project(&record, s(employee, "code"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body() -> Value {
        let mut body = json!({});
        for key in FIELDS {
            body[*key] = Value::Null;
        }
        body["eeCodes"] = json!(["AA01", "BB02"]);
        body["startDate"] = json!("2026-08-30");
        body["endDate"] = json!("2026-09-12");
        body["isAdvancedFilterApplied"] = json!(true);
        body["onlyBorrowedEmployees"] = json!(false);
        body
    }
    #[test]
    fn rejects_partial_rosters_and_selects_timezone_date_period() -> Result<()> {
        let (selected, period, _) = selected_body(&body(), date("2026-09-16")?)?;
        assert_eq!(period["start"], "2026-09-13");
        assert_eq!(period["end"], "2026-09-26");
        assert_eq!(selected["isAdvancedFilterApplied"], false);
        let (_, historical, _) = selected_body(&body(), date("2026-01-10")?)?;
        assert_eq!(historical["start"], "2026-01-04");
        assert_eq!(historical["end"], "2026-01-17");
        for (key, value) in [
            ("q", json!("driver")),
            ("take", json!(1)),
            ("skip", json!(1)),
            ("onlyBorrowedEmployees", json!(true)),
            ("isAdvancedFilterApplied", Value::Null),
            ("eeCodes", json!(["AA01", "aa01"])),
        ] {
            let mut body = body();
            body[key] = value;
            assert!(selected_body(&body, date("2026-09-16")?).is_err());
        }
        assert!(codes(&json!(["AA01", "aa01"])).is_err());
        Ok(())
    }
    #[test]
    fn projection_reconciles_additional_totals_without_double_counting() -> Result<()> {
        let days=(0..14).map(|i|json!({"date":format!("day{i}"),"hours":if i==0{8}else{0},"totalHours":null,"missingPunch":false,"punches":[]})).collect::<Vec<_>>();
        let mut record = json!({"days":days,"additionalRows":[{"date":"day0","hours":2,"totalHours":10}],"weeklyTotals":[10,0],"periodTotalHours":10});
        assert_eq!(project(&record, "AA01")?[0]["hours"], 10.);
        record["periodTotalHours"] = json!(11);
        assert!(project(&record, "AA01").is_err());
        Ok(())
    }
    #[test]
    fn mixed_pay_code_totals_and_cross_row_punches_remain_exact() -> Result<()> {
        let days = (0..14).map(|i| json!({"date":format!("day{i}"),"hours":null,"totalHours":null,"missingPunch":false,"punches":[]})).collect::<Vec<_>>();
        let mut record = json!({"days":days,"additionalRows":[
            {"date":"day0","hours":2,"totalHours":null},
            {"date":"day2","hours":1.5,"totalHours":8},
            {"date":"day7","hours":0.75,"totalHours":0.75},
            {"date":"day10","hours":0.5,"totalHours":null}
        ],"weeklyTotals":[18,7.5],"periodTotalHours":25.5});
        for (i, hours, total) in [
            (0, 8., Some(10.)),
            (2, 6.5, None),
            (7, 4.25, Some(4.25)),
            (10, 2., None),
        ] {
            record["days"][i]["hours"] = json!(hours);
            record["days"][i]["totalHours"] = json!(total);
        }
        let projected = project(&record, "AA01")?;
        assert_eq!(
            projected
                .iter()
                .map(|d| d["hours"].as_f64().unwrap())
                .collect::<Vec<_>>(),
            vec![10., 0., 8., 0., 0., 0., 0., 5., 0., 0., 2.5, 0., 0., 0.]
        );
        record["weeklyTotals"] = json!([17, 8.5]);
        assert_eq!(
            project(&record, "AA01").unwrap_err().code,
            "provider_hours_mismatch"
        );
        record["weeklyTotals"] = json!([18, 7.5]);
        record["periodTotalHours"] = json!(24.5);
        assert_eq!(
            project(&record, "AA01").unwrap_err().code,
            "provider_hours_mismatch"
        );
        record["periodTotalHours"] = json!(25.5);
        record["days"][0]["missingPunch"] = json!(true);
        record["days"][0]["punches"] = json!([{"slot":"i1","rowIndex":0,"displayTime":"08:00 AM"},{"slot":"o1","rowIndex":1,"displayTime":"12:00 PM"}]);
        let projected = project(&record, "AA01")?;
        assert_eq!(projected[0]["status"], "Missing punch");
        assert_eq!(
            projected[0]["punches"],
            json!([{"in":"08:00 AM","out":null,"hours":null,"inKind":null,"outKind":null},{"in":null,"out":"12:00 PM","hours":null,"inKind":null,"outKind":null}])
        );
        Ok(())
    }
    #[test]
    fn blank_leading_row_uses_additional_totals_and_preserves_punches() -> Result<()> {
        let days = (0..14).map(|i| json!({"date":format!("day{i}"),"hours":null,"totalHours":null,"missingPunch":false,"unresolvedSlots":[],"punches":[]})).collect::<Vec<_>>();
        let mut record = json!({"days":days,"additionalRows":[{"date":"day0","hours":2,"totalHours":4}],"weeklyTotals":[4,0],"periodTotalHours":4});
        record["days"][0]["punches"] = json!([
            {"slot":"i1","rowIndex":1,"displayTime":"08:00 AM"},
            {"slot":"o1","rowIndex":1,"displayTime":"10:00 AM"}
        ]);
        let day = &project(&record, "AA01")?[0];
        assert_eq!(day["hours"], 4.);
        assert_eq!(day["status"], "Complete");
        assert_eq!(
            day["punches"],
            json!([{"in":"08:00 AM","out":"10:00 AM","hours":null,"inKind":null,"outKind":null}])
        );

        record["days"][0]["punches"][0]["kind"] = json!("IN DAY");
        record["days"][0]["punches"][1]["kind"] = json!("OUT LUNCH");
        assert_eq!(
            project(&record, "AA01")?[0]["punches"][0]["outKind"],
            "OUT LUNCH"
        );
        assert_eq!(
            project(&record, "AA01")?[0]["punches"][0]["inKind"],
            "IN DAY"
        );

        // An unresolved punch on the additional row is still reported as such.
        record["days"][0]["missingPunch"] = json!(true);
        record["days"][0]["unresolvedSlots"] = json!(["1:o2"]);
        assert_eq!(project(&record, "AA01")?[0]["status"], "Missing punch");

        // Equal period totals cannot conceal hours in the wrong week.
        record["weeklyTotals"] = json!([0, 4]);
        assert_eq!(
            project(&record, "AA01").unwrap_err().code,
            "provider_hours_mismatch"
        );
        record["weeklyTotals"] = json!([4, 0]);

        // Missing hours on an occupied leading row must still fail closed.
        record["days"][0]["unresolvedSlots"] = json!(["o2"]);
        assert_eq!(
            project(&record, "AA01").unwrap_err().code,
            "invalid_timecard_hours"
        );
        record["days"][0]["missingPunch"] = json!(false);
        record["days"][0]["unresolvedSlots"] = json!([]);
        record["days"][0]["punches"][0]["rowIndex"] = json!(0);
        assert_eq!(
            project(&record, "AA01").unwrap_err().code,
            "invalid_timecard_hours"
        );
        Ok(())
    }
}
