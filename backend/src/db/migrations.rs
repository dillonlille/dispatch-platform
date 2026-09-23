//! Every database kind has one ordered list of numbered migrations in `schema`.
//! Adding a table or a column is one new entry at the end of a list.
//!
//! Contract for migration authors: additive only. New tables, new nullable or
//! defaulted columns, and new indexes. The previous release must keep working on
//! a database this release has migrated, so never drop, rename or rewrite what
//! it reads. Anything else takes two releases: the first stops using it and ships,
//! and only the next, whose rollback target no longer needs it, removes it.
//! Never edit or renumber a migration that has shipped; append a new one.
//!
//! A database may record ids this binary does not know. That is a rollback: the
//! next release added a migration and this release was started again on its data.
//! Rollback must work one release back, so those ids are logged and tolerated,
//! never refused. They are safe to ignore because migrations are additive.
//! `PRAGMA user_version` stays pinned per kind for the same reason: older
//! binaries refuse any other value.
use super::{Db, now, schema};
use crate::{Error, Result, observability};
use rusqlite::{Transaction, TransactionBehavior};
use serde_json::json;
use std::collections::BTreeSet;

pub enum Apply {
    Sql(&'static str),
    /// For steps that must look before they change anything, such as a column an
    /// older binary may already have added. Runs inside the migration transaction,
    /// so it must not begin one of its own.
    Code(fn(&Db) -> Result<()>),
}
pub struct Migration {
    pub id: u32,
    pub name: &'static str,
    pub apply: Apply,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Platform,
    Jobs,
    Dsp,
    Paycom,
    Cortex,
}
impl Kind {
    pub const ALL: &[Self] = &[
        Self::Platform,
        Self::Jobs,
        Self::Dsp,
        Self::Paycom,
        Self::Cortex,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Platform => "platform",
            Self::Jobs => "jobs",
            Self::Dsp => "dsp",
            Self::Paycom => "paycom",
            Self::Cortex => "cortex",
        }
    }
    /// Pinned. Released binaries refuse to open a database with any other value.
    pub(crate) fn version(self) -> i64 {
        match self {
            Self::Platform => 3,
            Self::Jobs | Self::Dsp | Self::Paycom | Self::Cortex => 1,
        }
    }
    pub fn migrations(self) -> &'static [Migration] {
        match self {
            Self::Platform => schema::PLATFORM,
            Self::Jobs => schema::JOBS,
            Self::Dsp => schema::DSP,
            Self::Paycom => schema::PAYCOM,
            Self::Cortex => schema::CORTEX,
        }
    }
}

/// Adds a column unless an older binary's startup already did.
pub fn add_column(db: &Db, table: &str, column: &str, definition: &str) -> Result<()> {
    let found = db.0.query_row(
        "SELECT count(*) FROM pragma_table_info(?) WHERE name=?",
        [table, column],
        |row| row.get::<_, i64>(0),
    )?;
    if found == 0 {
        db.0.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn applied(db: &Db) -> Result<BTreeSet<u32>> {
    let exists = db.0.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if exists == 0 {
        return Ok(BTreeSet::new());
    }
    let mut statement = db.0.prepare("SELECT id FROM schema_migrations")?;
    let ids = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

fn pending<'a>(done: &BTreeSet<u32>, list: &'a [Migration]) -> Vec<&'a Migration> {
    list.iter().filter(|m| !done.contains(&m.id)).collect()
}

/// Applies what is pending. The caller holds the write transaction, so a failure
/// leaves the database exactly as it was.
pub(super) fn apply(db: &Db, kind: &str, list: &[Migration]) -> Result<()> {
    db.0.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY \
        KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    )?;
    // Read again under the write lock: another connection may have just finished.
    for migration in pending(&applied(db)?, list) {
        let result = match migration.apply {
            Apply::Sql(sql) => db.0.execute_batch(sql).map_err(Error::from),
            Apply::Code(code) => code(db),
        };
        if result.is_err() {
            observability::event(
                "error",
                "storage.migration_failed",
                json!({"kind":kind,"id":migration.id,"name":migration.name}),
            );
            return Err(Error::new("migration_failed", 503));
        }
        db.0.execute(
            "INSERT INTO schema_migrations(id,name,applied_at) VALUES (?,?,?)",
            rusqlite::params![migration.id, migration.name, now()],
        )?;
        observability::event(
            "info",
            "storage.migration_applied",
            json!({"kind":kind,"id":migration.id,"name":migration.name}),
        );
    }
    Ok(())
}

pub(super) fn immediate(db: &Db) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        &db.0,
        TransactionBehavior::Immediate,
    )?)
}

pub(super) fn run(db: &Db, kind: &str, list: &[Migration]) -> Result<()> {
    // Startup checks every database and nearly always finds nothing to do, so look
    // without taking the write lock first.
    let done = applied(db)?;
    let newer: Vec<u32> = done
        .iter()
        .copied()
        .filter(|id| list.iter().all(|m| m.id != *id))
        .collect();
    if !newer.is_empty() {
        observability::event(
            "warn",
            "storage.migrations_newer",
            json!({"kind":kind,"ids":newer}),
        );
    }
    if pending(&done, list).is_empty() {
        return Ok(());
    }
    let tx = immediate(db)?;
    apply(db, kind, list)?;
    tx.commit()?;
    Ok(())
}

/// Brings an open database up to this binary's list for its kind. Runs where
/// initialization always has: startup, the operator commands and provisioning.
/// Requests open databases without it.
pub fn migrate(db: &Db, kind: Kind) -> Result<()> {
    run(db, kind.name(), kind.migrations())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db::Store};
    use std::{
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
    };

    const RECORD: &str = "CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);\n";

    fn snapshot(kind: Kind) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/schema")
            .join(format!("{}.sql", kind.name()))
    }
    // Tables, then indexes, then triggers, so a snapshot also runs as a script.
    fn dump(db: &Db) -> String {
        db.all(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN \
            'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name",
            [],
        )
        .unwrap()
        .iter()
        .map(|row| {
            let sql: Vec<&str> = row["sql"].as_str().unwrap().split_whitespace().collect();
            format!("{};\n", sql.join(" "))
        })
        .collect()
    }
    fn private() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }
    // What an older binary left behind: the schema without any record of migrations.
    fn older(file: &Path, kind: Kind, schema: &str) {
        let db = rusqlite::Connection::open(file).unwrap();
        db.execute_batch(schema).unwrap();
        db.pragma_update(None, "user_version", kind.version())
            .unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn recorded(kind: Kind) -> String {
        std::fs::read_to_string(snapshot(kind)).unwrap()
    }
    fn ids(db: &Db) -> Vec<i64> {
        db.all("SELECT id FROM schema_migrations ORDER BY id", [])
            .unwrap()
            .iter()
            .map(|row| row["id"].as_i64().unwrap())
            .collect()
    }

    /// Startup and provisioning, exactly as the core runs them. Every schema change
    /// shows up in review as a change to backend/tests/schema. After adding a
    /// migration, rewrite the snapshots with
    /// `DISPATCH_UPDATE_SCHEMA=1 cargo test --locked -j 3 --lib db::migrations`.
    #[test]
    fn new_databases_match_the_recorded_schema() {
        let root = private();
        let mut config = Config::load().unwrap();
        config.root = root.path().into();
        let store = Store::initialize(config).unwrap();
        let id = crate::crypto::id("dsp").unwrap();
        store
            .platform
            .exec(
                "INSERT INTO \
            dsps(id,name,environment,status,timezone,created_at) VALUES \
            (?,'Schema','preview','provisioning','UTC',?)",
                [&id, &crate::db::iso()],
            )
            .unwrap();
        store.provision(&id).unwrap();
        let dsp = store.dsp(&id).unwrap();
        let paycom = store
            .collector(&id, crate::collectors::Provider::Paycom)
            .unwrap();
        let cortex = store
            .collector(&id, crate::collectors::Provider::Cortex)
            .unwrap();
        let databases: [(Kind, &Db); 5] = [
            (Kind::Platform, &store.platform),
            (Kind::Jobs, &store.jobs),
            (Kind::Dsp, &dsp),
            (Kind::Paycom, &paycom),
            (Kind::Cortex, &cortex),
        ];
        for (kind, db) in databases {
            if std::env::var_os("DISPATCH_UPDATE_SCHEMA").is_some() {
                std::fs::write(snapshot(kind), dump(db)).unwrap();
            }
            assert_eq!(dump(db), recorded(kind), "{} schema", kind.name());
            let expected: Vec<i64> = kind.migrations().iter().map(|m| m.id.into()).collect();
            assert_eq!(ids(db), expected);
            // A second pass finds nothing to do.
            migrate(db, kind).unwrap();
            assert_eq!(dump(db), recorded(kind));
            assert_eq!(ids(db), expected);
        }
    }

    #[test]
    fn lists_are_numbered_from_one_without_gaps_or_repeats() {
        for kind in Kind::ALL {
            for (index, migration) in kind.migrations().iter().enumerate() {
                assert_eq!(migration.id as usize, index + 1, "{}", kind.name());
                assert!(!migration.name.is_empty());
            }
        }
    }

    #[test]
    fn employee_history_uses_the_code_index() {
        let root = private();
        let file = root.path().join("paycom.sqlite");
        let db = Db::create(&file, Kind::Paycom, "").unwrap();
        let plan = db.all("EXPLAIN QUERY PLAN SELECT p.id FROM publications p JOIN employees e ON e.publication_id=p.id WHERE e.code='E001' ORDER BY p.period_to DESC LIMIT 1", []).unwrap();
        assert!(
            plan.iter().any(|row| row["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("employees_by_code")),
            "{plan:?}"
        );
        assert!(
            !plan.iter().any(|row| row["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("SCAN e")),
            "{plan:?}"
        );
    }

    #[test]
    fn a_database_an_older_binary_made_ends_like_a_new_one() {
        let root = private();
        for kind in Kind::ALL {
            let file = root.path().join(format!("{}.sqlite", kind.name()));
            older(&file, *kind, &recorded(*kind).replace(RECORD, ""));
            let db = Db::create(&file, *kind, "INSERT INTO never_run VALUES (1);").unwrap();
            assert_eq!(dump(&db), recorded(*kind), "{}", kind.name());
        }
    }

    #[test]
    fn platform_databases_from_before_each_added_column_gain_it() {
        let root = private();
        let columns = |db: &Db, table: &str| {
            db.all(
                &format!("SELECT name,type FROM pragma_table_info('{table}') ORDER BY name"),
                [],
            )
            .unwrap()
        };
        let new = root.path().join("new.sqlite");
        let new = Db::create(&new, Kind::Platform, "").unwrap();
        // v0.0.9 has no audit data or shown. Before v0.0.6 there was no actor_name,
        // and before roles no role_id or its indexes.
        let v9 = recorded(Kind::Platform)
            .replace(RECORD, "")
            .replace(", data TEXT, shown INTEGER)", ")");
        let first = v9
            .replace(", actor_name TEXT)", ")")
            .replace(", role_id TEXT REFERENCES roles(id)", "")
            .replace(", role_id TEXT)", ")")
            .replace(
                "CREATE INDEX memberships_role ON memberships(role_id);\n",
                "",
            )
            .replace(
                "CREATE INDEX invitations_role ON invitations(role_id) WHERE used_at IS NULL;\n",
                "",
            );
        assert!(!first.contains("role_id") && !first.contains("actor_name"));
        for (name, schema) in [("v9", v9), ("first", first)] {
            let file = root.path().join(format!("{name}.sqlite"));
            older(&file, Kind::Platform, &schema);
            rusqlite::Connection::open(&file)
                .unwrap()
                .execute("INSERT INTO audit(at,action) VALUES ('then','kept')", [])
                .unwrap();
            let db = Db::create(&file, Kind::Platform, "").unwrap();
            for table in ["audit", "memberships", "invitations"] {
                assert_eq!(columns(&db, table), columns(&new, table), "{name} {table}");
            }
            assert_eq!(dump(&db), dump(&new), "{name}");
            assert_eq!(
                db.all("SELECT action,data,shown,actor_name FROM audit", [])
                    .unwrap(),
                vec![json!({"action":"kept","data":null,"shown":null,"actor_name":null})]
            );
        }
    }

    #[test]
    fn migrations_a_newer_release_recorded_are_tolerated() {
        let root = private();
        let file = root.path().join("dsp.sqlite");
        let db = Db::create(&file, Kind::Dsp, "").unwrap();
        db.0.execute_batch(
            "CREATE TABLE from_the_next_release (id TEXT); INSERT INTO \
            schema_migrations VALUES (9000,'from_the_next_release',1);",
        )
        .unwrap();
        drop(db);
        let db = Db::create(&file, Kind::Dsp, "").unwrap();
        migrate(&db, Kind::Dsp).unwrap();
        Db::open(&file, Kind::Dsp).unwrap();
        let mut expected: Vec<i64> = Kind::Dsp
            .migrations()
            .iter()
            .map(|m| i64::from(m.id))
            .collect();
        expected.push(9000);
        assert_eq!(ids(&db), expected);
        db.one("SELECT count(*) FROM from_the_next_release", [])
            .unwrap();
    }

    #[test]
    fn a_failing_migration_changes_nothing() {
        let root = private();
        let file = root.path().join("dsp.sqlite");
        let db = Db::create(&file, Kind::Dsp, "").unwrap();
        let before = dump(&db);
        let before_ids = ids(&db);
        let next = Kind::Dsp.migrations().last().unwrap().id + 1;
        let list = [
            Migration {
                id: next,
                name: "fine",
                apply: Apply::Sql("CREATE TABLE fine (id TEXT);"),
            },
            Migration {
                id: next + 1,
                name: "broken",
                apply: Apply::Sql("CREATE TABLE half (id TEXT); INSERT INTO missing VALUES (1);"),
            },
        ];
        assert_eq!(
            run(&db, "test", &list).unwrap_err().code,
            "migration_failed"
        );
        assert_eq!(dump(&db), before);
        assert_eq!(ids(&db), before_ids);
        assert!(db.0.is_autocommit());
    }

    #[test]
    fn connections_racing_to_open_first_apply_each_migration_once() {
        let root = private();
        // Neither statement can run twice.
        let next = Kind::Dsp.migrations().last().unwrap().id + 1;
        let list: &[Migration] = &[Migration {
            id: next,
            name: "once",
            apply: Apply::Sql(
                "CREATE TABLE once (id INTEGER PRIMARY KEY); INSERT INTO once VALUES (1);",
            ),
        }];
        for round in 0..8 {
            let file = root.path().join(format!("race-{round}.sqlite"));
            let barrier = std::sync::Barrier::new(4);
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| {
                        barrier.wait();
                        // The seed would fail on its primary key if two connections ran it.
                        let db = Db::create(
                            &file,
                            Kind::Dsp,
                            "INSERT INTO settings VALUES ('seeded','1');",
                        )
                        .unwrap();
                        run(&db, "test", list).unwrap();
                    });
                }
            });
            let db = Db::open(&file, Kind::Dsp).unwrap();
            let mut expected: Vec<i64> = Kind::Dsp
                .migrations()
                .iter()
                .map(|m| i64::from(m.id))
                .collect();
            expected.push(i64::from(next));
            assert_eq!(ids(&db), expected);
            assert_eq!(
                db.all("SELECT * FROM once", []).unwrap(),
                vec![json!({"id":1})]
            );
            assert_eq!(
                db.all("SELECT key FROM settings", []).unwrap(),
                vec![json!({"key":"seeded"})]
            );
        }
    }
}
