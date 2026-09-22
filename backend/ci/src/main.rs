use dispatch_ci::{
    Native, Result,
    policy::{Environment, Policy, gate},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
fn append(variable: &str, text: &str) -> Result<()> {
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(std::env::var(variable)?)?
        .write_all(text.as_bytes())?;
    Ok(())
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let command = args.first().ok_or("Choose plan, receipt or gate")?;
    let mut root = std::env::current_dir()?;
    let mut release = false;
    let mut cache_key = false;
    let mut concurrent = false;
    let mut scope = None;
    let mut output = None;
    let mut options = args[1..].iter();
    while let Some(option) = options.next() {
        match option.as_str() {
            "--release" => {
                release = true;
                continue;
            }
            "--cache-key" => {
                cache_key = true;
                continue;
            }
            "--allow-concurrent" => {
                concurrent = true;
                continue;
            }
            _ => {}
        }
        let value = options.next().ok_or("Missing option value")?;
        match option.as_str() {
            "--root" => root = PathBuf::from(value),
            "--scope" => scope = Some(value),
            "--output" => output = Some(PathBuf::from(value)),
            _ => return Err("Unknown CI option".into()),
        }
    }
    if command == "build" {
        let env = std::env::vars().collect();
        if cache_key {
            let key = if release && dispatch_ci::cache::eligible(&root, &env, true)? {
                dispatch_ci::cache::key(&root, "release", &env, &Native)?
            } else {
                String::new()
            };
            println!("key={key}");
            return Ok(());
        }
        return dispatch_ci::cache::build(&root, release, &env, &Native);
    }
    if command == "preflight" {
        return dispatch_ci::preflight::run(&root, concurrent, &Native);
    }
    if command == "gate" {
        let needs = serde_json::from_str(&std::env::var("CI_NEEDS")?)?;
        println!("All required {} suites passed", gate(&needs)?);
        return Ok(());
    }
    let event = serde_json::from_slice(&fs::read(std::env::var("GITHUB_EVENT_PATH")?)?)?;
    let policy = Policy {
        root: &root,
        runner: &Native,
    };
    let env = Environment::current();
    match command.as_str() {
        "plan" => {
            let (selected, reason) = policy.plan(&env, &event);
            println!("Validation: {selected} — {reason}");
            append("GITHUB_OUTPUT", &format!("mode={selected}\n"))?;
            append(
                "GITHUB_STEP_SUMMARY",
                &format!("Validation: **{selected}**. {reason}.\n"),
            )?;
        }
        "receipt" => {
            let receipt = policy.receipt(&env, &event, scope.ok_or("Scope required")?)?;
            fs::write(output.ok_or("Output required")?, format!("{receipt}\n"))?;
        }
        _ => return Err("Unknown CI command".into()),
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
