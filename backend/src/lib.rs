use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, os::unix::fs::MetadataExt, path::Path, time::Duration};

#[derive(Debug)]
pub enum Error {
    InvalidInput,
    UnsafeStorage,
    Storage,
    Schema,
    NotFound,
}

impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmployeeRequest {
    pub dsp_id: String,
    pub code: String,
}

#[derive(Serialize)]
pub struct Employee {
    code: String,
    name: String,
    department: String,
    position: String,
    station: String,
    active: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Punch {
    r#in: Option<String>,
    out: Option<String>,
    hours: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timecard {
    employee_code: String,
    date: String,
    hours: f64,
    status: String,
    punches: Vec<Punch>,
}

#[derive(Serialize)]
pub struct EmployeeDetail {
    employee: Employee,
    timecards: Vec<Timecard>,
}

/// Only the trusted gateway supplies DSP identities. Never accept database paths.
pub fn employee(root: &Path, request: EmployeeRequest) -> Result<EmployeeDetail, Error> {
    let suffix = request
        .dsp_id
        .strip_prefix("dsp_")
        .ok_or(Error::InvalidInput)?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.code.is_empty()
        || request.code.len() > 32
        || !request
            .code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::InvalidInput);
    }
    let owner = fs::metadata(root).map_err(|_| Error::UnsafeStorage)?.uid();
    let mut file = root.to_path_buf();
    for segment in [&request.dsp_id, "data", "dispatch.sqlite"] {
        file.push(segment);
        let metadata = fs::symlink_metadata(&file).map_err(|_| Error::UnsafeStorage)?;
        let is_file = segment == "dispatch.sqlite";
        if metadata.file_type().is_symlink()
            || metadata.uid() != owner
            || metadata.mode() & 0o077 != 0
            || (is_file && (!metadata.is_file() || metadata.nlink() != 1))
            || (!is_file && !metadata.is_dir())
        {
            return Err(Error::UnsafeStorage);
        }
    }
    // Read-only connections cannot create/migrate a DSP database or publish data.
    let mut db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_secs(2))?;
    let schema: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema != 1 {
        return Err(Error::Schema);
    }
    // Keep preferences, the selected publication and its timecards in one snapshot.
    let tx = db.transaction()?;
    let preferences: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key='paycom.preferences'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let last_first = match preferences {
        Some(value) => {
            serde_json::from_str::<serde_json::Value>(&value).map_err(|_| Error::Storage)?["values"]
                ["name_order"]
                == "last_first"
        }
        None => false,
    };
    let (mut employee, publication): (Employee, String) = tx
        .query_row(
            "SELECT e.code,e.name,e.department,e.position,e.station,e.active,e.publication_id
             FROM employees e JOIN publications p ON p.id=e.publication_id
             WHERE e.code=?1 ORDER BY p.collected_at DESC LIMIT 1",
            [&request.code],
            |row| {
                Ok((
                    Employee {
                        code: row.get(0)?,
                        name: row.get(1)?,
                        department: row.get(2)?,
                        position: row.get(3)?,
                        station: row.get(4)?,
                        active: row.get::<_, i64>(5)? != 0,
                    },
                    row.get(6)?,
                ))
            },
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    if last_first {
        employee.name = display_name(&employee.name);
    }
    let mut query = tx.prepare(
        "SELECT employee_code,date,hours,status,punches FROM timecards
         WHERE publication_id=?1 AND employee_code=?2 ORDER BY date DESC",
    )?;
    let mut rows = query.query([&publication, &request.code])?;
    let mut timecards = Vec::new();
    while let Some(row) = rows.next()? {
        let punches: String = row.get(4)?;
        timecards.push(Timecard {
            employee_code: row.get(0)?,
            date: row.get(1)?,
            hours: row.get(2)?,
            status: row.get(3)?,
            punches: serde_json::from_str(&punches).map_err(|_| Error::Storage)?,
        });
    }
    Ok(EmployeeDetail {
        employee,
        timecards,
    })
}

fn display_name(name: &str) -> String {
    // Match JavaScript's /\s+/ (not Rust's slightly different Unicode whitespace).
    let parts: Vec<_> = name
        .split(|c: char| {
            matches!(c,
                '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                '\u{205f}' | '\u{3000}' | '\u{feff}'
            )
        })
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() > 1 {
        format!(
            "{}, {}",
            parts[parts.len() - 1],
            parts[..parts.len() - 1].join(" ")
        )
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_existing_dashboard_rules() {
        assert_eq!(
            display_name("  Ana\u{feff}María\u{00a0}López  "),
            "López, Ana María"
        );
        assert_eq!(display_name("  Cher  "), "  Cher  ");
        assert_eq!(display_name("Ana\u{0085}López"), "Ana\u{0085}López");
    }

    #[test]
    fn rejects_paths_and_non_ascii_identifiers_before_opening_storage() {
        for (dsp_id, code) in [
            ("../data", "A1"),
            ("dsp_00000000000000000000000000000000", "../A1"),
            ("dsp_00000000000000000000000000000000", "é"),
        ] {
            assert!(matches!(
                employee(
                    Path::new("/missing"),
                    EmployeeRequest {
                        dsp_id: dsp_id.into(),
                        code: code.into(),
                    }
                ),
                Err(Error::InvalidInput)
            ));
        }
    }
}
