//! A DSP owns its catalog, quantities and durable change journal in one database.
//! Quantity writes are deltas; catalog edits never accept or replace stock counts.
mod catalog;
mod stock;
mod templates;

use crate::{
    Error, Result,
    accounts::Context,
    contracts::{Uniform, UniformHistory, UniformInventory, UniformUpdates, UniformVariant},
    db::{Db, FromRow, Row, Store, iso},
};
use rusqlite::params;
use std::collections::HashMap;

struct StoredVariant {
    uniform_id: String,
    variant: UniformVariant,
}
impl FromRow for StoredVariant {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            uniform_id: row.get("uniform_id")?,
            variant: UniformVariant::from_row(row)?,
        })
    }
}

pub(super) fn revision(db: &Db) -> Result<i64> {
    db.count("SELECT revision FROM uniform_inventory WHERE id=1", [])
}
pub(super) fn advance(db: &Db) -> Result<i64> {
    db.exec(
        "UPDATE uniform_inventory SET revision=revision+1 WHERE id=1",
        [],
    )?;
    revision(db)
}
pub(super) fn actor_name(c: &Context) -> String {
    if c.auth.user.platform_owner {
        "Platform support".into()
    } else {
        c.auth.user.name()
    }
}
pub(super) fn catalog_event(
    db: &Db,
    c: &Context,
    revision: i64,
    kind: &str,
    uniform: Option<&Uniform>,
) -> Result<()> {
    db.exec(
        "INSERT INTO uniform_events (revision,kind,uniform_id,uniform_name,actor_id,actor_name,at) VALUES (?,?,?,?,?,?,?)",
        params![revision, kind, uniform.map(|u| &u.id), uniform.map_or("", |u| u.name.as_str()), c.auth.user.id, actor_name(c), iso()],
    )?;
    Ok(())
}
pub(super) fn uniform(db: &Db, id: &str) -> Result<Uniform> {
    let mut item = db
        .one_as::<Uniform>("SELECT * FROM uniforms WHERE id=? AND archived=0", [id])?
        .ok_or_else(|| Error::new("uniform_not_found", 404))?;
    item.variants = db.query_as(
        "SELECT * FROM uniform_variants WHERE uniform_id=? AND archived=0 ORDER BY position,id",
        [id],
    )?;
    Ok(item)
}
fn inventory(db: &Db) -> Result<UniformInventory> {
    let mut uniforms: Vec<Uniform> = db.query_as(
        "SELECT * FROM uniforms WHERE archived=0 ORDER BY position,id",
        [],
    )?;
    let indices: HashMap<_, _> = uniforms
        .iter()
        .enumerate()
        .map(|(i, u)| (u.id.clone(), i))
        .collect();
    // One read for all variants, regardless of how many uniforms the DSP created.
    for row in db.query_as::<StoredVariant>(
        "SELECT * FROM uniform_variants WHERE archived=0 ORDER BY position,id",
        [],
    )? {
        if let Some(index) = indices.get(&row.uniform_id) {
            uniforms[*index].variants.push(row.variant);
        }
    }
    Ok(UniformInventory {
        revision: revision(db)?,
        uniforms,
    })
}
impl Store {
    pub fn uniform_inventory(&self, dsp: &str) -> Result<UniformInventory> {
        let db = self.dsp(dsp)?;
        db.transaction(|| inventory(&db))
    }
    pub fn uniform_updates(&self, dsp: &str, after: i64) -> Result<UniformUpdates> {
        let db = self.dsp(dsp)?;
        db.transaction(|| {
            let current = revision(&db)?;
            // A catalog edit or a long absence uses one authoritative snapshot.
            let reset = after < 0 || after > current || current - after > 200 || db.count(
                "SELECT EXISTS(SELECT 1 FROM uniform_events WHERE revision>? AND kind!='adjusted')", [after],
            )? != 0;
            Ok(UniformUpdates {
                revision: current,
                inventory: if reset { Some(inventory(&db)?) } else { None },
                adjustments: if reset { vec![] } else { db.query_as(
                    "SELECT revision,variant_id,quantity FROM uniform_events WHERE revision>? ORDER BY revision", [after],
                )? },
            })
        })
    }
    pub fn uniform_history(&self, dsp: &str, before: i64) -> Result<UniformHistory> {
        let db = self.dsp(dsp)?;
        let mut events = db.query_as::<crate::contracts::UniformEvent>(
            "SELECT * FROM uniform_events WHERE revision<? ORDER BY revision DESC LIMIT 51",
            [before],
        )?;
        let more = events.len() > 50;
        events.truncate(50);
        Ok(UniformHistory {
            next_before: if more {
                events.last().map(|e| e.revision)
            } else {
                None
            },
            events,
        })
    }
}
