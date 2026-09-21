//! Pair meal evidence with assessed Paycom punches; preserve source order and uncertainty.
use crate::{
    contracts::*,
    workforce::assessment::{parse_clock, paycom_day},
};
use chrono::{DateTime, NaiveDate, Timelike};

fn cortex_clock(value: Option<&str>, date: &str, zone: &str) -> Option<AssessedClock> {
    let instant = DateTime::parse_from_rfc3339(value?).ok()?;
    let local = instant.with_timezone(&zone.parse::<chrono_tz::Tz>().ok()?);
    let day =
        i32::try_from((local.date_naive() - date.parse::<NaiveDate>().ok()?).num_days()).ok()?;
    Some(AssessedClock {
        minute: day * 1440 + local.hour() as i32 * 60 + local.minute() as i32,
        day,
    })
}

fn gap(start: Option<&str>, end: Option<&str>, status: &str) -> Option<DeliveryGap> {
    if status != "verified" {
        return None;
    }
    let start = DateTime::parse_from_rfc3339(start?)
        .ok()?
        .timestamp_millis();
    let end = DateTime::parse_from_rfc3339(end?).ok()?.timestamp_millis();
    let milliseconds = end.checked_sub(start)?;
    (milliseconds >= 0).then_some(DeliveryGap {
        milliseconds,
        over_limit: milliseconds > 300_000,
    })
}

pub fn delivery_gaps(meal: Option<&CortexMeal>) -> DeliveryGaps {
    DeliveryGaps {
        before: meal
            .and_then(|m| gap(m.last_delivery.as_deref(), Some(&m.start), &m.before_status)),
        after: meal.and_then(|m| {
            gap(
                m.end.as_deref(),
                m.first_delivery.as_deref(),
                &m.after_status,
            )
        }),
    }
}

pub fn assess_meal(row: &MealSource, date: &str, late: Option<&LateRule>) -> MealAssessment {
    let paycom = row.paycom.as_ref().map_or_else(
        || paycom_day("", &[]),
        |p| paycom_day(&p.status, &p.punches),
    );
    let late_in = late.is_some_and(|rule| {
        parse_clock(&rule.time).is_some_and(|from| {
            paycom
                .in_day
                .as_ref()
                .is_some_and(|clock| clock.minute >= from)
                && (rule.departments.is_empty()
                    || rule.departments.iter().any(|department| {
                        department
                            == row
                                .paycom
                                .as_ref()
                                .and_then(|p| p.department.as_deref())
                                .unwrap_or("")
                    }))
        })
    });
    let comparable = !paycom.review && paycom.lunches.len() == row.cortex.len();
    let pairs: Vec<_> = (0..paycom.lunches.len().max(row.cortex.len()).max(1))
        .map(|i| {
            let cortex = row.cortex.get(i);
            let lunch = paycom.lunches.get(i);
            let out = cortex.and_then(|m| cortex_clock(Some(&m.start), date, &m.timezone));
            let into = cortex.and_then(|m| cortex_clock(m.end.as_deref(), date, &m.timezone));
            let difference = |a: Option<&AssessedClock>, b: Option<&AssessedClock>| {
                if comparable {
                    a.zip(b).map(|(a, b)| b.minute - a.minute)
                } else {
                    None
                }
            };
            MealPair {
                cortex_index: cortex.map(|_| i),
                lunch_index: lunch.map(|_| i),
                out_difference: difference(lunch.and_then(|l| l.out.as_ref()), out.as_ref()),
                in_difference: difference(lunch.and_then(|l| l.clock_in.as_ref()), into.as_ref()),
                out,
                into,
                gaps: delivery_gaps(cortex),
            }
        })
        .collect();
    let different = pairs.iter().any(|p| {
        p.out_difference.is_some_and(|n| n != 0) || p.in_difference.is_some_and(|n| n != 0)
    });
    let long_gap = pairs.iter().any(|p| {
        p.gaps.before.as_ref().is_some_and(|g| g.over_limit)
            || p.gaps.after.as_ref().is_some_and(|g| g.over_limit)
    });
    let missing = row.paycom.is_none()
        || row.cortex.is_empty()
        || paycom.review
        || paycom.in_day.is_none()
        || paycom.out_day.is_none()
        || !comparable
        || pairs.iter().any(|p| {
            let lunch = p.lunch_index.and_then(|i| paycom.lunches.get(i));
            let cortex = p.cortex_index.and_then(|i| row.cortex.get(i));
            lunch.is_none_or(|l| l.out.is_none() || l.clock_in.is_none())
                || p.out.is_none()
                || p.into.is_none()
                || cortex.is_none_or(|m| {
                    m.last_delivery.as_deref().is_none_or(str::is_empty)
                        || m.first_delivery.as_deref().is_none_or(str::is_empty)
                })
        });
    let status = if row.paycom.is_none() {
        MealStatus::FlexOnly
    } else if row.cortex.is_empty() {
        MealStatus::NoFlexMeal
    } else if paycom.review {
        MealStatus::ReviewPunches
    } else if paycom.lunches.is_empty() {
        MealStatus::MissingLunch
    } else if !comparable {
        MealStatus::ReviewPairing
    } else if missing {
        MealStatus::MissingData
    } else if different {
        MealStatus::Different
    } else {
        MealStatus::Same
    };
    MealAssessment {
        paycom,
        pairs,
        different,
        missing,
        status,
        long_gap,
        late_in,
    }
}

impl MealSource {
    pub fn assessed(self, date: &str, late: Option<&LateRule>) -> MealEmployee {
        let assessment = assess_meal(&self, date, late);
        MealEmployee {
            source: self,
            assessment,
        }
    }
}

#[cfg(test)]
#[path = "assessment_tests.rs"]
mod tests;
