//! Read-only comparison across provider snapshots. Only confirmed employee links
//! live in DSP-wide storage; source records remain owned by their collectors.
use super::{
    Result,
    collectors::Provider,
    db::{Store, n, s},
    ensure, validate as v, workforce,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

const LINKS: &str = "employees.provider_links";

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
            let mut seen = HashSet::new();
            for change in changes {
                v::fields(change,&["cortexId","paycomCode"])?;
                let cortex_id = v::text(change,"cortexId",1,200)?;
                ensure(seen.insert(cortex_id),"duplicate_employee_link",400)?;
                // Unlinking remains possible after a provider's retained records expire.
                links.retain(|link| s(link,"cortexId") != cortex_id);
                if !change["paycomCode"].is_null() {
                    let code = v::text(change,"paycomCode",1,64)?;
                    ensure(paycom.one("SELECT 1 FROM employees WHERE code=? LIMIT 1",[code])?.is_some()
                        && cortex.one("SELECT 1 FROM meal_itineraries WHERE transporter_id=? LIMIT 1",[cortex_id])?.is_some(),"employee_link_source_missing",409)?;
                    links.push(json!({"id":super::crypto::id("employee")?,"cortexId":cortex_id,"paycomCode":code}));
                }
            }
            let mut codes = HashSet::new();
            ensure(links.len() <= 5000 && links.iter().all(|l| codes.insert(s(l,"paycomCode"))),"employee_already_linked",409)?;
            let value = json!({"revision":revision+1,"links":links});
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
        let paycom = self.collector(id, Provider::Paycom)?;
        let cortex = self.collector(id, Provider::Cortex)?;
        let links = self.employee_links(id)?;
        let publication = paycom.one("SELECT id,collected_at FROM publications WHERE period_from<=? AND period_to>=? ORDER BY collected_at DESC,id DESC LIMIT 1",[date,date])?;
        let roster = if let Some(p) = &publication {
            paycom.all(
                "SELECT code,name FROM employees WHERE publication_id=? ORDER BY name,code",
                [s(p, "id")],
            )?
        } else {
            vec![]
        };
        let mut rows = BTreeMap::new();
        if let Some(p) = &publication {
            for mut row in paycom.all("SELECT e.code employeeCode,e.name,t.status,t.punches FROM timecards t JOIN employees e ON e.publication_id=t.publication_id AND e.code=t.employee_code WHERE t.publication_id=? AND t.date=?",[s(p,"id"),date])? {
                let punches: Value = serde_json::from_str(s(&row,"punches"))?;
                if !punches.as_array().is_some_and(|p| p.iter().any(|p| ["in","out"].iter().any(|k| !s(p,k).trim().is_empty()))) {continue;}
                row["punches"] = punches;
                let key = format!("paycom:{}",s(&row,"employeeCode"));
                rows.insert(key.clone(),json!({"id":key,"name":row["name"],"paycom":row,"cortex":[]}));
            }
        }
        let publications = cortex.all("SELECT id,station,service_area_id serviceAreaId,provider,timezone,collected_at collectedAt FROM meal_publications WHERE report_date=? AND active=1 ORDER BY collected_at DESC,id DESC",[date])?;
        // Broader and narrower provider scopes may observe the same itinerary.
        // The newest observation wins, including a newer snapshot with no meal.
        let mut itineraries = HashSet::new();
        let mut drivers = BTreeMap::new();
        for p in &publications {
            for itinerary in cortex.all("SELECT itinerary_id,transporter_id,driver_name FROM meal_itineraries WHERE publication_id=? ORDER BY itinerary_id",[s(p,"id")])? {
                if !itineraries.insert((s(p,"serviceAreaId").to_owned(),s(&itinerary,"itinerary_id").to_owned())) {continue;}
                let meals = cortex.all("SELECT meal_id mealId,last_delivery_at lastDelivery,started_at start,ended_at end,first_delivery_at firstDelivery,before_status beforeStatus,after_status afterStatus FROM meal_records WHERE publication_id=? AND itinerary_id=? ORDER BY started_at,meal_id",[s(p,"id"),s(&itinerary,"itinerary_id")])?;
                if meals.is_empty() {continue;}
                let transporter = s(&itinerary,"transporter_id");
                drivers.entry(transporter.to_owned()).or_insert(json!({"id":transporter,"name":itinerary["driver_name"]}));
                let linked = links["links"].as_array().unwrap().iter().find(|l| s(l,"cortexId") == transporter);
                let key = linked.map(|l| format!("paycom:{}",s(l,"paycomCode"))).unwrap_or_else(||format!("cortex:{transporter}"));
                let name = linked.and_then(|l| roster.iter().find(|e| e["code"] == l["paycomCode"])).map(|e| e["name"].clone()).unwrap_or(itinerary["driver_name"].clone());
                let row = rows.entry(key.clone()).or_insert(json!({"id":key,"name":name,"paycom":null,"cortex":[]}));
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
        }
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
        let zone = publications
            .first()
            .or(latest_zone.as_ref())
            .map(|p| s(p, "timezone"))
            .unwrap_or(timezone);
        Ok(
            json!({"date":date,"timezone":zone,"rows":rows,"paycomCollectedAt":publication.map(|p|p["collected_at"].clone()),"cortexPublications":publications,"employees":roster,"drivers":drivers.into_values().collect::<Vec<_>>(),"links":links}),
        )
    }
}
