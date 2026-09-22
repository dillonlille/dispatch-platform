//! Bounded subprocess execution shared by CI and host management.
use crate::{Result, require};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
pub fn command(
    args: &[&str],
    cwd: Option<&Path>,
    timeout: u64,
    output: Option<&Path>,
) -> Result<Vec<u8>> {
    execute(args, cwd, timeout, output, None)
}
/// Run bootstrap with only explicitly supplied environment and private stdin.
/// Child output is never included in an error that could expose initial credentials.
pub fn isolated(
    args: &[&str],
    cwd: &Path,
    timeout: u64,
    env: &std::collections::BTreeMap<String, String>,
    input: &[u8],
) -> Result<()> {
    execute(args, Some(cwd), timeout, None, Some((env, input))).map(|_| ())
}
type PrivateInput<'a> = (&'a std::collections::BTreeMap<String, String>, &'a [u8]);
fn execute(
    args: &[&str],
    cwd: Option<&Path>,
    timeout: u64,
    output: Option<&Path>,
    private: Option<PrivateInput<'_>>,
) -> Result<Vec<u8>> {
    let stdout = tempfile::tempfile()?;
    let stderr = tempfile::tempfile()?;
    let output_file = output
        .map(|path| {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
        })
        .transpose()?;
    let sink = output_file.as_ref().unwrap_or(&stdout);
    let mut command = Command::new(args.first().ok_or("Missing command")?);
    command
        .args(&args[1..])
        .stdin(Stdio::null())
        .stdout(sink.try_clone()?)
        .stderr(stderr.try_clone()?)
        .process_group(0);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    if let Some((env, bytes)) = private {
        use std::io::{Seek, SeekFrom, Write};
        let mut input = tempfile::tempfile()?;
        input.write_all(bytes)?;
        input.seek(SeekFrom::Start(0))?;
        command.env_clear().envs(env).stdin(input);
    }
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let spawn_deadline = deadline.min(Instant::now() + Duration::from_secs(1));
    let mut child = loop {
        match command.spawn() {
            Ok(child) => break child,
            // A concurrent fork can retain a just-closed writable descriptor
            // until exec. This affects staged smoke/management executables;
            // retry only ETXTBSY, within the command's original timeout.
            Err(error)
                if error.raw_os_error() == Some(libc::ETXTBSY)
                    && Instant::now() < spawn_deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    };
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline
            || sink.metadata()?.len() > MAX_BYTES
            || stderr.metadata()?.len() > 1024 * 1024
        {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            return Err(format!("{} timed out or exceeded output limit", args[0]).into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if !status.success() {
        if private.is_some() {
            return Err("Bootstrap command failed; initial credentials remain private".into());
        }
        use std::io::{Seek, SeekFrom};
        let mut stderr = stderr;
        stderr.seek(SeekFrom::Start(
            stderr.metadata()?.len().saturating_sub(600),
        ))?;
        let mut bytes = vec![];
        stderr.read_to_end(&mut bytes)?;
        return Err(format!(
            "{} failed: {}",
            args[..args.len().min(3)].join(" "),
            String::from_utf8_lossy(&bytes).trim()
        )
        .into());
    }
    if output.is_some() {
        require(sink.metadata()?.len() <= MAX_BYTES, "Download is too large")?;
        return Ok(vec![]);
    }
    require(
        stdout.metadata()?.len() <= 16 * 1024 * 1024,
        "Command output is too large",
    )?;
    use std::io::{Seek, SeekFrom};
    let mut stdout = stdout;
    stdout.seek(SeekFrom::Start(0))?;
    let mut bytes = vec![];
    stdout.read_to_end(&mut bytes)?;
    Ok(bytes)
}
