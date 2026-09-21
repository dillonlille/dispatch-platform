use super::*;
use serde_json::json;
fn employee() -> MealSource {
    serde_json::from_value(json!({
        "id":"employee-1","name":"Example Employee",
        "paycom":{"employeeCode":"E001","name":"Employee, Example","status":"Complete",
            "punches":[{"in":"09:42 AM","out":"02:34 PM","hours":null},{"in":"03:04 PM","out":"07:08 PM","hours":null}]},
        "cortex":[{"mealId":"meal-1","itineraryId":"route-1","cortexId":"driver-1","driverName":"Example Employee",
            "station":"DEMO1","timezone":"America/Los_Angeles","collectedAt":"2026-09-16T06:00:00Z",
            "lastDelivery":"2026-09-15T21:33:00Z","start":"2026-09-15T21:38:53Z","end":"2026-09-15T22:08:42Z",
            "firstDelivery":"2026-09-15T22:10:00Z","beforeStatus":"verified","afterStatus":"verified"}]
    })).unwrap()
}
fn punches(row: &mut MealSource, value: serde_json::Value) {
    row.paycom.as_mut().unwrap().punches = serde_json::from_value(value).unwrap();
}
fn summary(row: &MealSource) -> MealAssessment {
    assess_meal(row, "2026-09-15", None)
}
#[test]
fn delivery_gaps_use_only_flex_instants_and_an_exact_five_minute_threshold() {
    let mut row = employee();
    for (milliseconds, over_limit) in [
        (299_999, false),
        (300_000, false),
        (300_001, true),
        (360_000, true),
        (0, false),
    ] {
        row.cortex[0].start =
            (DateTime::parse_from_rfc3339(row.cortex[0].last_delivery.as_deref().unwrap())
                .unwrap()
                + chrono::Duration::milliseconds(milliseconds))
            .to_rfc3339();
        assert_eq!(
            delivery_gaps(Some(&row.cortex[0])).before,
            Some(DeliveryGap {
                milliseconds,
                over_limit
            })
        );
        assert_eq!(
            summary(&row).pairs[0].gaps.before,
            Some(DeliveryGap {
                milliseconds,
                over_limit
            })
        );
    }
    row.paycom = None;
    assert_eq!(
        summary(&row).pairs[0].gaps,
        delivery_gaps(Some(&row.cortex[0]))
    );
    row.cortex[0].first_delivery = row.cortex[0].end.clone();
    assert_eq!(
        delivery_gaps(Some(&row.cortex[0])).after,
        Some(DeliveryGap {
            milliseconds: 0,
            over_limit: false
        })
    );
}
#[test]
fn unavailable_missing_invalid_or_backwards_delivery_gaps_remain_unknown() {
    let row = employee();
    assert_eq!(
        delivery_gaps(None),
        DeliveryGaps {
            before: None,
            after: None
        }
    );
    for status in ["unavailable", "absent", "pending"] {
        let mut meal = row.cortex[0].clone();
        meal.before_status = status.into();
        meal.after_status = status.into();
        assert_eq!(delivery_gaps(Some(&meal)), delivery_gaps(None));
    }
    for value in [None, Some("invalid"), Some("2026-09-16T00:00:00Z")] {
        let mut meal = row.cortex[0].clone();
        meal.last_delivery = value.map(Into::into);
        assert!(delivery_gaps(Some(&meal)).before.is_none());
    }
    for value in [None, Some("invalid"), Some("2026-09-15T00:00:00Z")] {
        let mut meal = row.cortex[0].clone();
        meal.first_delivery = value.map(Into::into);
        assert!(delivery_gaps(Some(&meal)).after.is_none());
    }
    let mut meal = row.cortex[0].clone();
    meal.end = None;
    assert!(delivery_gaps(Some(&meal)).after.is_none());
    meal.start = "invalid".into();
    assert!(delivery_gaps(Some(&meal)).before.is_none());
}
#[test]
fn gaps_measure_elapsed_time_across_midnight_and_dst_and_include_later_meals() {
    let mut row = employee();
    let meal = &mut row.cortex[0];
    meal.last_delivery = Some("2026-11-01T01:58:00-07:00".into());
    meal.start = "2026-11-01T01:04:00-08:00".into();
    meal.end = Some("2026-11-01T23:59:00-08:00".into());
    meal.first_delivery = Some("2026-11-02T00:05:00-08:00".into());
    let gaps = delivery_gaps(Some(meal));
    assert_eq!(gaps.before.unwrap().milliseconds, 360_000);
    assert_eq!(gaps.after.unwrap().milliseconds, 360_000);
    row = employee();
    row.cortex[0].last_delivery = Some(row.cortex[0].start.clone());
    row.cortex[0].first_delivery = row.cortex[0].end.clone();
    assert!(!summary(&row).long_gap);
    row.cortex.push(employee().cortex.remove(0));
    let result = summary(&row);
    assert!(result.long_gap);
    assert!(!result.pairs[0].gaps.before.as_ref().unwrap().over_limit);
    assert_eq!(
        result.pairs[1].gaps.before.as_ref().unwrap().milliseconds,
        353_000
    );
    assert_eq!(
        result.pairs[1].gaps.after.as_ref().unwrap().milliseconds,
        78_000
    );
}
#[test]
fn comparisons_keep_minute_precision_and_status_precedence() {
    let mut row = employee();
    let result = summary(&row);
    assert_eq!(result.status, MealStatus::Different);
    assert_eq!(result.pairs[0].out_difference, Some(4));
    assert_eq!(result.pairs[0].in_difference, Some(4));
    assert_eq!(result.paycom.in_day.unwrap().minute, 582);
    assert_eq!(result.paycom.out_day.unwrap().minute, 1148);
    row.cortex[0].start = "2026-09-15T21:34:59Z".into();
    row.cortex[0].end = Some("2026-09-15T22:04:17Z".into());
    assert_eq!(summary(&row).status, MealStatus::Same);
    row.cortex[0].last_delivery = None;
    assert_eq!(summary(&row).status, MealStatus::MissingData);
    row.paycom = None;
    assert_eq!(summary(&row).status, MealStatus::FlexOnly);
}
#[test]
fn lateness_uses_in_day_at_or_after_the_configured_time_and_department() {
    let mut row = employee();
    let mut rule = LateRule {
        time: "10:01".into(),
        departments: vec![],
    };
    for (time, expected) in [
        (Some("10:00 AM"), false),
        (Some("10:01 AM"), true),
        (Some("01:15 PM"), true),
        (None, false),
    ] {
        row.paycom.as_mut().unwrap().punches[0].clock_in = time.map(Into::into);
        assert_eq!(
            assess_meal(&row, "2026-09-15", Some(&rule)).late_in,
            expected
        );
    }
    row.paycom.as_mut().unwrap().punches[0].clock_in = Some("10:30".into());
    row.paycom.as_mut().unwrap().department = Some("Dispatch".into());
    rule.departments = vec!["Driver".into()];
    assert!(!assess_meal(&row, "2026-09-15", Some(&rule)).late_in);
    rule.departments.push("Dispatch".into());
    assert!(assess_meal(&row, "2026-09-15", Some(&rule)).late_in);
    assert!(!summary(&row).late_in);
    rule.time = "later".into();
    assert!(!assess_meal(&row, "2026-09-15", Some(&rule)).late_in);
    row.paycom = None;
    assert!(!assess_meal(&row, "2026-09-15", Some(&rule)).late_in);
}
#[test]
fn partial_and_explicitly_null_labels_are_not_inferred_as_legacy_punches() {
    let mut row = employee();
    punches(
        &mut row,
        json!([{"in":null,"out":"02:34 PM","hours":null,"inKind":null,"outKind":"OUT LUNCH"}]),
    );
    row.paycom.as_mut().unwrap().status = "Missing punch".into();
    let result = summary(&row).paycom;
    assert!(result.in_day.is_none() && result.out_day.is_none());
    assert_eq!(result.lunches[0].out.as_ref().unwrap().minute, 874);
    punches(&mut row, json!([{"in":null,"out":"02:34 PM","hours":null}]));
    let result = summary(&row).paycom;
    assert!(result.review && result.out_day.is_none() && result.lunches.is_empty());
    assert_eq!(result.events[0].raw, "02:34 PM");
    punches(&mut row, json!([{"in":"bad","out":null,"hours":null}]));
    assert!(summary(&row).paycom.events[0].time.is_none());
    row.paycom.as_mut().unwrap().status = "Complete".into();
    punches(
        &mut row,
        json!([{"in":"08:00","out":"17:00","hours":9,"inKind":null,"outKind":null}]),
    );
    let encoded = serde_json::to_value(&row.paycom.as_ref().unwrap().punches[0]).unwrap();
    assert!(encoded.get("inKind").unwrap().is_null());
    assert!(!summary(&row).paycom.legacy);
    assert!(summary(&row).paycom.review);
}
#[test]
fn overnight_punches_keep_dates_while_dst_repeats_require_review() {
    let mut row = employee();
    punches(
        &mut row,
        json!([{"in":"19:00","out":"23:50","hours":null},{"in":"00:20","out":"04:00","hours":null}]),
    );
    row.cortex[0].start = "2026-09-16T06:50:00Z".into();
    row.cortex[0].end = Some("2026-09-16T07:20:00Z".into());
    let result = summary(&row);
    assert_eq!(result.paycom.out_day.unwrap().day, 1);
    assert_eq!(result.pairs[0].into.as_ref().unwrap().day, 1);
    assert_eq!(result.pairs[0].in_difference, Some(0));
    assert_eq!(
        cortex_clock(
            Some("2026-11-01T08:30:00Z"),
            "2026-11-01",
            "America/Los_Angeles"
        ),
        cortex_clock(
            Some("2026-11-01T09:30:00Z"),
            "2026-11-01",
            "America/Los_Angeles"
        )
    );
    punches(
        &mut row,
        json!([{"in":"00:30","out":"01:50","hours":null},{"in":"01:20","out":"04:00","hours":null}]),
    );
    let result = summary(&row);
    assert!(result.paycom.review);
    assert_eq!(result.paycom.lunches[0].clock_in.as_ref().unwrap().day, 0);
    assert!(result.pairs[0].in_difference.is_none());
}
#[test]
fn all_meals_are_retained_and_mismatched_counts_never_produce_false_differences() {
    let mut row = employee();
    punches(
        &mut row,
        json!([
        {"in":"09:00","out":"12:00","hours":null,"inKind":"IN DAY","outKind":"OUT LUNCH"},
        {"in":"12:30","out":"16:00","hours":null,"inKind":"IN LUNCH","outKind":"OUT LUNCH"},
        {"in":"16:30","out":"20:00","hours":null,"inKind":"IN LUNCH","outKind":"OUT DAY"}]),
    );
    let result = summary(&row);
    assert_eq!(result.status, MealStatus::ReviewPairing);
    assert_eq!(result.pairs.len(), 2);
    assert!(result.pairs[0].out_difference.is_none());
    let mut meal = row.cortex[0].clone();
    meal.meal_id = "meal-2".into();
    meal.start = "2026-09-15T23:00:00Z".into();
    meal.end = Some("2026-09-15T23:30:00Z".into());
    row.cortex.push(meal);
    let result = summary(&row);
    assert_eq!(result.pairs[1].out_difference, Some(0));
    assert_eq!(result.pairs[1].in_difference, Some(0));
}
