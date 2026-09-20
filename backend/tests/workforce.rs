mod common;
use common::{bootstrapped, seeded};
use dispatch_backend::{collectors::Provider, db::s, workforce};
use serde_json::{Value, json};

#[test]
fn employee_timecards_use_period_order_and_the_latest_revision_within_each_period() {
    use dispatch_backend::contracts::EmployeeTimecardPeriod;
    let (_root, db, id) = bootstrapped();
    let period_data = |date: &str, collected: &str, hours: f64| {
        let mut data = workforce::fixture_date("UTC", Some(date.parse().unwrap())).unwrap();
        data["collectedAt"] = json!(collected);
        data["timecards"][0]["hours"] = json!(hours);
        data
    };
    let old = period_data("2026-09-05", "2026-09-06T00:00:00Z", 5.0);
    let middle = period_data("2026-09-12", "2026-09-13T00:00:00Z", 6.0);
    let current = period_data("2026-09-19", "2026-09-20T00:00:00Z", 7.0);
    for data in [&old, &middle, &current] {
        db.publish(&id, data).unwrap();
    }
    // A later sync of an older period must update that period, not replace Latest.
    let mut revision = period_data("2026-09-12", "2026-09-21T00:00:00Z", 9.0);
    revision["employees"][0]["name"] = json!("Old employee name");
    db.publish(&id, &revision).unwrap();
    let latest = db.employee_timecard(&id, "E001", None).unwrap();
    assert_eq!(latest.period.to, "2026-09-19");
    assert_eq!(latest.employee["name"], "Avery Morgan");
    assert!(latest.next_period.is_none());
    let previous = db
        .employee_timecard(&id, "E001", latest.previous_period.as_ref())
        .unwrap();
    assert_eq!(previous.period.to, "2026-09-12");
    assert_eq!(previous.next_period, Some(latest.period.clone()));
    assert_eq!(previous.timecards.last().unwrap()["hours"], 9.0);
    let first = db
        .employee_timecard(&id, "E001", previous.previous_period.as_ref())
        .unwrap();
    assert_eq!(first.period.to, "2026-09-05");
    assert!(first.previous_period.is_none());
    assert_eq!(first.next_period, Some(previous.period));
    let missing = EmployeeTimecardPeriod {
        from: "2025-01-01".into(),
        to: "2025-01-07".into(),
    };
    assert_eq!(
        db.employee_timecard(&id, "E001", Some(&missing))
            .err()
            .unwrap()
            .code,
        "employee_timecard_not_found"
    );
    assert_eq!(
        db.employee_timecard(&id, "UNKNOWN", None)
            .err()
            .unwrap()
            .code,
        "employee_not_found"
    );
    // Period history is scoped to the employee, even when their code exists elsewhere.
    revision["employees"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["code"] != "E002");
    revision["timecards"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["employeeCode"] != "E002");
    revision["collectedAt"] = json!("2026-09-22T00:00:00Z");
    db.publish(&id, &revision).unwrap();
    assert_eq!(
        db.employee_timecard(&id, "E002", None).unwrap().period.to,
        "2026-09-19"
    );
}

#[test]
fn employee_status_filter_applies_before_counting_and_pagination() {
    let (_root, db, id) = bootstrapped();
    let mut data = workforce::fixture("UTC").unwrap();
    data["employees"][1]["active"] = json!(false);
    data["employees"][4]["active"] = json!(false);
    db.publish(&id, &data).unwrap();
    let inactive = db.employees(&id, "", 0, 1, false, Some(false)).unwrap();
    assert_eq!(inactive["total"], 2);
    assert_eq!(inactive["employees"].as_array().unwrap().len(), 1);
    assert_eq!(inactive["employees"][0]["active"], false);
    let next = db.employees(&id, "", 1, 1, false, Some(false)).unwrap();
    assert_ne!(
        inactive["employees"][0]["code"],
        next["employees"][0]["code"]
    );
    assert_eq!(
        db.employees(&id, "", 0, 100, false, Some(true)).unwrap()["total"],
        10
    );
    assert_eq!(
        db.employees(&id, "Jordan", 0, 100, false, Some(false))
            .unwrap()["total"],
        1
    );
    assert_eq!(
        db.employees(&id, "Jordan", 0, 100, false, Some(true))
            .unwrap()["total"],
        0
    );
}

#[test]
fn publication_is_atomic_and_keeps_the_last_successful_dataset() {
    let (_root, db, id) = bootstrapped();
    let id = id.as_str();
    let data = workforce::fixture("UTC").unwrap();
    db.publish(id, &data).unwrap();
    let before = db.employee_timecard(id, "E001", None).unwrap();
    let mut bad = data.clone();
    bad["employees"][1]["code"] = json!("E001");
    assert_eq!(db.publish(id, &bad).unwrap_err().code, "duplicate_employee");
    bad = data.clone();
    bad["timecards"][0]["employeeCode"] = json!("unowned");
    assert_eq!(
        db.publish(id, &bad).unwrap_err().code,
        "timecard_identity_mismatch"
    );
    bad = data.clone();
    bad["timecards"][0]["hours"] = json!(49);
    assert!(db.publish(id, &bad).is_err());
    bad = data.clone();
    bad["timecards"][0]["date"] = json!("2026-02-30");
    assert!(db.publish(id, &bad).is_err());
    assert_eq!(db.employee_timecard(id, "E001", None).unwrap(), before);
    let mut later = data.clone();
    later["collectedAt"] = json!("2099-01-01T00:00:00.000Z");
    later["employees"].as_array_mut().unwrap().remove(0);
    later["timecards"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["employeeCode"] != "E001");
    db.publish(id, &later).unwrap();
    assert_eq!(
        db.employees(id, "", 0, 100, false, None).unwrap()["total"],
        11
    );
    assert_eq!(db.employee_timecard(id, "E001", None).unwrap(), before);
}

#[test]
fn timecard_links_publish_with_unchanged_hours_and_are_returned() {
    let (_root, db, id) = bootstrapped();
    let id = id.as_str();
    let data = workforce::fixture("UTC").unwrap();
    db.publish(id, &data).unwrap();
    // Publications from before links were retained return none.
    assert_eq!(
        db.employee_timecard(id, "E001", None).unwrap().timecards[0]["sourceUrl"],
        Value::Null
    );
    let link = |code: &str| {
        format!(
            "https://paycom.example/v4/cl/web.php/timecard/index?firstrefno={code}&perioddates=P1&formtype=SUMMARY"
        )
    };
    let mut linked = data.clone();
    linked["collectedAt"] = json!("2099-01-01T00:00:00.000Z");
    linked["sources"] = json!(
        data["employees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| json!({"employeeCode":e["code"],"periodKey":"P1","url":link(s(e,"code"))}))
            .collect::<Vec<_>>()
    );
    for (field, value, code) in [
        (
            "url",
            json!("https://user:secret@paycom.example/"),
            "invalid_source_url",
        ),
        ("url", json!("javascript:alert(1)"), "invalid_source_url"),
        ("employeeCode", json!("unowned"), "timecard_source_mismatch"),
        ("employeeCode", json!("E002"), "timecard_source_mismatch"),
    ] {
        let mut bad = linked.clone();
        bad["sources"][0][field] = value;
        assert_eq!(db.publish(id, &bad).unwrap_err().code, code);
    }
    // Identical hours still publish: the links are part of the change fingerprint.
    db.publish(id, &linked).unwrap();
    let paycom = db.collector(id, Provider::Paycom).unwrap();
    let count = |table: &str| {
        paycom
            .one(&format!("SELECT count(*) n FROM {table}"), [])
            .unwrap()
            .unwrap()["n"]
            .clone()
    };
    assert_eq!(count("publications"), 2);
    assert_eq!(count("timecard_sources"), 12);
    // An identical repeat only refreshes the collection time.
    linked["collectedAt"] = json!("2099-01-02T00:00:00.000Z");
    db.publish(id, &linked).unwrap();
    assert_eq!(count("publications"), 2);
    for card in db.employee_timecard(id, "E003", None).unwrap().timecards {
        assert_eq!(card["sourceUrl"], json!(link("E003")));
    }
    let date = s(&data, "to");
    let (_, _, rows) = db.daily_source(id, date).unwrap();
    assert_eq!(rows.len(), 12);
    for row in rows {
        assert_eq!(row["sourceUrl"], json!(link(s(&row, "employeeCode"))));
    }
}

#[test]
fn unchanged_publications_reuse_storage_but_changed_data_and_history_survive() {
    use dispatch_backend::collectors::Provider;
    let (_root, db, id) = bootstrapped();
    let id = id.as_str();
    let mut data = workforce::fixture("UTC").unwrap();
    db.publish(id, &data).unwrap();
    let provider = db.collector(id, Provider::Paycom).unwrap();
    let first = provider
        .one("SELECT id FROM publications WHERE active=1", [])
        .unwrap()
        .unwrap();
    data["collectedAt"] = json!("2099-01-01T00:00:00.000Z");
    data["employees"].as_array_mut().unwrap().reverse();
    data["timecards"].as_array_mut().unwrap().reverse();
    db.publish(id, &data).unwrap();
    assert_eq!(
        provider.all("SELECT id FROM publications", []).unwrap(),
        vec![first.clone()]
    );
    assert_eq!(
        db.employees(id, "", 0, 100, false, None).unwrap()["collectedAt"],
        data["collectedAt"]
    );
    data["timecards"][0]["hours"] = json!(7.25);
    data["collectedAt"] = json!("2099-01-02T00:00:00.000Z");
    db.publish(id, &data).unwrap();
    assert_eq!(
        provider
            .all("SELECT id FROM publications", [])
            .unwrap()
            .len(),
        2
    );
    assert!(
        provider
            .one("SELECT id FROM publications WHERE id=?", [s(&first, "id")])
            .unwrap()
            .is_some()
    );
    // A rollback runtime can publish without maintaining the new fingerprint.
    provider
        .exec(
            "DELETE FROM settings WHERE key='paycom.publicationFingerprint'",
            [],
        )
        .unwrap();
    data["collectedAt"] = json!("2099-01-03T00:00:00.000Z");
    db.publish(id, &data).unwrap();
    assert_eq!(
        provider
            .all("SELECT id FROM publications", [])
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn settings_reject_unknown_fields_and_preserve_empty_driver_selection() {
    let (_root, db) = seeded();
    let dsp = db
        .platform
        .one("SELECT id FROM dsps WHERE permanent=1", [])
        .unwrap()
        .unwrap();
    let id = s(&dsp, "id");
    let actor = db
        .platform
        .one("SELECT id FROM users WHERE platform_owner=1", [])
        .unwrap()
        .unwrap();
    let mut values = db.preferences(id).unwrap()["values"].clone();
    values["driver_departments"] = json!([]);
    db.save_preferences(id, s(&actor, "id"), 0, &values)
        .unwrap();
    let day = workforce::fixture("UTC").unwrap()["to"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        db.daily(id, &day, "name", false).unwrap()["rows"],
        json!([])
    );
    assert_eq!(
        db.employees(id, "", 0, 100, false, None).unwrap()["total"],
        12
    );
    values["unknown"] = json!(true);
    assert!(
        db.save_preferences(id, s(&actor, "id"), 1, &values)
            .is_err()
    );
}

#[test]
fn retired_sync_preferences_are_not_returned_and_open_dashboards_may_still_send_them() {
    let (_root, db) = seeded();
    let dsp = db
        .platform
        .one("SELECT id FROM dsps WHERE permanent=1", [])
        .unwrap()
        .unwrap();
    let id = s(&dsp, "id");
    let actor = db
        .platform
        .one("SELECT id FROM users WHERE platform_owner=1", [])
        .unwrap()
        .unwrap();
    // Preferences as v0.0.9 stored them.
    let mut older = workforce::defaults();
    older["automatic_sync"] = json!(true);
    older["sync_interval_seconds"] = json!(3600);
    db.collector(id, Provider::Paycom)
        .unwrap()
        .set(
            "paycom.preferences",
            &json!({"revision":4,"values":older,"history":[]}),
        )
        .unwrap();
    let values = db.preferences(id).unwrap()["values"].clone();
    assert_eq!(values, workforce::defaults());
    let saved = db.save_preferences(id, s(&actor, "id"), 4, &older).unwrap();
    assert_eq!(saved["revision"], 5);
    assert_eq!(saved["values"], workforce::defaults());
    let stored = db
        .collector(id, Provider::Paycom)
        .unwrap()
        .setting("paycom.preferences", Value::Null)
        .unwrap();
    assert_eq!(stored["values"], workforce::defaults());
}

#[test]
fn late_da_settings_default_for_older_preferences_and_validate() {
    let (_root, db) = seeded();
    let dsp = db
        .platform
        .one("SELECT id FROM dsps WHERE permanent=1", [])
        .unwrap()
        .unwrap();
    let id = s(&dsp, "id");
    let actor = db
        .platform
        .one("SELECT id FROM users WHERE platform_owner=1", [])
        .unwrap()
        .unwrap();
    // Preferences stored before the Late DA keys existed.
    let mut older = workforce::defaults();
    for key in ["late_da_time", "late_da_departments"] {
        older.as_object_mut().unwrap().remove(key);
    }
    db.collector(id, Provider::Paycom)
        .unwrap()
        .set(
            "paycom.preferences",
            &json!({"revision":0,"values":older,"history":[]}),
        )
        .unwrap();
    let mut values = db.preferences(id).unwrap()["values"].clone();
    assert_eq!(values["late_da_time"], "10:01");
    assert_eq!(values["late_da_departments"], json!([]));
    for time in ["24:00", "10:60", "9:30", "10-01", "ab:cd", "10:011"] {
        values["late_da_time"] = json!(time);
        assert!(
            db.save_preferences(id, s(&actor, "id"), 0, &values)
                .is_err(),
            "{time}"
        );
    }
    values["late_da_time"] = json!("09:45");
    values["late_da_departments"] = Value::Null;
    assert!(
        db.save_preferences(id, s(&actor, "id"), 0, &values)
            .is_err()
    );
    values["late_da_departments"] = json!(["Delivery"]);
    let saved = db
        .save_preferences(id, s(&actor, "id"), 0, &values)
        .unwrap();
    assert_eq!(saved["values"]["late_da_time"], "09:45");
    assert_eq!(saved["values"]["late_da_departments"], json!(["Delivery"]));
}
