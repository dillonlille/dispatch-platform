//! The gate job's artifact check: the packaged build carries the run's own source commit and
//! a complete, untampered inventory before it is published for Dev and releases.
use crate::{Result, artifact, io::System};
use std::path::Path;

pub fn run(args: &[String], _system: &dyn System) -> Result<()> {
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["verify", archive] => {
            let temp = tempfile::Builder::new()
                .prefix("dispatch-ci-artifact-")
                .tempdir()?;
            let root = temp.path().join("build");
            artifact::unpack(Path::new(archive), &root)?;
            artifact::verify(&root, Some(&std::env::var("GITHUB_SHA")?))?;
            println!("Candidate inventory and source commit verified");
        }
        _ => return Err("Unknown CI artifact command".into()),
    }
    Ok(())
}
