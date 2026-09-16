use super::*;
use crate::core::job_metrics::Recorder;
use chrono::{Datelike, NaiveDate};
use std::{collections::BTreeSet, future::Future};
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
        let mut punches=Vec::new(); let mut pending=Value::Null; let mut row=Value::Null;
        for punch in day["punches"].as_array().ok_or_else(error)? {
            if row!=punch["rowIndex"] && !pending.is_null() {punches.push(json!({"in":pending,"out":null,"hours":null}));pending=Value::Null;}
            row=punch["rowIndex"].clone();
            if s(punch,"slot").starts_with('i') {
                if !pending.is_null() {punches.push(json!({"in":pending,"out":null,"hours":null}));}
                pending=punch["displayTime"].clone();
            } else {punches.push(json!({"in":pending,"out":punch["displayTime"],"hours":null}));pending=Value::Null;}
        }
        if !pending.is_null(){punches.push(json!({"in":pending,"out":null,"hours":null}));}
        Ok(json!({"employeeCode":employee,"date":day["date"],"hours":(values[index]*100.).round()/100.,"status":if day["missingPunch"]==true{"Missing punch"}else if punches.is_empty(){"No punches"}else{"Complete"},"punches":punches}))
    }).collect()
}
impl Driver {
    pub async fn collect<F, Fut>(
        &mut self,
        timezone: &str,
        metrics: &Recorder,
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
        let (body, period, codes) =
            selected_body(&body, chrono::Utc::now().with_timezone(&zone).date_naive())?;
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
        let mut timecards = Vec::with_capacity(employees.len() * 14);
        let mut second = if employees.len() > 1 {
            Some(Page::open(self.browser.clone(), self.origin.clone()).await?)
        } else {
            None
        };
        for (batch, employees) in employees.chunks(2).enumerate() {
            let first = batch * 2;
            progress(
                20 + (first * 70 / codes.len()) as i64,
                format!(
                    "Reading timecards ({}–{} of {})",
                    first + 1,
                    first + employees.len(),
                    codes.len()
                ),
            )
            .await?;
            let result = if let [a, b] = employees {
                // Never drop the sibling's in-flight CDP command on a page error:
                // the transport intentionally closes when a caller disappears.
                let (a, b) = tokio::join!(
                    read_timecard(&mut self.page, &self.origin, a, &period, metrics, first + 1),
                    read_timecard(
                        second.as_mut().expect("second collection tab"),
                        &self.origin,
                        b,
                        &period,
                        metrics,
                        first + 2
                    )
                );
                let mut a = a?;
                a.extend(b?);
                a
            } else {
                read_timecard(
                    &mut self.page,
                    &self.origin,
                    &employees[0],
                    &period,
                    metrics,
                    first + 1,
                )
                .await?
            };
            timecards.extend(result);
            // Both pages are complete and their validated records are now owned
            // by Rust. Reclaim unreachable page objects before loading more.
            self.page.collect_garbage().await?;
            if let Some(second) = &second {
                second.collect_garbage().await?;
            }
        }
        Ok(
            json!({"employees":employees,"timecards":timecards,"from":period["start"],"to":period["end"],"collectedAt":db::iso()}),
        )
    }
}

async fn read_timecard(
    page: &mut Page,
    origin: &str,
    employee: &Value,
    period: &Value,
    metrics: &Recorder,
    ordinal: usize,
) -> Result<Vec<Value>> {
    for attempt in 1..=2 {
        metrics.page_start(ordinal, attempt);
        let result = read_once(page, origin, employee, period, metrics, ordinal).await;
        metrics.page_finish(
            ordinal,
            result.as_ref().err().map(|error| error.code.as_str()),
        );
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
async fn read_once(
    page: &Page,
    origin: &str,
    employee: &Value,
    period: &Value,
    metrics: &Recorder,
    ordinal: usize,
) -> Result<Vec<Value>> {
    let source = format!(
        "{origin}/v4/cl/web.php/timecard/index?firstrefno={}&perioddates={}&formtype=SUMMARY&dispatch_timecards=1",
        s(employee, "code"),
        s(period, "key")
    );
    let previous_loader = page.start_navigation(&source).await?;
    let started = Instant::now();
    let mut content_started = None;
    let mut missing_since = None;
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
            match page.evaluate("({complete:document.readyState==='complete',present:!!document.querySelector('#tbltimesheet')&&!!document.querySelector('#periodtotals'),login:!document.querySelector('#tbltimesheet')&&Array.from(document.querySelectorAll('input[type=password]')).some(e=>e.offsetParent!==null&&e.getClientRects().length>0),status:performance.getEntriesByType('navigation')[0]?.responseStatus||0})").await {
                Ok(value) => {
                    let status = value["status"].as_u64().unwrap_or(0);
                    ensure(![401,403].contains(&status) && value["login"] != true, "authentication_failed", 409)?;
                    ensure(status != 429 && status < 500, "provider_unavailable", 502)?;
                    if value["complete"] == true && value["present"] == true { break; }
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
            json!([{"in":"08:00 AM","out":"10:00 AM","hours":null}])
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
