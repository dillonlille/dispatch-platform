use crate::{
    Result,
    db::{Store, at, flag, iso, n, now, s},
};
use serde_json::{Value, json};
const EXPORT_LIMIT: i64 = 50_000;
const VISIT_WINDOW: i64 = 30 * 60 * 1000;
// Activity older than a year is removed by the collector's periodic cleanup.
const AUDIT_RETENTION: i64 = 365 * 24 * 60 * 60 * 1000;
// Managing a DSP from the platform is never part of that DSP's own log.
const PLATFORM_ONLY: [&str; 8] = [
    "dsp.created",
    "dsp.removed",
    "dsp.restored",
    "dsp.suspended",
    "dsp.resumed",
    "dsp.support_visibility_changed",
    "diagnostics.fixtures_loaded",
    "development.fixtures_loaded",
];
impl Store {
    pub fn audit(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
    ) -> Result<()> {
        self.audit_with(actor, dsp, action, detail, None, &[])
    }
    // Names are stored as text so the event still reads after its subject is deleted.
    pub fn audit_with(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
        target: Option<&str>,
        changes: &[AuditChange],
    ) -> Result<()> {
        self.audit_ref(actor, dsp, action, detail, target, changes, None)
    }
    // A reference names the record an event is about, so the log can gather
    // everything involving it even after a rename.
    #[allow(clippy::too_many_arguments)]
    pub fn audit_ref(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
        target: Option<&str>,
        changes: &[AuditChange],
        reference: Option<(&str, &str)>,
    ) -> Result<()> {
        let data = (target.is_some() || !changes.is_empty() || reference.is_some()).then(|| {
            json!({"target":target,"ref":reference.map(|(kind,id)|json!({"kind":kind,"id":id})),"changes":changes.iter().map(|(field,from,to)|json!({"field":field,"from":from,"to":to})).collect::<Vec<_>>()}).to_string()
        });
        let shown = self.shown(actor, dsp, action)?;
        self.platform.exec(
            "INSERT INTO audit(at,actor_id,dsp_id,action,detail,data,shown) VALUES (?,?,?,?,?,?,?)",
            rusqlite::params![iso(), actor, dsp, action, detail, data, shown.then_some(1)],
        )?;
        Ok(())
    }
    // Decided as the event is written, so a visit made while hidden stays hidden.
    fn shown(&self, actor: Option<&str>, dsp: Option<&str>, action: &str) -> Result<bool> {
        Ok(match (actor, dsp) {
            (Some(actor), Some(dsp)) if !PLATFORM_ONLY.contains(&action) => {
                self.platform_owner(actor)? && self.support_visible(dsp)
            }
            _ => false,
        })
    }
    // Opening a DSP happens on every load; one entry per half hour says as much.
    // A hidden visit does not stand in for one the DSP would now be shown.
    pub fn audit_visit(&self, actor: &str, dsp: &str, action: &str, detail: &str) -> Result<()> {
        let shown = self.shown(Some(actor), Some(dsp), action)?;
        let recent = self.platform.one(
            "SELECT 1 FROM audit WHERE actor_id=? AND dsp_id=? AND action=? AND detail=? AND at>=? AND COALESCE(shown,0)=? LIMIT 1",
            rusqlite::params![actor, dsp, action, detail, at(now() - VISIT_WINDOW), shown],
        )?;
        if recent.is_some() {
            return Ok(());
        }
        self.audit(Some(actor), Some(dsp), action, detail)
    }
    // Taking a copy of everyone's activity is itself recorded, after the copy is
    // read so an export never lists itself.
    pub fn audit_export(&self, actor: &str, query: AuditQuery) -> Result<Value> {
        let page = self.audit_page(&AuditQuery {
            before: 0,
            limit: EXPORT_LIMIT,
            ..query
        })?;
        let rows = page["events"].as_array().map_or(0, Vec::len);
        let scope = if query.within.is_empty() {
            query.dsp
        } else {
            Some(query.within)
        };
        self.audit(Some(actor), scope, "audit.exported", &rows.to_string())?;
        Ok(page)
    }
    pub fn prune_audit(&self) -> Result<usize> {
        self.platform.exec(
            "DELETE FROM audit WHERE at<?",
            [at(now() - AUDIT_RETENTION)],
        )
    }
    pub fn platform_owner(&self, user: &str) -> Result<bool> {
        Ok(self
            .platform
            .one(
                "SELECT 1 FROM users WHERE id=? AND platform_owner=1",
                [user],
            )?
            .is_some())
    }
    pub fn support_visible(&self, dsp: &str) -> bool {
        self.profile(dsp)
            .is_ok_and(|profile| flag(&profile, "supportVisible"))
    }
    // A DSP's log lists its members' and the system's actions. A platform owner's
    // appear only where the DSP shows Platform support, and never under their name.
    pub fn audit_page(&self, query: &AuditQuery) -> Result<Value> {
        // Inside a DSP a platform owner is only ever "Platform support".
        const SUPPORT: &str = "(?1 IS NOT NULL AND COALESCE(u.platform_owner,0)=1)";
        const FROM: &str = "FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN dsps d ON d.id=a.dsp_id WHERE (?1 IS NULL OR (a.dsp_id=?1 AND (COALESCE(u.platform_owner,0)=0 OR a.shown=1)))";
        let name = format!(
            "CASE WHEN {SUPPORT} THEN 'Platform support' ELSE COALESCE(u.first_name||' '||u.last_name,a.actor_name,'System') END"
        );
        let actor = format!(
            "CASE WHEN {SUPPORT} THEN 'support' ELSE COALESCE(a.actor_id,CASE WHEN a.actor_name IS NULL THEN 'system' ELSE 'name:'||a.actor_name END) END"
        );
        const AREA: &str = "CASE WHEN a.action LIKE 'member.%' OR a.action LIKE 'invitation.%' THEN 'team' WHEN a.action LIKE 'role.%' THEN 'roles' WHEN a.action LIKE 'collection.%' OR a.action LIKE 'cortex.collection.%' OR a.action LIKE 'meal_breaks.%' THEN 'collections' WHEN a.action LIKE 'schedule.%' THEN 'schedules' WHEN a.action LIKE 'connection.%' THEN 'connections' WHEN a.action IN ('dsp.view_opened','dsp.owner_view_opened') THEN CASE WHEN ?1 IS NULL THEN 'access' ELSE 'team' END WHEN a.action LIKE 'account.%' THEN 'access' WHEN a.action IN ('dsp.created','dsp.removed','dsp.restored','dsp.suspended','dsp.resumed') THEN 'dsps' ELSE 'settings' END";
        const FAILED: &str = "a.action LIKE '%.failed'";
        let filters = format!(
            "{FROM} AND (?2='' OR a.at>=?2) AND (?3='' OR {actor}=?3) AND (?4='' OR a.action LIKE ?4 ESCAPE '\\' OR a.detail LIKE ?4 ESCAPE '\\' OR COALESCE(a.data,'') LIKE ?4 ESCAPE '\\' OR {name} LIKE ?4 ESCAPE '\\' OR COALESCE(d.name,'') LIKE ?4 ESCAPE '\\') AND (?5='' OR a.dsp_id=?5) AND ((?6='' AND ?7='') OR (?6<>'' AND json_extract(a.data,'$.ref.kind')||':'||json_extract(a.data,'$.ref.id')=?6) OR (?7<>'' AND json_extract(a.data,'$.target')=?7))"
        );
        let area = format!("(?8='' OR (?8='failures' AND {FAILED}) OR {AREA}=?8)");
        let search = if query.q.is_empty() {
            String::new()
        } else {
            format!(
                "%{}%",
                query
                    .q
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        };
        let mut events = self.platform.all(&format!("SELECT a.id,a.at,CASE WHEN {SUPPORT} THEN NULL ELSE a.actor_id END actorId,{name} actorName,a.dsp_id dspId,d.name dspName,a.action,a.detail,a.data,{AREA} area {filters} AND {area} AND (?9=0 OR a.id<?9) ORDER BY a.id DESC LIMIT ?10"),rusqlite::params![query.dsp,query.from,query.actor,search,query.within,query.subject,query.named,query.area,query.before,query.limit])?;
        for event in &mut events {
            let data = event["data"]
                .as_str()
                .and_then(|data| serde_json::from_str::<Value>(data).ok())
                .unwrap_or(Value::Null);
            event["target"] = data["target"].clone();
            event["ref"] = data["ref"].clone();
            event["changes"] = if data["changes"].is_array() {
                data["changes"].clone()
            } else {
                json!([])
            };
            event.as_object_mut().unwrap().remove("data");
        }
        let total = self.platform.one(
            &format!("SELECT count(*) count {filters} AND {area}"),
            rusqlite::params![
                query.dsp,
                query.from,
                query.actor,
                search,
                query.within,
                query.subject,
                query.named,
                query.area
            ],
        )?;
        let mut counts = serde_json::Map::new();
        let mut failures = 0;
        for row in self.platform.all(
            &format!(
                "SELECT {AREA} area,count(*) count,sum({FAILED}) failures {filters} GROUP BY 1"
            ),
            rusqlite::params![
                query.dsp,
                query.from,
                query.actor,
                search,
                query.within,
                query.subject,
                query.named
            ],
        )? {
            counts.insert(s(&row, "area").to_owned(), json!(n(&row, "count")));
            failures += n(&row, "failures");
        }
        counts.insert("failures".into(), json!(failures));
        let actors = self.platform.all(
            &format!("SELECT DISTINCT {actor} id,{name} name {FROM} ORDER BY 2"),
            rusqlite::params![query.dsp],
        )?;
        // The platform's log spans every DSP, so it can be narrowed to one.
        let dsps = if query.dsp.is_none() {
            self.platform.all("SELECT DISTINCT d.id,d.name FROM audit a JOIN dsps d ON d.id=a.dsp_id ORDER BY d.name", [])?
        } else {
            Vec::new()
        };
        Ok(
            json!({"events":events,"total":n(&total.unwrap(),"count"),"counts":counts,"actors":actors,"dsps":dsps}),
        )
    }
}
// A changed field with its previous and new value; either side may be absent.
pub type AuditChange = (&'static str, Option<String>, Option<String>);
pub struct AuditQuery<'a> {
    pub dsp: Option<&'a str>,
    pub area: &'a str,
    pub actor: &'a str,
    pub q: &'a str,
    pub from: &'a str,
    pub before: i64,
    pub limit: i64,
    // One DSP within the platform's log.
    pub within: &'a str,
    // Events about one subject: its "kind:id" reference, or the name older events kept.
    pub subject: &'a str,
    pub named: &'a str,
}
impl Default for AuditQuery<'_> {
    fn default() -> Self {
        Self {
            dsp: None,
            area: "",
            actor: "",
            q: "",
            from: "",
            before: 0,
            limit: 50,
            within: "",
            subject: "",
            named: "",
        }
    }
}
