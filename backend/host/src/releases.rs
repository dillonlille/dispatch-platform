use crate::{
    MAX_BYTES, REPOSITORY, Result, artifact,
    io::{self, System},
    require,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

pub fn latest_run<'a>(
    runs: &'a Value,
    sha: &str,
    event: &str,
    branch: Option<&str>,
    skipped: bool,
) -> Option<&'a Value> {
    runs.as_array()?
        .iter()
        .filter(|r| {
            r["head_sha"] == sha
                && r["event"] == event
                && (skipped || r["conclusion"] != "skipped")
                && branch.is_none_or(|b| r["head_branch"] == b)
                && r["head_repository"]["full_name"] == REPOSITORY
        })
        .max_by_key(|r| {
            (
                r["id"].as_u64().unwrap_or(0),
                r["run_attempt"].as_u64().unwrap_or(1),
            )
        })
}
pub fn passed(run: &Value) -> bool {
    run["status"] == "completed" && run["conclusion"] == "success"
}
pub fn download_run(
    system: &dyn System,
    record: &Value,
    directory: &Path,
    commit: &str,
    package: Option<&Path>,
) -> Result<artifact::Manifest> {
    let size = record["size_in_bytes"].as_u64().unwrap_or(0);
    require(size > 0 && size <= MAX_BYTES, "Invalid artifact size")?;
    let id = record["id"].as_u64().ok_or("Invalid artifact id")?;
    let download = directory.join("artifact.zip");
    system.command(
        &[
            "gh",
            "api",
            &format!("repos/{REPOSITORY}/actions/artifacts/{id}/zip"),
        ],
        None,
        180,
        Some(&download),
    )?;
    artifact::unpack_actions(
        &download,
        size,
        record["digest"].as_str().unwrap_or(""),
        directory,
        package.unwrap_or(&directory.join("build.tar.gz")),
        commit,
    )
}
pub fn version(value: &str) -> Result<Vec<u64>> {
    require(
        regex::Regex::new(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")?
            .is_match(value),
        "Stable semantic version required",
    )?;
    Ok(value
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?)
}
pub fn release_version(release: &Value) -> Result<String> {
    require(
        release["draft"] == false
            && release["prerelease"] == false
            && release["published_at"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
        "Published stable release required",
    )?;
    let tag = release["tag_name"].as_str().unwrap_or("");
    let value = tag.strip_prefix('v').ok_or("Version tag required")?;
    version(value)?;
    Ok(value.into())
}
pub fn public_github(system: &dyn System, endpoint: &str) -> Result<Value> {
    io::json_response(system.request(
        &format!("https://api.github.com/repos/{REPOSITORY}/{endpoint}"),
        false,
        true,
        30,
    )?)
}
pub fn latest_tag(system: &dyn System) -> Option<String> {
    let response = system
        .request(
            &format!("https://github.com/{REPOSITORY}/releases/latest"),
            true,
            false,
            15,
        )
        .ok()?;
    if response.status != 302 {
        return None;
    }
    response
        .location?
        .strip_prefix(&format!("https://github.com/{REPOSITORY}/releases/tag/"))
        .map(str::to_owned)
}
pub fn release_commit(system: &dyn System, tag: &str) -> Result<String> {
    require(tag.starts_with('v'), "Version tag required")?;
    version(&tag[1..])?;
    let mut object = public_github(system, &format!("git/ref/tags/{tag}"))?["object"].clone();
    for _ in 0..5 {
        if object["type"] == "commit" {
            break;
        }
        let sha = object["sha"].as_str().unwrap_or("");
        require(
            object["type"] == "tag" && artifact::hex(sha, 40),
            "Invalid tag",
        )?;
        object = public_github(system, &format!("git/tags/{sha}"))?["object"].clone();
    }
    let commit = io::text(&object, "sha");
    require(
        object["type"] == "commit" && artifact::hex(&commit, 40),
        "Invalid tag commit",
    )?;
    let comparison = public_github(system, &format!("compare/{commit}...main"))?;
    require(
        matches!(comparison["status"].as_str(), Some("ahead" | "identical")),
        "Release is not part of main",
    )?;
    Ok(commit)
}
pub fn download_asset(
    system: &dyn System,
    release: &Value,
    name: &str,
    target: &Path,
) -> Result<()> {
    let assets: Vec<_> = release["assets"]
        .as_array()
        .ok_or("Missing release assets")?
        .iter()
        .filter(|a| a["name"] == name && a["state"] == "uploaded")
        .collect();
    require(assets.len() == 1, "Release asset missing or duplicated")?;
    let asset = assets[0];
    let size = asset["size"].as_u64().unwrap_or(0);
    require(size > 0 && size <= MAX_BYTES, "Invalid release asset size")?;
    let url = format!(
        "https://github.com/{REPOSITORY}/releases/download/{}/{name}",
        io::text(release, "tag_name")
    );
    require(
        asset["browser_download_url"] == url,
        "Unexpected release asset URL",
    )?;
    let expected = io::text(asset, "digest");
    require(
        expected
            .strip_prefix("sha256:")
            .is_some_and(|h| artifact::hex(h, 64)),
        "GitHub asset digest required",
    )?;
    let mut response = system.request(&url, false, true, 60)?;
    require(response.status == 200, "Release download failed")?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(target)?;
    let (mut digest, mut total) = (Sha256::new(), 0u64);
    let mut bytes = [0; 65536];
    loop {
        let n = response.body.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        require(total <= size, "Download exceeds declared size")?;
        digest.update(&bytes[..n]);
        output.write_all(&bytes[..n])?;
    }
    require(
        total == size && format!("sha256:{:x}", digest.finalize()) == expected,
        "GitHub asset digest mismatch",
    )
}
