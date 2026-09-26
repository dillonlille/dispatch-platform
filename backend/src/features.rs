//! What a DSP may use. A feature is a page with the permissions it owns, or a
//! connection to a provider. The platform owner switches features per DSP: a
//! switched-off feature's pages, permissions and automation do not exist for
//! that DSP, and nothing it stored is touched, so switching it back on restores
//! everything. Connections come from the collector registry, each providing a
//! capability; a page requires capabilities, never a provider by name.
use super::{
    Result,
    audit::AuditChange,
    collectors::Provider,
    contracts::{DspFeatureReport, DspFeatures, DspStatus, FeatureChange, FeatureState},
    db::{FromRow, Row, Store, iso},
    ensure, job_statuses,
};
use rusqlite::params;
use std::{collections::BTreeMap, sync::LazyLock};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Page,
    Connection,
}
#[derive(Clone, Copy, Debug)]
pub struct Feature {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    /// The permissions this feature owns. Without it, nobody in the DSP holds them.
    pub permissions: &'static [&'static str],
    /// What a connection supplies, such as timecards.
    pub provides: Option<&'static str>,
    /// What a page needs one enabled provider of.
    pub requires: &'static [&'static str],
    /// Whether a DSP gets it when created, or while it has no row of its own.
    pub default: bool,
}
// Every page. Connections are listed by the collector registry below.
pub const PAGES: &[Feature] = &[
    Feature {
        id: "timecard",
        label: "Timecard",
        kind: Kind::Page,
        permissions: &["timecard.view", "timecard.manage", "collections.run"],
        provides: None,
        requires: &["timecards", "meal_breaks"],
        default: false,
    },
    Feature {
        id: "uniforms",
        label: "Uniform Inventory",
        kind: Kind::Page,
        permissions: &["uniforms.view", "uniforms.adjust", "uniforms.manage"],
        provides: None,
        requires: &[],
        default: false,
    },
];
/// The page whose schedules, collections and jobs run. Nothing collects without it.
pub const SCHEDULES: &str = "timecard";
/// The permission every connection shares; it exists while any connection does.
const CONNECTIONS: &str = "connections.manage";

fn connection(provider: Provider) -> Feature {
    let collector = provider.collector();
    Feature {
        id: collector.id(),
        label: collector.label(),
        kind: Kind::Connection,
        permissions: &[],
        provides: Some(collector.capability()),
        requires: &[],
        default: false,
    }
}
/// The catalog, pages first, then every registered connection.
static CATALOG: LazyLock<Vec<Feature>> = LazyLock::new(|| {
    PAGES
        .iter()
        .copied()
        .chain(Provider::ALL.iter().map(|p| connection(*p)))
        .collect()
});
pub fn catalog() -> &'static [Feature] {
    &CATALOG
}
pub fn find(id: &str) -> Option<&'static Feature> {
    catalog().iter().find(|f| f.id == id)
}
/// Whether `permission` exists in a DSP with `enabled` features: its owning page
/// is on, or for the connections permission any connection is on. A permission
/// no feature owns always exists.
pub fn grants(enabled: &[String], permission: &str) -> bool {
    let on = |f: &Feature| enabled.iter().any(|e| e == f.id);
    if permission == CONNECTIONS {
        return catalog()
            .iter()
            .any(|f| f.kind == Kind::Connection && on(f));
    }
    PAGES
        .iter()
        .find(|f| f.permissions.contains(&permission))
        .is_none_or(on)
}
/// The permissions of `stored` that exist with `enabled` features.
pub fn visible<'a>(
    enabled: &'a [String],
    stored: &'a [String],
) -> impl Iterator<Item = &'a String> {
    stored.iter().filter(move |p| grants(enabled, p))
}
/// Whether an enabled connection provides `capability`.
fn provided(capability: &str, enabled: &[String]) -> bool {
    catalog()
        .iter()
        .any(|f| f.provides == Some(capability) && enabled.iter().any(|e| e == f.id))
}
/// Whether every requirement of `feature` has an enabled provider.
fn satisfied(feature: &Feature, enabled: &[String]) -> bool {
    feature.requires.iter().all(|c| provided(c, enabled))
}

impl FromRow for FeatureState {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            feature: row.get("feature")?,
            enabled: row.get("enabled")?,
            changed_at: row.get("changed_at")?,
            changed_by: row.get("changed_by")?,
        })
    }
}
impl Store {
    /// The DSP's enabled features, in catalog order. A feature without a row of its
    /// own is at its default, which is how a DSP made before the feature existed reads.
    pub fn features(&self, dsp: &str) -> Result<Vec<String>> {
        let stored: BTreeMap<String, bool> = self
            .platform
            .query_as(
                "SELECT feature,enabled FROM dsp_features WHERE dsp_id=?",
                [dsp],
            )?
            .into_iter()
            .collect();
        Ok(catalog()
            .iter()
            .filter(|f| stored.get(f.id).copied().unwrap_or(f.default))
            .map(|f| f.id.to_owned())
            .collect())
    }
    /// Every feature of the catalog as the DSP has it, with what switching the
    /// schedules' page off would stop, for the platform's DSP page.
    pub fn feature_report(&self, dsp: &str) -> Result<DspFeatureReport> {
        let row = self.find_dsp(dsp)?;
        let stored: Vec<FeatureState> = self.platform.query_as(
            "SELECT f.feature,f.enabled,f.changed_at,u.first_name||' '||u.last_name changed_by \
             FROM dsp_features f LEFT JOIN users u ON u.id=f.changed_by WHERE f.dsp_id=?",
            [dsp],
        )?;
        let features = catalog()
            .iter()
            .map(|f| {
                stored
                    .iter()
                    .find(|s| s.feature == f.id)
                    .cloned()
                    .unwrap_or(FeatureState {
                        feature: f.id.to_owned(),
                        enabled: f.default,
                        changed_at: None,
                        changed_by: None,
                    })
            })
            .collect();
        let provisioned = [DspStatus::Active, DspStatus::Suspended].contains(&row.status);
        Ok(DspFeatureReport {
            features,
            schedules: if provisioned {
                self.dsp(dsp)?.count(
                    "SELECT count(*) FROM collection_schedules WHERE enabled=1",
                    [],
                )?
            } else {
                0
            },
            active_jobs: self.jobs.count(
                concat!(
                    "SELECT count(*) FROM jobs WHERE dsp_id=? AND status IN ",
                    job_statuses!(active)
                ),
                [dsp],
            )?,
        })
    }
    pub fn feature_enabled(&self, dsp: &str, id: &str) -> Result<bool> {
        Ok(self.features(dsp)?.iter().any(|f| f == id))
    }
    /// Switches every feature on for a development or preview DSP, so its demo shows every
    /// page. Real DSPs start with none and get theirs from the platform owner.
    pub fn enable_all_features(&self, dsp: &str) -> Result<()> {
        self.write_features(dsp, |_| true, true)
    }
    /// Writes a new DSP's rows, so a later change of a default leaves it as it was made.
    pub fn seed_features(&self, dsp: &str) -> Result<()> {
        self.write_features(dsp, |f| f.default, false)
    }
    /// A row for every feature, `on` or not; `overwrite` replaces rows the DSP has.
    fn write_features(&self, dsp: &str, on: fn(&Feature) -> bool, overwrite: bool) -> Result<()> {
        let sql = if overwrite {
            "INSERT INTO dsp_features(dsp_id,feature,enabled,changed_at) VALUES (?,?,?,?) \
             ON CONFLICT(dsp_id,feature) DO UPDATE SET enabled=excluded.enabled,changed_at=excluded.changed_at"
        } else {
            "INSERT OR IGNORE INTO dsp_features(dsp_id,feature,enabled,changed_at) VALUES (?,?,?,?)"
        };
        for feature in catalog() {
            self.platform
                .exec(sql, params![dsp, feature.id, on(feature), iso()])?;
        }
        Ok(())
    }
    /// Switches one feature, and with it whatever depends on it: enabling a page
    /// enables a provider of each capability it lacks, enabling a provider switches
    /// off another of the same capability, and disabling a provider disables the
    /// pages left without one. Every switch is audited; the answer lists them.
    pub fn set_feature(
        &self,
        dsp: &str,
        id: &str,
        enabled: bool,
        actor: &str,
    ) -> Result<DspFeatures> {
        let all = catalog();
        let feature = find(id).ok_or_else(|| super::Error::new("feature_not_found", 404))?;
        self.platform.transaction(|| {
            self.find_dsp(dsp)?;
            let mut current = self.features(dsp)?;
            let mut changed: Vec<(&Feature, bool)> = Vec::new();
            let mut flip = |current: &mut Vec<String>, f: &'static Feature, on: bool| {
                let is_on = current.iter().any(|e| e == f.id);
                if is_on == on {
                    return;
                }
                if on {
                    current.push(f.id.to_owned());
                } else {
                    current.retain(|e| e != f.id);
                }
                changed.push((f, on));
            };
            if enabled {
                if let Some(capability) = feature.provides {
                    for other in all
                        .iter()
                        .filter(|f| f.provides == Some(capability) && f.id != feature.id)
                    {
                        flip(&mut current, other, false);
                    }
                }
                for capability in feature.requires {
                    if provided(capability, &current) {
                        continue;
                    }
                    let providers: Vec<_> = all
                        .iter()
                        .filter(|f| f.provides == Some(*capability))
                        .collect();
                    ensure(providers.len() == 1, "provider_required", 409)?;
                    flip(&mut current, providers[0], true);
                }
                flip(&mut current, feature, true);
            } else {
                flip(&mut current, feature, false);
                for page in all.iter().filter(|f| f.kind == Kind::Page) {
                    if !satisfied(page, &current) {
                        flip(&mut current, page, false);
                    }
                }
            }
            for (f, on) in &changed {
                self.platform.exec(
                    "INSERT INTO dsp_features(dsp_id,feature,enabled,changed_by,changed_at) \
                     VALUES (?1,?2,?3,?4,?5) ON CONFLICT(dsp_id,feature) DO UPDATE SET \
                     enabled=?3,changed_by=?4,changed_at=?5",
                    params![dsp, f.id, on, actor, iso()],
                )?;
                let cause: Vec<AuditChange> = if f.id == id {
                    vec![]
                } else {
                    vec![("cause", None, Some(feature.label.to_owned()))]
                };
                self.audit_with(
                    Some(actor),
                    Some(dsp),
                    if *on {
                        "dsp.feature_enabled"
                    } else {
                        "dsp.feature_disabled"
                    },
                    f.id,
                    Some(f.label),
                    &cause,
                )?;
            }
            if !changed.is_empty() {
                // Open views sign the DSP revision, so members pick up the change.
                self.platform
                    .exec("UPDATE dsps SET revision=revision+1 WHERE id=?", [dsp])?;
            }
            Ok(DspFeatures {
                features: self.features(dsp)?,
                changed: changed
                    .into_iter()
                    .map(|(f, on)| FeatureChange {
                        feature: f.id.to_owned(),
                        enabled: on,
                    })
                    .collect(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_new_dsp_starts_with_no_features_and_a_demo_dsp_with_all() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = super::super::config::Config::load().unwrap();
        config.root = root.path().into();
        let db = Store::initialize(config).unwrap();
        let owner = db
            .create_user(
                "owner@example.test",
                "Platform",
                "Owner",
                "Features-test-2026!",
                true,
            )
            .unwrap();
        let dsp = db.new_dsp("New DSP", "UTC", &owner.id, false).unwrap();
        assert!(db.features(&dsp.id).unwrap().is_empty());
        db.enable_all_features(&dsp.id).unwrap();
        let all: Vec<_> = catalog().iter().map(|f| f.id.to_owned()).collect();
        assert_eq!(db.features(&dsp.id).unwrap(), all);
    }
    #[test]
    fn the_catalog_is_consistent() {
        let all = catalog();
        let mut ids: Vec<_> = all.iter().map(|f| f.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), all.len(), "feature ids repeat");
        let mut owned = Vec::new();
        for feature in all {
            for permission in feature.permissions {
                assert!(
                    super::super::roles::PERMISSIONS.contains(permission),
                    "{permission} is not a permission"
                );
                assert!(!owned.contains(permission), "{permission} has two features");
                owned.push(*permission);
            }
            match feature.kind {
                Kind::Page => assert!(feature.provides.is_none()),
                Kind::Connection => {
                    assert!(feature.provides.is_some() && feature.requires.is_empty())
                }
            }
            for capability in feature.requires {
                assert!(
                    all.iter().any(|f| f.provides == Some(*capability)),
                    "nothing provides {capability}"
                );
            }
        }
        assert!(!owned.contains(&CONNECTIONS));
        assert!(find(SCHEDULES).is_some_and(|f| f.kind == Kind::Page));
    }
    #[test]
    fn permissions_follow_their_feature() {
        let on = |ids: &[&str]| ids.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(grants(&on(&["uniforms"]), "uniforms.view"));
        assert!(!grants(&on(&["timecard"]), "uniforms.view"));
        assert!(grants(&on(&[]), "members.invite"));
        assert!(grants(&on(&["cortex"]), "connections.manage"));
        assert!(!grants(
            &on(&["timecard", "uniforms"]),
            "connections.manage"
        ));
        let stored = on(&["uniforms.view", "roles.manage", "timecard.view"]);
        let enabled = on(&["timecard"]);
        let seen: Vec<_> = visible(&enabled, &stored).collect();
        assert_eq!(
            seen,
            [&"roles.manage".to_owned(), &"timecard.view".to_owned()]
        );
    }
}
