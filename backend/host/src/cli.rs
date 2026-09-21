use crate::{
    Result, artifact,
    io::Native,
    management, releases, require,
    updater::{Environment, Updater},
};
use serde_json::{Value, json};
use std::{io::Read, path::Path};

pub fn run(args: &[String]) -> Result<()> {
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Dispatch host management: capabilities | artifact <inventory|write|verify|unpack|retarget|actions|download> ... | <dev|production> --root PATH [--verify|--verify-management|--install-management]"
        );
        return Ok(());
    }
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    let output = match args.as_slice() {
        ["capabilities"] => json!({"hostManagement":1,"artifactFormat":3}),
        ["artifact", "inventory", root] => {
            serde_json::to_value(artifact::inventory(Path::new(root))?)?
        }
        ["artifact", "write", root, version] => {
            serde_json::to_value(artifact::write_manifest(Path::new(root), version)?)?
        }
        ["artifact", "verify", root] => {
            serde_json::to_value(artifact::verify(Path::new(root), None)?)?
        }
        ["artifact", "verify", root, commit] => {
            serde_json::to_value(artifact::verify(Path::new(root), Some(commit))?)?
        }
        ["artifact", "unpack", archive, destination] => {
            artifact::unpack(Path::new(archive), Path::new(destination))?;
            Value::Null
        }
        ["artifact", "retarget", root, old, new] => {
            serde_json::to_value(artifact::retarget(Path::new(root), old, new)?)?
        }
        ["artifact", "actions", download, directory, package, commit] => {
            let record = stdin_json()?;
            serde_json::to_value(artifact::unpack_actions(
                Path::new(download),
                record["size_in_bytes"].as_u64().unwrap_or(0),
                record["digest"].as_str().unwrap_or(""),
                Path::new(directory),
                Path::new(package),
                commit,
            )?)?
        }
        ["artifact", "download", directory, commit, package] => {
            serde_json::to_value(releases::download_run(
                &Native,
                &stdin_json()?,
                Path::new(directory),
                commit,
                Some(Path::new(package)),
            )?)?
        }
        [environment, rest @ ..] if matches!(*environment, "dev" | "production") => {
            let environment = if *environment == "dev" {
                Environment::Dev
            } else {
                Environment::Production
            };
            let mut root = None;
            let mut mode = "update";
            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                match *arg {
                    "--root" => {
                        require(root.is_none(), "Duplicate root")?;
                        root = Some(*iter.next().ok_or("Root required")?);
                    }
                    "--verify" | "--verify-management" | "--install-management" => {
                        require(mode == "update", "Choose one operation")?;
                        mode = arg;
                    }
                    _ => return Err("Unknown updater argument".into()),
                }
            }
            let updater = Updater::new(
                Path::new(root.ok_or("Root required")?),
                environment,
                &Native,
            )?;
            match mode {
                "--verify" => {
                    updater.verify()?;
                }
                "--verify-management" => {
                    updater.verify()?;
                    require(
                        !management::drift(&updater)?,
                        "Installed host updater differs from the active runtime",
                    )?;
                }
                "--install-management" => management::install(&updater)?,
                _ => updater.run_locked()?,
            }
            Value::Null
        }
        _ => return Err("Unknown host command; use --help".into()),
    };
    println!("{output}");
    Ok(())
}
fn stdin_json() -> Result<Value> {
    let mut bytes = vec![];
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    require(bytes.len() <= 1024 * 1024, "Input too large")?;
    Ok(serde_json::from_slice(&bytes)?)
}
