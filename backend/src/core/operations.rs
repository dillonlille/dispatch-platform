use super::collectors::Provider;
use super::{
    Error, Result, State,
    config::Config,
    crypto,
    db::{self, Store, iso, n, s},
    ensure, workforce,
};
use fs2::FileExt;
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::Path,
    sync::Arc,
    time::Duration,
};
pub struct Lock {
    _file: File,
}
impl Lock {
    pub fn acquire(root: &Path) -> Result<Self> {
        db::private_dir(root)?;
        let path = root.join(".platform.lock");
        db::private_file(&path, true)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        file.try_lock_exclusive()
            .map_err(|_| Error::new("stop_services_before_operation", 409))?;
        Ok(Self { _file: file })
    }
}
pub fn memory() -> (u64, u64) {
    fn rss(pid: u32) -> u64 {
        fs::read_to_string(format!("/proc/{pid}/status"))
            .ok()
            .and_then(|s| {
                s.lines()
                    .find(|l| l.starts_with("VmRSS:"))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .unwrap_or(0)
            * 1024
    }
    fn descendants(pid: u32, seen: &mut HashSet<u32>) -> u64 {
        let mut total = 0;
        if let Ok(tasks) = fs::read_dir(format!("/proc/{pid}/task")) {
            for task in tasks.flatten() {
                if let Ok(children) = fs::read_to_string(task.path().join("children")) {
                    for child in children.split_whitespace().filter_map(|c| c.parse().ok()) {
                        if seen.insert(child) {
                            total += rss(child) + descendants(child, seen);
                        }
                    }
                }
            }
        }
        total
    }
    let pid = std::process::id();
    (rss(pid), descendants(pid, &mut HashSet::from([pid])))
}
pub fn available_space(path: &Path) -> Result<u64> {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::new("unsafe_storage_path", 500))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(stat.f_bavail * stat.f_frsize)
}
pub fn bootstrap(
    db: &Store,
    email: &str,
    first: &str,
    last: &str,
    password: &str,
) -> Result<Value> {
    ensure(
        db.platform
            .one("SELECT id FROM users LIMIT 1", [])?
            .is_none(),
        "bootstrap_requires_empty_platform",
        409,
    )?;
    let owner = db.create_user(email, first, last, password, true)?;
    let dsp = db.create_dsp("Dev DSP", "UTC", s(&owner, "id"), true)?;
    Ok(json!({"owner":owner,"dsp":dsp}))
}
pub fn seed(db: &Store) -> Result<()> {
    ensure(
        db.config.development && db.config.fixture,
        "fixtures_require_development",
        403,
    )?;
    if db.config.platform().join("development-seeded").exists() {
        return Ok(());
    }
    ensure(
        db.platform
            .one("SELECT id FROM users LIMIT 1", [])?
            .is_none(),
        "fixture_state_not_empty",
        409,
    )?;
    let owner = db.create_user(
        "owner@dispatch.test",
        "Platform",
        "Owner",
        "Dispatch-demo-2026!",
        true,
    )?;
    let dev = db.create_dsp("Dev DSP", "America/Chicago", s(&owner, "id"), true)?;
    let north = db.create_dsp(
        "Northline Logistics",
        "America/Chicago",
        s(&owner, "id"),
        false,
    )?;
    db.create_dsp("Summit Delivery", "America/Denver", s(&owner, "id"), false)?;
    let member = db.create_user(
        "member@dispatch.test",
        "Jordan",
        "Ellis",
        "Dispatch-demo-2026!",
        false,
    )?;
    db.platform.exec(
        "INSERT INTO memberships(id,user_id,dsp_id,role) VALUES (?,?,?,'member')",
        params![crypto::id("mem")?, s(&member, "id"), s(&north, "id")],
    )?;
    for dsp in [&dev, &north] {
        let id = s(dsp, "id");
        let area = db.area(id, "secrets")?;
        let key = db::key_file(&area.join("vault.key"))?;
        let credentials = json!({"clientCode":"DEMO1","username":"fixture-user","password":"synthetic-password","securityAnswers":["one","two","three","four","five"]});
        db::write_private(
            &area.join("paycom.enc"),
            crypto::encrypt(&key, &format!("{id}:paycom:2"), &credentials)?.as_bytes(),
        )?;
        db.collector(id, Provider::Paycom)?.exec(
            "UPDATE connections SET enabled=1,status='ready',account_label='DEMO1',verified_at=?",
            [iso()],
        )?;
        db.publish(id, &workforce::fixture(s(dsp, "timezone"))?)?;
        db.audit(
            Some(s(&owner, "id")),
            Some(id),
            "development.fixtures_loaded",
            "",
        )?;
    }
    db::write_private(
        &db.config.platform().join("development-seeded"),
        b"synthetic fixtures initialized\n",
    )
}
pub async fn mailer(state: Arc<State>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut timer = tokio::time::interval(Duration::from_secs(5));
    let mut transport = None;
    loop {
        tokio::select! {_=super::cancelled(&mut stop)=>break,_=timer.tick()=>{}};
        if !state.config.mail_available() {
            continue;
        }
        if transport.is_none() {
            let config = state.config.clone();
            transport = tokio::task::spawn_blocking(move || MailTransport::new(&config))
                .await
                .ok()
                .and_then(Result::ok)
                .map(Arc::new);
            if transport.is_none() {
                continue;
            }
        }
        let pending=state.read(|db|db.platform.all("SELECT id,encrypted_message,attempts FROM outbox WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 5",[db::now()])).await;
        let Ok(rows) = pending else {
            continue;
        };
        for row in rows {
            if *stop.borrow() {
                break;
            }
            let config = state.config.clone();
            let key = state.key.clone();
            let message = row.clone();
            let client = transport.as_ref().unwrap().clone();
            let result =
                tokio::task::spawn_blocking(move || deliver(&config, &key, &message, &client))
                    .await;
            let sent = matches!(result, Ok(Ok(())));
            let id = s(&row, "id").to_owned();
            let attempts = n(&row, "attempts");
            let _=state.run(move|db|{if sent {db.platform.exec("UPDATE outbox SET status='sent',encrypted_message='',sent_at=? WHERE id=?",[&iso(),&id])?;}else{db.platform.exec("UPDATE outbox SET attempts=attempts+1,status=?,available_at=? WHERE id=?",params![if attempts>=4{"failed"}else{"pending"},db::now()+60000*2_i64.pow(attempts.clamp(0,8) as u32),id])?;}Ok(())}).await;
        }
    }
}
enum MailTransport {
    Capture,
    Cloudflare(reqwest::blocking::Client),
    Smtp(lettre::SmtpTransport),
}
impl MailTransport {
    fn new(config: &Config) -> Result<Self> {
        let error = || Error::new("email_delivery_failed", 503);
        Ok(match config.mail_mode.as_str() {
            "capture" => Self::Capture,
            "cloudflare" => Self::Cloudflare(
                reqwest::blocking::Client::builder()
                    .user_agent("Dispatch-Mail/1.0")
                    .timeout(Duration::from_secs(15))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| error())?,
            ),
            _ => Self::Smtp(
                lettre::SmtpTransport::from_url(config.smtp_url.as_deref().ok_or_else(error)?)
                    .map_err(|_| error())?
                    .timeout(Some(Duration::from_secs(15)))
                    .build(),
            ),
        })
    }
}
fn deliver(config: &Config, key: &[u8], row: &Value, transport: &MailTransport) -> Result<()> {
    let value = crypto::decrypt(key, s(row, "id"), s(row, "encrypted_message"))?;
    if let MailTransport::Capture = transport {
        let directory = db::private_dir(&config.platform().join("development-mail"))?;
        db::write_private(
            &directory.join(format!("{}.json", s(row, "id"))),
            &serde_json::to_vec(&value)?,
        )?;
    } else if let MailTransport::Cloudflare(client) = transport {
        ensure(
            s(&value, "environment") == config.environment && s(&value, "origin") == config.origin,
            "email_environment_mismatch",
            503,
        )?;
        let error = || Error::new("email_delivery_failed", 503);
        let response = client
            .post(config.mail_worker_url.as_deref().ok_or_else(error)?)
            .bearer_auth(config.mail_worker_token.as_deref().ok_or_else(error)?)
            .json(&value)
            .send()
            .map_err(|_| error())?;
        ensure(response.status().is_success(), "email_delivery_failed", 503)?;
    } else {
        use lettre::{
            Transport,
            message::{MultiPart, SinglePart},
        };
        let error = || Error::new("email_delivery_failed", 503);
        let message = lettre::Message::builder()
            .from(
                config
                    .mail_from
                    .as_deref()
                    .ok_or_else(error)?
                    .parse()
                    .map_err(|_| error())?,
            )
            .to(s(&value, "to").parse().map_err(|_| error())?)
            .subject(s(&value, "subject"));
        let message = if let Some(html) = value["html"].as_str() {
            message.multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::plain(s(&value, "text").to_owned()))
                    .singlepart(SinglePart::html(html.to_owned())),
            )
        } else {
            message.body(s(&value, "text").to_owned())
        }
        .map_err(|_| error())?;
        let MailTransport::Smtp(transport) = transport else {
            unreachable!()
        };
        transport.send(&message).map_err(|_| error())?;
    }
    Ok(())
}
pub fn backup(config: &Config, destination: &Path) -> Result<Value> {
    ensure(
        destination.is_absolute() && !destination.starts_with(&config.root),
        "backup_outside_state_required",
        400,
    )?;
    ensure(!destination.try_exists()?, "backup_destination_exists", 409)?;
    db::private_dir(destination)?;
    let mut files = Vec::new();
    fn copy(
        source: &Path,
        destination: &Path,
        relative: &Path,
        files: &mut Vec<Value>,
    ) -> Result<()> {
        let stat = fs::symlink_metadata(source)?;
        ensure(
            !stat.file_type().is_symlink() && stat.uid() == unsafe { libc::geteuid() },
            "invalid_backup_file",
            400,
        )?;
        if stat.is_dir() {
            db::private_dir(&destination.join(relative))?;
            let parts: Vec<_> = relative.iter().filter_map(|p| p.to_str()).collect();
            let browser_pulse = parts.len() >= 5
                && parts[0] == "dsps"
                && db::identifier(parts[1], "dsp_")
                && parts[2..4] == ["state", "browsers"]
                && parts.last() == Some(&"pulse");
            for item in fs::read_dir(source)? {
                let item = item?;
                let name = item.file_name().to_string_lossy().into_owned();
                // Chromium retains this disposable OS runtime link after shutdown.
                let pulse_runtime =
                    browser_pulse && name.ends_with("-runtime") && item.file_type()?.is_symlink();
                if pulse_runtime
                    || name.ends_with("-wal")
                    || name.ends_with("-shm")
                    || name.ends_with(".lock")
                    || [
                        "browser-runs",
                        "releases",
                        "activation-staging",
                        "activation-backups",
                    ]
                    .contains(&name.as_str())
                {
                    continue;
                }
                copy(&item.path(), destination, &relative.join(name), files)?;
            }
        } else {
            ensure(
                stat.is_file() && stat.nlink() == 1,
                "invalid_backup_file",
                400,
            )?;
            let target = destination.join(relative);
            if source.extension().is_some_and(|s| s == "sqlite") {
                let source = rusqlite::Connection::open_with_flags(
                    source,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                source.execute("VACUUM INTO ?", [target.to_string_lossy().as_ref()])?;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
            } else {
                db::write_private(&target, &fs::read(source)?)?;
            }
            let bytes = fs::read(&target)?;
            files.push(json!({"path":relative.to_string_lossy(),"sha256":crypto::sha(&bytes),"size":bytes.len()}));
        }
        Ok(())
    }
    for area in ["data", "dsps"] {
        let source = config.root.join(area);
        if source.exists() {
            copy(&source, destination, Path::new(area), &mut files)?;
        }
    }
    db::write_private(
        &destination.join("backup.json"),
        &serde_json::to_vec_pretty(&json!({"format":2,"createdAt":iso(),"files":files}))?,
    )?;
    Ok(json!({"destination":destination,"files":files.len()}))
}
pub fn restore(source: &Path, target: &Path) -> Result<Value> {
    ensure(
        source.is_absolute() && target.is_absolute() && !target.starts_with(source),
        "invalid_restore_path",
        400,
    )?;
    ensure(
        !target.try_exists()? || fs::read_dir(target)?.next().is_none(),
        "restore_empty_target_required",
        409,
    )?;
    db::private_file(&source.join("backup.json"), false)?;
    let manifest: Value = serde_json::from_slice(&fs::read(source.join("backup.json"))?)?;
    ensure(n(&manifest, "format") == 2, "invalid_backup", 400)?;
    let files = manifest["files"]
        .as_array()
        .ok_or_else(|| Error::new("invalid_backup", 400))?;
    let mut seen = HashSet::new();
    for file in files {
        let path = s(file, "path");
        let parts: Vec<_> = path.split('/').collect();
        ensure(
            parts.len() > 1
                && ["data", "dsps"].contains(&parts[0])
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains('\\'))
                && seen.insert(path),
            "invalid_backup_path",
            400,
        )?;
        let filename = source.join(path);
        db::private_file(&filename, false)?;
        ensure(
            fs::canonicalize(&filename)? == filename,
            "invalid_backup_file",
            400,
        )?;
        let bytes = fs::read(filename)?;
        ensure(
            bytes.len() as u64 == file["size"].as_u64().unwrap_or(u64::MAX)
                && crypto::sha(&bytes) == s(file, "sha256"),
            "backup_checksum_failed",
            400,
        )?;
    }
    db::private_dir(target)?;
    for file in files {
        let path = s(file, "path");
        db::write_private(&target.join(path), &fs::read(source.join(path))?)?;
    }
    let accounts = target.join("data/platform/accounts.sqlite");
    if accounts.exists() {
        let db = rusqlite::Connection::open(accounts)?;
        db.execute_batch(
            "DELETE FROM sessions;DELETE FROM resets;DELETE FROM invitations;DELETE FROM outbox;",
        )?;
    }
    for env in ["preview", "production"] {
        let jobs = target.join("data").join(env).join("jobs.sqlite");
        if jobs.exists() {
            let db = rusqlite::Connection::open(jobs)?;
            db.execute("UPDATE jobs SET status='cancelled',message='Cancelled after restore',error='state_restored',lease_owner=NULL,lease_until=NULL,completed_at=? WHERE status IN ('queued','running','waiting_verification')",[iso()])?;
        }
    }
    Ok(json!({"target":target,"files":files.len()}))
}

/// Read-only CLI inspection is safe while the serving process owns the write lock.
pub fn status(config: &Config) -> Result<Value> {
    let path = config.platform().join("accounts.sqlite");
    ensure(path.is_file(), "platform_not_initialized", 404)?;
    db::private_file(&path, false)?;
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let db = db::Db(connection);
    Ok(
        json!({"environment":config.environment,"runtime":"rust","dsps":db.all("SELECT name,environment,status FROM dsps",[])?}),
    )
}

/// The environment lock proves no previous core can own these ephemeral runs.
pub fn clean_browser_runs(config: &Config) -> Result<()> {
    let root = db::private_dir(&config.environment_root().join("browser-runs"))?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        ensure(
            db::identifier(&entry.file_name().to_string_lossy(), "run_")
                || db::identifier(&entry.file_name().to_string_lossy(), "browseros_"),
            "unexpected_browser_run",
            503,
        )?;
        db::private_dir(&entry.path())?;
        fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}
