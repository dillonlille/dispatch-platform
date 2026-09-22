use super::{actor_name, advance};
use crate::{
    Error, Result,
    accounts::Context,
    contracts::UniformAdjustment,
    db::{Store, iso},
    ensure,
};
use rusqlite::params;

impl Store {
    pub fn adjust_uniform(
        &self,
        c: &Context,
        variant: &str,
        delta: i32,
        request_id: &str,
    ) -> Result<UniformAdjustment> {
        ensure(delta == 1 || delta == -1, "invalid_input", 400)?;
        ensure((16..=100).contains(&request_id.len()), "invalid_input", 400)?;
        let db = self.dsp(&c.dsp.id)?;
        db.transaction(|| {
            if let Some((actor,)) = db.one_as::<(String,)>(
                "SELECT actor_id FROM uniform_events WHERE request_id=?", [request_id],
            )? {
                ensure(actor == c.auth.user.id.as_str(), "uniform_request_conflict", 409)?;
                return db.one_as(
                    "SELECT revision,variant_id,quantity FROM uniform_events WHERE request_id=? AND variant_id=? AND delta=?",
                    params![request_id,variant,delta],
                )?.ok_or_else(|| Error::new("uniform_request_conflict", 409));
            }
            let item = db.one_as::<(String, String)>(
                "SELECT u.id,u.name FROM uniform_variants v JOIN uniforms u ON u.id=v.uniform_id \
                 WHERE v.id=? AND v.archived=0 AND u.archived=0", [variant],
            )?.ok_or_else(|| Error::new("uniform_size_not_found", 404))?;
            let revision = advance(&db)?;
            // The bound is checked in the same statement as the delta, under the write transaction.
            let changed = db.exec(
                "UPDATE uniform_variants SET quantity=quantity+?1,revision=?2 \
                 WHERE id=?3 AND archived=0 AND quantity+?1 BETWEEN 0 AND 1000000",
                params![delta,revision,variant],
            )?;
            ensure(changed == 1, if delta < 0 { "uniform_out_of_stock" } else { "uniform_quantity_limit" }, 409)?;
            db.exec(
                "INSERT INTO uniform_events \
                 (revision,kind,uniform_id,uniform_name,variant_id,fit,size,delta,quantity,actor_id,actor_name,request_id,at) \
                 SELECT ?1,'adjusted',?2,?3,id,fit,size,?4,quantity,?5,?6,?7,?8 FROM uniform_variants WHERE id=?9",
                params![revision,item.0,item.1,delta,c.auth.user.id,actor_name(c),request_id,iso(),variant],
            )?;
            db.one_as("SELECT revision,variant_id,quantity FROM uniform_events WHERE revision=?", [revision])?
                .ok_or_else(|| Error::new("invalid_stored_record", 500))
        })
    }
}
