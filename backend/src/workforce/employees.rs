use super::preferences::preferences;
use crate::{
    Result,
    collectors::Provider,
    db::{Store, boolean, s},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::cmp::Ordering;
pub(crate) fn display_name(name: &str, order: &str) -> String {
    let parts: Vec<_> = name
        .split(|c: char| c.is_whitespace() && c != '\u{0085}' || c == '\u{feff}')
        .filter(|s| !s.is_empty())
        .collect();
    if order == "last_first" && parts.len() > 1 {
        format!(
            "{}, {}",
            parts.last().unwrap(),
            parts[..parts.len() - 1].join(" ")
        )
    } else {
        name.into()
    }
}
pub(crate) fn compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: std::sync::OnceLock<icu_collator::CollatorBorrowed<'static>> =
        std::sync::OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled Unicode collation data")
        })
        .compare(a, b)
}

impl Store {
    pub fn employees(
        &self,
        id: &str,
        query: &str,
        offset: usize,
        limit: Option<usize>,
        desc: bool,
        active: Option<bool>,
    ) -> Result<Value> {
        let db = self.collector(id, Provider::Paycom)?;
        let settings = preferences(&db)?;
        let p = &settings["values"];
        let Some(publication) = db.one(
            "SELECT id,collected_at FROM publications WHERE active=1",
            [],
        )?
        else {
            return Ok(json!({"employees":[],"total":0,"collectedAt":null}));
        };
        let publication_id = s(&publication, "id");
        let direction = if desc { "DESC" } else { "ASC" };
        let condition = "publication_id=?1 AND (?2='' OR department=?2) AND (?3='' OR \
            station=?3) AND (?4='' OR instr(dispatch_lower(dispatch_name(name,?5)||' '||code),?4)>0) \
            AND (?6 IS NULL OR active=?6)";
        let total = db.count(
            &format!("SELECT count(*) FROM employees WHERE {condition}"),
            params![
                publication_id,
                s(p, "department"),
                s(p, "station"),
                query.to_lowercase(),
                s(p, "name_order"),
                active
            ],
        )?;
        let mut rows = db.all(
            &format!(
                "SELECT code,dispatch_name(name,?5) \
            name,department,position,station,active FROM employees WHERE {condition} ORDER \
            BY name COLLATE dispatch_unicode {direction},code COLLATE dispatch_unicode \
            {direction} LIMIT ?7 OFFSET \
            ?8"
            ),
            params![
                publication_id,
                s(p, "department"),
                s(p, "station"),
                query.to_lowercase(),
                s(p, "name_order"),
                active,
                limit.map_or(-1, |value| value as i64),
                offset as i64
            ],
        )?;
        for row in &mut rows {
            boolean(row, &["active"]);
        }
        Ok(json!({"employees":rows,"total":total,"collectedAt":publication["collected_at"]}))
    }
}
