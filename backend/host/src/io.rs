use crate::{REPOSITORY, Result, require};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub struct Response {
    pub status: u16,
    pub location: Option<String>,
    pub body: Box<dyn Read>,
}
/// The only host effects. Tests supply services/network/time while retaining real
/// directories, archives, process entry points, receipts and advisory locks.
pub trait System {
    fn command(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        timeout: u64,
        output: Option<&Path>,
    ) -> Result<Vec<u8>>;
    fn bootstrap(
        &self,
        _args: &[&str],
        _cwd: &Path,
        _env: &std::collections::BTreeMap<String, String>,
        _input: &[u8],
    ) -> Result<()> {
        Err("Bootstrap execution unavailable".into())
    }
    fn request(&self, url: &str, head: bool, follow: bool, timeout: u64) -> Result<Response>;
    fn now(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    }
    fn monotonic(&self) -> Duration {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
pub struct Native;
impl System for Native {
    fn command(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        timeout: u64,
        output: Option<&Path>,
    ) -> Result<Vec<u8>> {
        dispatch_ci::process::command(args, cwd, timeout, output)
    }

    fn bootstrap(
        &self,
        args: &[&str],
        cwd: &Path,
        env: &std::collections::BTreeMap<String, String>,
        input: &[u8],
    ) -> Result<()> {
        dispatch_ci::process::isolated(args, cwd, 120, env, input)
    }

    fn request(&self, url: &str, head: bool, follow: bool, timeout: u64) -> Result<Response> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .https_only(!url.starts_with("http://127.0.0.1:"))
            .timeout(Duration::from_secs(timeout))
            .redirect(if follow {
                reqwest::redirect::Policy::limited(10)
            } else {
                reqwest::redirect::Policy::none()
            })
            .build()?;
        let request = if head {
            client.head(url)
        } else {
            client.get(url)
        };
        let response = request
            .header("User-Agent", "dispatch-production-updater")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()?;
        Ok(Response {
            status: response.status().as_u16(),
            location: response
                .headers()
                .get("Location")
                .and_then(|s| s.to_str().ok())
                .map(str::to_owned),
            body: Box::new(response),
        })
    }
}
pub fn json_response(response: Response) -> Result<Value> {
    require((200..300).contains(&response.status), "HTTP request failed")?;
    let mut bytes = vec![];
    response
        .body
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    require(
        bytes.len() <= 16 * 1024 * 1024,
        "JSON response is too large",
    )?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn github(system: &dyn System, endpoint: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&system.command(
        &["gh", "api", &format!("repos/{REPOSITORY}/{endpoint}")],
        None,
        120,
        None,
    )?)?)
}
pub fn private_directory(directory: &Path) -> Result<()> {
    require(
        !directory.is_symlink(),
        "Private directory cannot be a symlink",
    )?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    crate::artifact::real_directory(directory)?;
    let info = directory.metadata()?;
    require(
        info.uid() == unsafe { libc::getuid() } && info.mode() & 0o077 == 0,
        "Private directory permissions required",
    )
}
pub fn write_json(filename: &Path, value: &Value) -> Result<()> {
    let parent = filename.parent().ok_or("Invalid receipt path")?;
    private_directory(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(filename)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_json(filename: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(filename)?)?)
}
pub fn remove_receipt(filename: &Path) -> Result<()> {
    fs::remove_file(filename)?;
    File::open(filename.parent().ok_or("Invalid receipt path")?)?.sync_all()?;
    Ok(())
}
pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").into()
}

pub struct ExclusiveLock(fs::File);
impl ExclusiveLock {
    pub fn acquire(path: &Path) -> Result<Self> {
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        fs2::FileExt::try_lock_exclusive(&file)?;
        Ok(Self(file))
    }
}
impl Drop for ExclusiveLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}
