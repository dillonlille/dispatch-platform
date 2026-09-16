use super::*;
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
fn project(record: &Value, employee: &str) -> Result<Vec<Value>> {
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
                    if day["missingPunch"] == false
                        && day["punches"].as_array().is_some_and(Vec::is_empty)
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
    pub async fn collect<F, Fut>(&mut self, timezone: &str, mut progress: F) -> Result<Value>
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
            let event = self.browser.event(&self.page).await?;
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
        for (index, employee) in employees.iter().enumerate() {
            progress(
                20 + (index * 70 / employees.len()) as i64,
                format!("Reading timecards ({} of {})", index + 1, employees.len()),
            )
            .await?;
            let path = format!(
                "/v4/cl/web.php/timecard/index?firstrefno={}&perioddates={}&formtype=SUMMARY&dispatch_timecards=1",
                s(employee, "code"),
                s(&period, "key")
            );
            let source = format!("{}{path}", self.origin);
            self.navigate(&path).await?;
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                ensure(Instant::now() < deadline, "provider_timeout", 504)?;
                let frame = self.frame().await?;
                if s(&frame,"url")==source && self.evaluate("document.readyState==='complete'&&!!document.querySelector('#tbltimesheet')&&!!document.querySelector('#periodtotals')").await?==true {break;}
                ensure(self.trusted(s(&frame, "url")), "authentication_failed", 409)?;
                sleep(Duration::from_millis(200)).await;
            }
            let config =
                json!({"employeeCode":employee["code"],"period":period,"sourceUrl":source});
            let record = self
                .evaluate(&format!(
                    "({})({config})",
                    include_str!("timecard.js").trim().trim_end_matches(';')
                ))
                .await?;
            timecards.extend(project(&record, s(employee, "code"))?);
        }
        Ok(
            json!({"employees":employees,"timecards":timecards,"from":period["start"],"to":period["end"],"collectedAt":db::iso()}),
        )
    }
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
}
