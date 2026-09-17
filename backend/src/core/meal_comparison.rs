//! Read-only comparison across provider snapshots. Unique names can match
//! automatically; saved overrides live in DSP storage, never in source records.
use super::{
    Result,
    collectors::Provider,
    db::{Store, n, s},
    ensure, validate as v, workforce,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

const LINKS: &str = "employees.provider_links";

// Exact matches take priority over the more conservative name-variant pass.
fn name_key(name: &str) -> String {
    let ordered = name
        .split_once(',')
        .map(|(last, first)| format!("{first} {last}"));
    ordered
        .as_deref()
        .unwrap_or(name)
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

struct Name {
    given: String,
    surnames: Vec<String>,
    suffix: Option<String>,
}

impl Name {
    fn new(name: &str) -> Self {
        let ordered = name
            .split_once(',')
            .map(|(last, first)| format!("{first} {last}"));
        let mut words: Vec<_> = ordered
            .as_deref()
            .unwrap_or(name)
            .split_whitespace()
            .map(name_key)
            .filter(|word| !word.is_empty())
            .collect();
        let suffix = words.last().and_then(|word| match word.as_str() {
            "jr" | "junior" => Some("jr"),
            "sr" | "senior" => Some("sr"),
            "ii" => Some("ii"),
            "iii" => Some("iii"),
            "iv" => Some("iv"),
            _ => None,
        });
        let suffix = suffix.map(str::to_owned);
        if suffix.is_some() {
            words.pop();
        }
        let given = if words.is_empty() {
            String::new()
        } else {
            words.remove(0)
        };
        // Supported short forms are explicit, never arbitrary first-name prefixes
        // (e.g. Alex must not also match Alexis or Alexandra).
        let given = if given == "alex" {
            "alexander".into()
        } else {
            given
        };
        Self {
            given,
            surnames: words,
            suffix,
        }
    }

    fn matches(&self, other: &Self) -> bool {
        if self.given.is_empty()
            || self.given != other.given
            || self.surnames.is_empty()
            || other.surnames.is_empty()
            || (self.suffix.is_some() && other.suffix.is_some() && self.suffix != other.suffix)
        {
            return false;
        }
        // One provider may omit a second surname or join surname words. Require
        // the entire shorter surname at a word boundary, not a fuzzy substring.
        let prefix = |short: &[String], long: &[String]| {
            let short = short.concat();
            let mut joined = String::new();
            long.iter().any(|word| {
                joined.push_str(word);
                joined == short
            })
        };
        prefix(&self.surnames, &other.surnames) || prefix(&other.surnames, &self.surnames)
    }
}

fn match_drivers(drivers: &mut BTreeMap<String, Value>, roster: &[Value], settings: &Value) {
    let saved = settings["links"].as_array().cloned().unwrap_or_default();
    let separate = settings["separate"].as_array().cloned().unwrap_or_default();
    let mut reserved: HashSet<String> = saved
        .iter()
        .map(|l| s(l, "paycomCode").to_owned())
        .collect();
    let mut employees_by_name: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    let mut driver_counts: BTreeMap<String, usize> = BTreeMap::new();
    for employee in roster {
        employees_by_name
            .entry(name_key(s(employee, "name")))
            .or_default()
            .push(employee);
    }
    for driver in drivers.values() {
        *driver_counts
            .entry(name_key(s(driver, "name")))
            .or_default() += 1;
    }
    for (id, driver) in drivers.iter_mut() {
        let key = name_key(s(driver, "name"));
        let candidates = employees_by_name.get(&key);
        let (code, kind) = if let Some(link) = saved.iter().find(|l| s(l, "cortexId") == id) {
            (link["paycomCode"].clone(), "saved")
        } else if separate.iter().any(|v| v.as_str() == Some(id)) {
            (Value::Null, "separate")
        } else if !key.is_empty()
            && driver_counts[&key] == 1
            && let Some(matches) = candidates
            && matches.len() == 1
            && !reserved.contains(s(matches[0], "code"))
        {
            (matches[0]["code"].clone(), "name")
        } else {
            (Value::Null, "unmatched")
        };
        if let Some(code) = code.as_str() {
            reserved.insert(code.to_owned());
        }
        driver["paycomCode"] = code;
        driver["matchType"] = json!(kind);
    }

    let mut employees_by_given: BTreeMap<String, Vec<(&Value, Name)>> = BTreeMap::new();
    for employee in roster {
        let name = Name::new(s(employee, "name"));
        employees_by_given
            .entry(name.given.clone())
            .or_default()
            .push((employee, name));
    }
    let mut candidates = BTreeMap::new();
    let mut claims: BTreeMap<String, usize> = BTreeMap::new();
    // Count every source identity, even one without punches/meals or with a saved
    // override. Removing such a person must not make an ambiguous name look unique.
    for (id, driver) in drivers.iter() {
        let name = Name::new(s(driver, "name"));
        let matches: Vec<_> = employees_by_given
            .get(&name.given)
            .into_iter()
            .flatten()
            .filter(|(_, employee_name)| name.matches(employee_name))
            .map(|(employee, _)| s(employee, "code").to_owned())
            .collect();
        for code in &matches {
            *claims.entry(code.clone()).or_default() += 1;
        }
        candidates.insert(id.clone(), matches);
    }
    for (id, driver) in drivers {
        let matches = &candidates[id];
        if s(driver, "matchType") == "unmatched"
            && matches.len() == 1
            && claims[&matches[0]] == 1
            && !reserved.contains(&matches[0])
        {
            driver["paycomCode"] = json!(matches[0]);
            driver["matchType"] = json!("name");
        }
    }
}

impl Store {
    pub fn employee_links(&self, id: &str) -> Result<Value> {
        self.dsp(id)?
            .setting(LINKS, json!({"revision":0,"links":[]}))
    }

    pub fn save_employee_links(&self, id: &str, actor: &str, input: &Value) -> Result<Value> {
        v::fields(input, &["revision", "changes"])?;
        let revision = v::integer(input, "revision", 0, i64::MAX - 1)?;
        let changes = input["changes"]
            .as_array()
            .ok_or_else(|| super::Error::new("invalid_input", 400))?;
        ensure(
            !changes.is_empty() && changes.len() <= 5000,
            "invalid_input",
            400,
        )?;
        let paycom = self.collector(id, Provider::Paycom)?;
        let cortex = self.collector(id, Provider::Cortex)?;
        let db = self.dsp(id)?;
        let result = db.transaction(|| {
            let before = db.setting(LINKS, json!({"revision":0,"links":[]}))?;
            ensure(n(&before,"revision") == revision,"settings_changed_reload_before_saving",409)?;
            let mut links = before["links"].as_array().cloned().unwrap_or_default();
            let mut separate = before["separate"].as_array().cloned().unwrap_or_default();
            let mut seen = HashSet::new();
            for change in changes {
                v::fields(change,&["cortexId","paycomCode","automatic"])?;
                let automatic = match change.get("automatic") {
                    None => false,
                    Some(Value::Bool(value)) => *value,
                    _ => return Err(super::Error::new("invalid_input",400)),
                };
                ensure(!automatic || change["paycomCode"].is_null(),"invalid_input",400)?;
                let cortex_id = v::text(change,"cortexId",1,200)?;
                ensure(seen.insert(cortex_id),"duplicate_employee_link",400)?;
                // Unlinking remains possible after a provider's retained records expire.
                links.retain(|link| s(link,"cortexId") != cortex_id);
                separate.retain(|v| v.as_str() != Some(cortex_id));
                if !change["paycomCode"].is_null() {
                    let code = v::text(change,"paycomCode",1,64)?;
                    ensure(paycom.one("SELECT 1 FROM employees WHERE code=? LIMIT 1",[code])?.is_some()
                        && cortex.one("SELECT 1 FROM meal_itineraries WHERE transporter_id=? LIMIT 1",[cortex_id])?.is_some(),"employee_link_source_missing",409)?;
                    links.push(json!({"id":super::crypto::id("employee")?,"cortexId":cortex_id,"paycomCode":code}));
                } else if !automatic {
                    separate.push(json!(cortex_id));
                }
            }
            let mut codes = HashSet::new();
            ensure(links.len() + separate.len() <= 5000 && links.iter().all(|l| codes.insert(s(l,"paycomCode"))),"employee_already_linked",409)?;
            let value = json!({"revision":revision+1,"links":links,"separate":separate});
            db.set(LINKS,&value)?;
            Ok(value)
        })?;
        self.audit(
            Some(actor),
            Some(id),
            "employees.links_updated",
            &format!("Revision {}; {} changes", revision + 1, changes.len()),
        )?;
        Ok(result)
    }

    pub fn meal_comparison(&self, id: &str, date: &str, timezone: &str) -> Result<Value> {
        v::date(date)?;
        let cortex = self.collector(id, Provider::Cortex)?;
        let links = self.employee_links(id)?;
        let (publication, roster, cards) = self.daily_source(id, date)?;
        let mut rows = BTreeMap::new();
        for row in cards {
            if !row["punches"].as_array().is_some_and(|p| {
                p.iter()
                    .any(|p| ["in", "out"].iter().any(|k| !s(p, k).trim().is_empty()))
            }) {
                continue;
            }
            let key = format!("paycom:{}", s(&row, "employeeCode"));
            rows.insert(
                key.clone(),
                json!({"id":key,"name":row["name"],"paycom":row,"cortex":[]}),
            );
        }
        let publications = cortex.all("SELECT id,station,service_area_id serviceAreaId,provider,timezone,collected_at collectedAt FROM meal_publications WHERE report_date=? AND active=1 ORDER BY collected_at DESC,id DESC",[date])?;
        // Broader and narrower provider scopes may observe the same itinerary.
        // The newest observation wins, including a newer snapshot with no meal.
        let mut itineraries = HashSet::new();
        let mut drivers = BTreeMap::new();
        let mut observations = vec![];
        let live = self.live_results(id, Provider::Cortex, date)?;
        for (metadata, captures) in &live {
            for driver in metadata["drivers"].as_array().into_iter().flatten() {
                drivers.insert(s(driver, "id").to_owned(), driver.clone());
            }
            for capture in captures {
                let capture: super::meals::Capture = serde_json::from_value(capture.clone())?;
                let p = json!({"station":capture.scope.station,"serviceAreaId":capture.scope.service_area_id,"timezone":capture.scope.timezone,"collectedAt":super::db::at(capture.finished_at)});
                for route in capture.itineraries {
                    if !itineraries.insert((s(&p, "serviceAreaId").to_owned(), route.id.clone())) {
                        continue;
                    }
                    let itinerary = json!({"itinerary_id":route.id,"transporter_id":route.transporter_id,"driver_name":route.driver});
                    let meals = route
                        .meals
                        .iter()
                        .map(|meal| super::meals::comparison_meal(&route, meal))
                        .collect();
                    drivers.insert(
                        route.transporter_id.clone(),
                        json!({"id":route.transporter_id,"name":route.driver}),
                    );
                    observations.push((p.clone(), itinerary, meals));
                }
            }
        }
        for p in &publications {
            for itinerary in cortex.all("SELECT itinerary_id,transporter_id,driver_name FROM meal_itineraries WHERE publication_id=? ORDER BY itinerary_id",[s(p,"id")])? {
                if !itineraries.insert((s(p,"serviceAreaId").to_owned(),s(&itinerary,"itinerary_id").to_owned())) {continue;}
                let meals = cortex.all("SELECT meal_id mealId,last_delivery_at lastDelivery,started_at start,ended_at end,first_delivery_at firstDelivery,before_status beforeStatus,after_status afterStatus FROM meal_records WHERE publication_id=? AND itinerary_id=? ORDER BY started_at,meal_id",[s(p,"id"),s(&itinerary,"itinerary_id")])?;
                let transporter = s(&itinerary,"transporter_id");
                // Include meal-free drivers in uniqueness checks so a name shared by
                // two drivers cannot match just because one did not take a meal.
                drivers.entry(transporter.to_owned()).or_insert(json!({"id":transporter,"name":itinerary["driver_name"]}));
                observations.push((p.clone(), itinerary, meals));
            }
        }
        match_drivers(&mut drivers, &roster, &links);
        let mut meal_drivers = HashSet::new();
        for (p, itinerary, meals) in observations {
            if meals.is_empty() {
                continue;
            }
            let transporter = s(&itinerary, "transporter_id");
            meal_drivers.insert(transporter.to_owned());
            let code = drivers[transporter]["paycomCode"].as_str();
            let key = code
                .map(|c| format!("paycom:{c}"))
                .unwrap_or_else(|| format!("cortex:{transporter}"));
            let name = code
                .and_then(|c| roster.iter().find(|e| s(e, "code") == c))
                .map(|e| e["name"].clone())
                .unwrap_or(itinerary["driver_name"].clone());
            let row = rows
                .entry(key.clone())
                .or_insert(json!({"id":key,"name":name,"paycom":null,"cortex":[]}));
            for mut meal in meals {
                meal["cortexId"] = json!(transporter);
                meal["driverName"] = itinerary["driver_name"].clone();
                meal["itineraryId"] = itinerary["itinerary_id"].clone();
                meal["station"] = p["station"].clone();
                meal["timezone"] = p["timezone"].clone();
                meal["collectedAt"] = p["collectedAt"].clone();
                row["cortex"].as_array_mut().unwrap().push(meal);
            }
        }
        drivers.retain(|id, _| meal_drivers.contains(id));
        let mut rows: Vec<Value> = rows.into_values().collect();
        for row in &mut rows {
            row["cortex"].as_array_mut().unwrap().sort_by(|a, b| {
                s(a, "start")
                    .cmp(s(b, "start"))
                    .then_with(|| s(a, "mealId").cmp(s(b, "mealId")))
            });
        }
        rows.sort_by(|a, b| {
            workforce::compare(s(a, "name"), s(b, "name")).then_with(|| s(a, "id").cmp(s(b, "id")))
        });
        let latest_zone = cortex.one("SELECT timezone FROM meal_publications WHERE active=1 ORDER BY collected_at DESC,id DESC LIMIT 1",[])?;
        let live_zone = live.first().map(|(meta, _)| &meta["scope"]);
        let zone = live_zone
            .or(publications.first().or(latest_zone.as_ref()))
            .map(|p| s(p, "timezone"))
            .unwrap_or(timezone);
        Ok(
            json!({"date":date,"timezone":zone,"rows":rows,"paycomCollectedAt":publication.map(|p|p["collected_at"].clone()),"cortexPublications":publications,"employees":roster,"drivers":drivers.into_values().collect::<Vec<_>>(),"links":links}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_names_ignore_formatting_but_preserve_name_components() {
        assert_eq!(
            name_key("MOLINA REED, TAYLOR"),
            name_key("Taylor MolinaReed")
        );
        assert_eq!(name_key("O’Neill, Jamie"), name_key("JAMIE O'NEILL"));
        assert_eq!(name_key("Sánchez, René"), name_key("RENÉ SÁNCHEZ"));
        assert_ne!(name_key("Alex Reed"), name_key("Alexander Reed"));
        assert_ne!(name_key("Taylor Reed Jr"), name_key("Taylor Reed"));
        assert_eq!(name_key(" , -- "), "");
    }

    #[test]
    fn manual_links_reserve_targets_and_unrecognized_names_are_not_guessed() {
        let mut drivers: BTreeMap<_, _> = [
            ("one".to_owned(), json!({"name":"Jamie Reed"})),
            ("two".to_owned(), json!({"name":"Different Name"})),
            ("three".to_owned(), json!({"name":"Al Jones"})),
            ("empty".to_owned(), json!({"name":"---"})),
        ]
        .into();
        let roster = vec![
            json!({"code":"E1","name":"REED, JAMIE"}),
            json!({"code":"E2","name":"JONES, ALEXANDER"}),
            json!({"code":"E3","name":""}),
        ];
        match_drivers(
            &mut drivers,
            &roster,
            &json!({"links":[{"cortexId":"two","paycomCode":"E1"}]}),
        );
        assert_eq!(drivers["one"]["matchType"], "unmatched");
        assert_eq!(drivers["two"]["matchType"], "saved");
        assert_eq!(drivers["three"]["matchType"], "unmatched");
        assert_eq!(drivers["empty"]["matchType"], "unmatched");
        match_drivers(
            &mut drivers,
            &roster,
            &json!({"links":[],"separate":["one"]}),
        );
        assert_eq!(drivers["one"]["matchType"], "separate");
        match_drivers(&mut drivers, &roster, &json!({"links":[]}));
        assert_eq!(drivers["one"]["paycomCode"], "E1");
    }

    fn matches(names: &[&str], employees: &[&str], settings: Value) -> Vec<Value> {
        let mut drivers = names
            .iter()
            .enumerate()
            .map(|(i, name)| (format!("D{i}"), json!({"name":name})))
            .collect();
        let roster = employees
            .iter()
            .enumerate()
            .map(|(i, name)| json!({"code":format!("E{i}"),"name":name}))
            .collect::<Vec<_>>();
        match_drivers(&mut drivers, &roster, &settings);
        drivers.into_values().collect()
    }

    #[test]
    fn unique_name_variants_match_in_both_directions() {
        for (left, right) in [
            ("Jamie Reed Vega", "REED, JAMIE"),
            ("Casey Molina Solis", "MOLINA, CASEY"),
            ("Alexander Stone", "STONE, ALEX"),
            ("Taylor Hart Jr.", "HART, TAYLOR"),
            ("Morgan Hill III", "HILL, MORGAN"),
            ("René O’Neill Cruz", "O'NEILL, RENÉ"),
            ("Taylor MolinaReed Vega", "MOLINA REED, TAYLOR"),
        ] {
            for (driver, employee) in [(left, right), (right, left)] {
                let result = matches(&[driver], &[employee], json!({}));
                assert_eq!(result[0]["paycomCode"], "E0", "{driver} / {employee}");
                assert_eq!(result[0]["matchType"], "name");
            }
        }
    }

    #[test]
    fn variants_require_complete_name_components_and_compatible_suffixes() {
        for (driver, employee) in [
            ("Alex Stone", "Alexis Stone"),
            ("Alex Stone", "Alexandra Stone"),
            ("Jamie Reed", "Jamie Reeder"),
            ("Jamie Reed Vega", "Jamie Reed Cruz"),
            ("Jamie Reed Jr", "Jamie Reed Sr"),
            ("Jamie Reed II", "Jamie Reed III"),
            ("Jamie Reed", "J Reed"),
            ("Jamie", "Jamie Reed"),
            ("Reed", "Reed Jamie"),
        ] {
            assert_eq!(
                matches(&[driver], &[employee], json!({}))[0]["paycomCode"],
                Value::Null,
                "{driver} / {employee}"
            );
        }
    }

    #[test]
    fn variants_must_be_unique_across_both_complete_rosters() {
        let drivers = ["Jamie Reed Vega", "Jamie Reed Cruz"];
        let employees = ["REED, JAMIE"];
        for settings in [
            json!({}),
            json!({"separate":["D1"]}),
            json!({"links":[{"cortexId":"D1","paycomCode":"E1"}]}),
        ] {
            let result = matches(&drivers, &employees, settings);
            assert_eq!(result[0]["matchType"], "unmatched");
        }
        let result = matches(
            &["Jamie Reed"],
            &["REED VEGA, JAMIE", "REED CRUZ, JAMIE"],
            json!({}),
        );
        assert_eq!(result[0]["matchType"], "unmatched");
        let result = matches(
            &["Alexander Stone"],
            &["STONE, ALEX", "STONE, ALEX"],
            json!({}),
        );
        assert_eq!(result[0]["matchType"], "unmatched");
    }

    #[test]
    fn exact_matches_and_saved_choices_take_priority_over_variants() {
        let result = matches(
            &["Jamie Reed", "Jamie Reed Vega"],
            &["REED, JAMIE"],
            json!({}),
        );
        assert_eq!(result[0]["paycomCode"], "E0");
        assert_eq!(result[1]["matchType"], "unmatched");
        let result = matches(
            &["Jamie Reed Vega"],
            &["REED, JAMIE", "REED VEGA, JAMIE"],
            json!({}),
        );
        assert_eq!(result[0]["paycomCode"], "E1");
        let drivers = ["Jamie Reed Vega", "Different Person"];
        let employees = ["REED, JAMIE"];
        let result = matches(
            &drivers,
            &employees,
            json!({"links":[{"cortexId":"D1","paycomCode":"E0"}]}),
        );
        assert_eq!(result[0]["matchType"], "unmatched");
        assert_eq!(result[1]["matchType"], "saved");
        assert_eq!(
            matches(&drivers, &employees, json!({"separate":["D0"]}))[0]["matchType"],
            "separate"
        );
        assert_eq!(
            matches(&drivers, &employees, json!({}))[0]["paycomCode"],
            "E0"
        );
    }
}
