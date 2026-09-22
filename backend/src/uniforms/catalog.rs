use super::{advance, catalog_event, revision, templates, uniform};
use crate::{
    Result,
    accounts::Context,
    contracts::{UniformInput, UniformInventory},
    crypto,
    db::Store,
    ensure,
};
use rusqlite::params;
use std::collections::HashSet;

impl Store {
    pub fn initialize_uniforms(&self, c: &Context, starter: bool) -> Result<UniformInventory> {
        let db = self.dsp(&c.dsp.id)?;
        db.transaction(|| {
            ensure(revision(&db)? == 0, "uniform_inventory_initialized", 409)?;
            let revision = advance(&db)?;
            if starter {
                templates::insert(&db, revision)?;
            }
            catalog_event(&db, c, revision, "initialized", None)
        })?;
        self.uniform_inventory(&c.dsp.id)
    }
    pub fn save_uniform(
        &self,
        c: &Context,
        id: Option<&str>,
        input: &UniformInput,
    ) -> Result<UniformInventory> {
        let db = self.dsp(&c.dsp.id)?;
        db.transaction(|| {
            let before = id.map(|id| uniform(&db, id)).transpose()?;
            if let Some(before) = &before {
                ensure(input.revision == Some(before.revision), "uniform_changed", 409)?;
            } else {
                ensure(input.revision.is_none(), "invalid_input", 400)?;
                ensure(db.count("SELECT count(*) FROM uniforms WHERE archived=0", [])? < 200, "uniform_limit", 409)?;
            }
            let id = id.map(str::to_owned).map(Ok).unwrap_or_else(|| crypto::id("uniform"))?;
            ensure(db.count(
                "SELECT count(*) FROM uniforms WHERE name=? COLLATE NOCASE AND archived=0 AND id!=?",
                [&input.name, &id],
            )? == 0, "uniform_name_taken", 409)?;
            let existing = before.as_ref().map(|u| u.variants.as_slice()).unwrap_or_default();
            let retained: HashSet<_> = input.variants.iter().filter_map(|v| v.id.as_deref()).collect();
            for variant in existing {
                ensure(retained.contains(variant.id.as_str()) || variant.quantity == 0, "uniform_size_in_stock", 409)?;
            }
            for variant in &input.variants {
                ensure(variant.id.as_ref().is_none_or(|id| existing.iter().any(|v| &v.id == id)), "uniform_size_not_found", 409)?;
            }
            let revision = advance(&db)?;
            if before.is_some() {
                db.exec("UPDATE uniforms SET name=?,category=?,revision=? WHERE id=?",
                    params![input.name,input.category,revision,id])?;
                // Retiring first also allows two existing sizes to exchange labels safely.
                db.exec("UPDATE uniform_variants SET archived=1 WHERE uniform_id=?", [&id])?;
            } else {
                let position = db.count("SELECT COALESCE(MAX(position),-1)+1 FROM uniforms", [])?;
                db.exec("INSERT INTO uniforms (id,name,category,revision,position) VALUES (?,?,?,?,?)",
                    params![id,input.name,input.category,revision,position])?;
            }
            for (position, variant) in input.variants.iter().enumerate() {
                if let Some(key) = &variant.id {
                    db.exec("UPDATE uniform_variants SET fit=?,size=?,revision=?,position=?,archived=0 WHERE id=?",
                        params![variant.fit,variant.size,revision,position as i64,key])?;
                } else {
                    db.exec("INSERT INTO uniform_variants (id,uniform_id,fit,size,revision,position) VALUES (?,?,?,?,?,?)",
                        params![crypto::id("size")?,id,variant.fit,variant.size,revision,position as i64])?;
                }
            }
            catalog_event(&db, c, revision, if before.is_some() { "updated" } else { "created" }, Some(&uniform(&db,&id)?))
        })?;
        self.uniform_inventory(&c.dsp.id)
    }
    pub fn archive_uniform(
        &self,
        c: &Context,
        id: &str,
        expected: i64,
    ) -> Result<UniformInventory> {
        let db = self.dsp(&c.dsp.id)?;
        db.transaction(|| {
            let before = uniform(&db, id)?;
            ensure(before.revision == expected, "uniform_changed", 409)?;
            ensure(
                before.variants.iter().all(|v| v.quantity == 0),
                "uniform_in_stock",
                409,
            )?;
            let revision = advance(&db)?;
            db.exec(
                "UPDATE uniforms SET archived=1,revision=? WHERE id=?",
                params![revision, id],
            )?;
            db.exec(
                "UPDATE uniform_variants SET archived=1 WHERE uniform_id=?",
                [id],
            )?;
            catalog_event(&db, c, revision, "archived", Some(&before))
        })?;
        self.uniform_inventory(&c.dsp.id)
    }
}
