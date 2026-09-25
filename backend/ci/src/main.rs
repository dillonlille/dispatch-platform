use dispatch_ci::{Native, Result};
use std::path::PathBuf;
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let command = args.first().ok_or("Choose build, preflight or ship")?;
    if command == "ship" {
        // The launcher appends `--root`, which shipping does not need.
        let number = match &args[1..] {
            [number] | [number, _, _] => number.parse::<u64>().ok(),
            _ => None,
        }
        .ok_or("Usage: npm run pr:ship -- <PR number>")?;
        let merge = dispatch_ci::ship::run(
            number,
            &Native,
            &|seconds| std::thread::sleep(std::time::Duration::from_secs(seconds)),
            &mut |text| println!("{text}"),
        )?;
        println!("#{number} merged as {merge}");
        return Ok(());
    }
    let mut root = std::env::current_dir()?;
    let mut release = false;
    let mut cache_key = false;
    let mut concurrent = false;
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
    Err("Unknown CI command".into())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
