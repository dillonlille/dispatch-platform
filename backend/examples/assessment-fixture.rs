//! Offline test fixture builder. Uses the same assessment as HTTP responses; never shipped.
use dispatch_backend::{contracts::*, meals::assessment};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
struct Input {
    date: String,
    late: Option<LateRule>,
    #[serde(default)]
    rows: Vec<MealSource>,
    #[serde(default)]
    timecards: Vec<Timecard>,
}
#[derive(Serialize)]
struct Output {
    rows: Vec<MealEmployee>,
    timecards: Vec<EmployeeTimecard>,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let batches: Vec<Input> = serde_json::from_str(&input)?;
    let results: Vec<_> = batches
        .into_iter()
        .map(|input| Output {
            rows: input
                .rows
                .into_iter()
                .map(|row| {
                    let assessment =
                        assessment::assess_meal(&row, &input.date, input.late.as_ref());
                    MealEmployee {
                        source: row,
                        assessment,
                    }
                })
                .collect(),
            timecards: input
                .timecards
                .into_iter()
                .map(Timecard::assessed)
                .collect(),
        })
        .collect();
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}
