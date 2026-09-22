use super::*;
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Prepared {
    repository: String,
    pub commit: String,
    version: String,
    workflow_run: u64,
    workflow_attempt: u64,
    artifact_id: u64,
    artifact_digest: String,
    pub runtime_digest: String,
    archive_sha256: String,
}

fn regular(path: &Path) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    require(
        info.is_file() && !info.is_symlink() && info.nlink() == 1 && info.len() <= crate::MAX_BYTES,
        "Release assets must be bounded regular files",
    )
}
fn checksums(directory: &Path, names: &[String]) -> Result<String> {
    let mut result = String::new();
    for name in names {
        result.push_str(&format!(
            "{}  {name}\n",
            artifact::file_hash(&directory.join(name))?
        ));
    }
    Ok(result)
}

impl Release<'_> {
    fn archive(&self) -> String {
        format!("dispatch-platform-{}.tar.gz", self.version)
    }
    fn asset_names(&self) -> Vec<String> {
        vec![
            self.archive(),
            "release.json".into(),
            "provenance.json".into(),
            "SHA256SUMS".into(),
        ]
    }
    pub(super) fn prepared(&self, commit: Option<&str>) -> Result<Prepared> {
        self.verify_preparation(&self.output, commit)
    }
    fn verify_preparation(&self, directory: &Path, commit: Option<&str>) -> Result<Prepared> {
        artifact::real_directory(directory)?;
        let names = self.asset_names();
        for name in &names {
            regular(&directory.join(name))?;
        }
        let prepared: Prepared =
            serde_json::from_value(io::read_json(&directory.join("provenance.json"))?)?;
        require(
            crate::REPOSITORIES.contains(&prepared.repository.as_str())
                && prepared.version == self.version
                && artifact::hex(&prepared.commit, 40)
                && commit.is_none_or(|c| c == prepared.commit)
                && prepared.workflow_run > 0
                && prepared.workflow_attempt > 0
                && prepared.artifact_id > 0
                && prepared
                    .artifact_digest
                    .strip_prefix("sha256:")
                    .is_some_and(|h| artifact::hex(h, 64))
                && artifact::hex(&prepared.runtime_digest, 64)
                && artifact::hex(&prepared.archive_sha256, 64),
            "Prepared provenance does not match this release",
        )?;
        require(
            fs::read_to_string(directory.join("SHA256SUMS"))? == checksums(directory, &names[..3])?
                && artifact::file_hash(&directory.join(self.archive()))? == prepared.archive_sha256,
            "Prepared release bytes changed; preserve this directory and inspect it",
        )?;
        let mut value = io::read_json(&directory.join("release.json"))?;
        let manifest: artifact::Manifest = serde_json::from_value(value.clone())?;
        value
            .as_object_mut()
            .ok_or("Invalid manifest")?
            .shift_remove("digest");
        require(
            manifest.format == 3
                && manifest.schema == 3
                && manifest.runtime == "rust"
                && manifest.version == self.version
                && manifest.digest == prepared.runtime_digest
                && artifact::hash(&serde_json::to_vec(&value)?) == manifest.digest,
            "Prepared manifest differs from provenance",
        )?;
        require(
            self.journal()?
                .commit
                .as_ref()
                .is_none_or(|c| *c == prepared.commit),
            "Prepared release commit changed",
        )?;
        Ok(prepared)
    }
    pub(super) fn prepare(&self, commit: &str) -> Result<Prepared> {
        if self.output.try_exists()? {
            return self.prepared(Some(commit)).map_err(|error| format!(
                "Existing preparation {} is incomplete or changed: {error}. Preserve it for inspection",
                self.output.display()
            ).into());
        }
        self.checks(commit, "push", Some("main"), true)?;
        let run = self.checked_source(commit)?;
        let records = io::github(
            self.system,
            &format!("actions/runs/{}/artifacts?per_page=100", run["id"]),
        )?;
        let artifacts: Vec<_> = records["artifacts"]
            .as_array()
            .ok_or("Missing main artifacts")?
            .iter()
            .filter(|a| a["name"] == format!("dispatch-main-{commit}") && a["expired"] == false)
            .collect();
        require(artifacts.len() == 1, "Verified main artifact unavailable")?;
        io::private_directory(&self.directory)?;
        // A failed download never creates the final directory. A killed process
        // may leave a private staging directory; retries leave it untouched.
        let staging = tempfile::Builder::new()
            .prefix(&format!(".prepare-{}-", self.tag))
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(&self.directory)?;
        let download = tempfile::tempdir_in(staging.path())?;
        let manifest = releases::download_run(
            self.system,
            artifacts[0],
            download.path(),
            commit,
            Some(&staging.path().join(self.archive())),
        )?;
        require(
            manifest.version == self.version,
            "Compiled artifact has another version",
        )?;
        fs::copy(
            download.path().join("candidate/release.json"),
            staging.path().join("release.json"),
        )?;
        let prepared = Prepared {
            repository: REPOSITORY.into(),
            commit: commit.into(),
            version: self.version.clone(),
            workflow_run: run["id"].as_u64().ok_or("Invalid workflow id")?,
            workflow_attempt: run["run_attempt"]
                .as_u64()
                .ok_or("Invalid workflow attempt")?,
            artifact_id: artifacts[0]["id"].as_u64().ok_or("Invalid artifact id")?,
            artifact_digest: io::text(artifacts[0], "digest"),
            runtime_digest: manifest.digest,
            archive_sha256: artifact::file_hash(&staging.path().join(self.archive()))?,
        };
        io::write_json(
            &staging.path().join("provenance.json"),
            &serde_json::to_value(&prepared)?,
        )?;
        fs::write(
            staging.path().join("SHA256SUMS"),
            checksums(staging.path(), &self.asset_names()[..3])?,
        )?;
        download.close()?;
        self.verify_preparation(staging.path(), Some(commit))?;
        for name in self.asset_names() {
            File::open(staging.path().join(name))?.sync_all()?;
        }
        File::open(staging.path())?.sync_all()?;
        let from = CString::new(staging.path().as_os_str().as_bytes())?;
        let to = CString::new(self.output.as_os_str().as_bytes())?;
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        File::open(&self.directory)?.sync_all()?;
        say(format!(
            "Prepared {} from checked main commit {commit}: {}",
            self.version, prepared.runtime_digest
        ));
        Ok(prepared)
    }
    fn smoke_receipt(&self, prepared: &Prepared) -> Value {
        json!({"commit":prepared.commit,"runtimeDigest":prepared.runtime_digest,"archiveSha256":prepared.archive_sha256})
    }
    pub(super) fn smoke(&self, prepared: &Prepared) -> Result<()> {
        self.prepared(Some(&prepared.commit))?;
        let receipt = self.output.join("smoke-verification.json");
        let expected = self.smoke_receipt(prepared);
        if receipt.try_exists()? && io::read_json(&receipt)? == expected {
            return Ok(());
        }
        let tsx = self.root.join("node_modules/.bin/tsx");
        require(
            tsx.is_file(),
            "Install this checkout's Node packages for the release smoke check",
        )?;
        let temporary = tempfile::Builder::new()
            .prefix("dispatch-release-smoke-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()?;
        let build = temporary.path().join(".build");
        artifact::unpack(&self.output.join(self.archive()), &build)?;
        let manifest = artifact::verify(&build, Some(&prepared.commit))?;
        require(
            manifest.digest == prepared.runtime_digest && manifest.version == self.version,
            "Archive differs from prepared manifest",
        )?;
        fs::set_permissions(
            build.join("services/rust/dispatch-backend"),
            fs::Permissions::from_mode(0o700),
        )?;
        self.command(
            &[
                tsx.to_str().ok_or("Invalid Node path")?,
                self.root
                    .join("tooling/testing/browser-check.ts")
                    .to_str()
                    .ok_or("Invalid smoke path")?,
                "--smoke-only",
            ],
            Some(temporary.path()),
            300,
        )?;
        io::write_json(&receipt, &expected)
    }
    fn verify_assets(&self, release: &Value, allow_missing: bool) -> Result<Vec<String>> {
        let names = self.asset_names();
        let assets = release["assets"]
            .as_array()
            .ok_or("Missing GitHub assets")?;
        let mut found = BTreeSet::new();
        for asset in assets {
            let name = asset["name"].as_str().ok_or("Invalid asset name")?;
            require(
                names.iter().any(|n| n == name) && found.insert(name),
                "Unexpected or duplicated release asset",
            )?;
            let local = self.output.join(name);
            require(
                asset["state"] == "uploaded"
                    && asset["size"].as_u64() == Some(local.metadata()?.len())
                    && asset["digest"] == format!("sha256:{}", artifact::file_hash(&local)?),
                &format!(
                    "{name} differs from prepared bytes or its upload is incomplete; existing assets are never overwritten"
                ),
            )?;
        }
        let missing: Vec<_> = names
            .into_iter()
            .filter(|n| !found.contains(n.as_str()))
            .collect();
        require(
            allow_missing || missing.is_empty(),
            "Release assets are missing",
        )?;
        Ok(missing)
    }
    fn tag_commit(&self) -> Result<Option<String>> {
        let refs = self.api(&format!("git/matching-refs/tags/{}", self.tag), &[])?;
        let refs: Vec<_> = refs
            .as_array()
            .ok_or("Invalid tag refs")?
            .iter()
            .filter(|r| r["ref"] == format!("refs/tags/{}", self.tag))
            .collect();
        require(refs.len() <= 1, "Duplicate release tag")?;
        let Some(reference) = refs.first() else {
            return Ok(None);
        };
        let mut object = reference["object"].clone();
        for _ in 0..5 {
            if object["type"] == "commit" {
                break;
            }
            require(
                object["type"] == "tag" && artifact::hex(&io::text(&object, "sha"), 40),
                "Invalid release tag",
            )?;
            object =
                self.api(&format!("git/tags/{}", io::text(&object, "sha")), &[])?["object"].clone();
        }
        let commit = io::text(&object, "sha");
        require(
            object["type"] == "commit" && artifact::hex(&commit, 40),
            "Invalid release tag commit",
        )?;
        Ok(Some(commit))
    }
    fn verify_identity(&self, release: &Value, prepared: &Prepared) -> Result<()> {
        require(
            release["tag_name"] == self.tag && release["prerelease"] == false,
            "Expected stable release",
        )?;
        let tag = self.tag_commit()?;
        if release["draft"] == true {
            require(
                release["target_commitish"] == prepared.commit
                    && tag.as_ref().is_none_or(|c| *c == prepared.commit),
                "Draft targets another commit",
            )?;
        } else {
            require(
                releases::release_version(release)? == self.version
                    && tag.as_deref() == Some(&prepared.commit),
                "Published tag differs from prepared commit",
            )?;
        }
        Ok(())
    }
    fn wait_release(&self) -> Result<Value> {
        let deadline = self.system.monotonic() + Duration::from_secs(60);
        loop {
            if let Some(release) = self.listed_release()? {
                return Ok(release);
            }
            require(
                self.system.monotonic() < deadline,
                "Release is not yet visible; rerun to inspect it",
            )?;
            self.system.sleep(Duration::from_secs(3));
        }
    }
    pub(super) fn ensure_draft(&self, prepared: &Prepared) -> Result<Value> {
        self.prepared(Some(&prepared.commit))?;
        self.checked_source(&prepared.commit)?;
        let release = match self.listed_release()? {
            Some(release) => release,
            None => {
                say(format!("Release notes: {}", self.notes.display()));
                let deadline = self.system.monotonic() + Duration::from_secs(1800);
                while !self.notes.try_exists()?
                    || fs::read_to_string(&self.notes)?.trim().is_empty()
                {
                    require(
                        self.system.monotonic() < deadline,
                        "Release notes are still missing; write them and rerun",
                    )?;
                    self.system.sleep(Duration::from_secs(5));
                }
                // Keep a durable copy before creating the draft. Missing uploads
                // are added on retry; a conflicting existing upload stops it.
                let notes = fs::read(&self.notes)?;
                let mut saved = tempfile::NamedTempFile::new_in(&self.output)?;
                saved.write_all(&notes)?;
                saved.as_file().sync_all()?;
                saved.persist(self.output.join("notes.md"))?;
                File::open(&self.output)?.sync_all()?;
                self.command(
                    &[
                        "gh",
                        "release",
                        "create",
                        &self.tag,
                        "--repo",
                        REPOSITORY,
                        "--draft",
                        "--target",
                        &prepared.commit,
                        "--title",
                        &format!("Dispatch {}", self.version),
                        "--notes-file",
                        self.output
                            .join("notes.md")
                            .to_str()
                            .ok_or("Invalid notes path")?,
                    ],
                    None,
                    600,
                )?;
                self.wait_release()?
            }
        };
        require(release["draft"] == true, "Release is already published")?;
        self.verify_identity(&release, prepared)?;
        let missing = self.verify_assets(&release, true)?;
        for name in missing {
            self.command(
                &[
                    "gh",
                    "release",
                    "upload",
                    &self.tag,
                    "--repo",
                    REPOSITORY,
                    self.output
                        .join(name)
                        .to_str()
                        .ok_or("Invalid asset path")?,
                ],
                None,
                600,
            )?;
        }
        let release = self.wait_release()?;
        require(
            release["draft"] == true,
            "Release was published while preparing",
        )?;
        self.verify_identity(&release, prepared)?;
        self.verify_assets(&release, false)?;
        io::write_json(
            &self.output.join("draft-verification.json"),
            &json!({"releaseId":release["id"],"assetsVerified":true,"commit":prepared.commit}),
        )?;
        say(format!(
            "Verified draft: {}",
            io::text(&release, "html_url")
        ));
        Ok(release)
    }
    pub(super) fn publish(&self, prepared: &Prepared) -> Result<Value> {
        let release = self
            .listed_release()?
            .ok_or("No draft exists; run prepare first")?;
        self.verify_identity(&release, prepared)?;
        if release["draft"] == false {
            self.verify_assets(&release, false)?;
            return Ok(release);
        }
        self.checked_source(&prepared.commit)?;
        self.smoke(prepared)?;
        let release = self.ensure_draft(prepared)?;
        // Recheck after uploads/smoke: a newer failed or pending run must stop publication.
        self.checked_source(&prepared.commit)?;
        self.api(
            &format!("releases/{}", release["id"]),
            &[
                "--method",
                "PATCH",
                "-F",
                "draft=false",
                "-f",
                "make_latest=true",
            ],
        )?;
        let release = self.wait_release()?;
        require(
            release["draft"] == false,
            "Publication is not yet visible; rerun to inspect it",
        )?;
        self.verify_identity(&release, prepared)?;
        self.verify_assets(&release, false)?;
        say(format!("Published {}", io::text(&release, "html_url")));
        Ok(release)
    }
    fn fetch(&self, path: &str) -> Result<Vec<u8>> {
        let response = self
            .system
            .request(&format!("{PRODUCTION}{path}"), false, true, 20)?;
        require(
            response.status == 200,
            "Production returned an unsuccessful response",
        )?;
        let mut bytes = vec![];
        response
            .body
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        require(
            !bytes.is_empty() && bytes.len() <= 16 * 1024 * 1024,
            "Production response empty or oversized",
        )?;
        Ok(bytes)
    }
    pub(super) fn verify_production(&self, prepared: &Prepared, release: &Value) -> Result<()> {
        say("Waiting for Production to install the release");
        let deadline = self.system.monotonic() + Duration::from_secs(600);
        let health = loop {
            if let Ok(bytes) = self.fetch("/api/health")
                && let Ok(health) = serde_json::from_slice::<Value>(&bytes)
                && health["release"] == prepared.runtime_digest
                && health["status"] == "ready"
                && health["environment"] == "production"
            {
                break health;
            }
            require(
                self.system.monotonic() < deadline,
                "Production did not report the release digest; inspect its updater with read-only access, then rerun",
            )?;
            self.system.sleep(Duration::from_secs(5));
        };
        let html = String::from_utf8(self.fetch("/")?)?;
        let pattern = regex::Regex::new(r#"(?:src|href)="(\.?/assets/[^\"]+)""#)?;
        let assets: BTreeSet<_> = pattern
            .captures_iter(&html)
            .map(|c| c[1].to_owned())
            .collect();
        require(
            assets.len() >= 2,
            "Production dashboard is missing its assets",
        )?;
        for asset in &assets {
            self.fetch(&format!("/{}", asset.trim_start_matches(['.', '/'])))?;
        }
        io::write_json(
            &self.output.join("deployment-verification.json"),
            &json!({
            "version":self.version,"commit":prepared.commit,"runtimeDigest":prepared.runtime_digest,
            "publicHealth":health,"publicAssetsVerified":assets.len(),"mainCheckRun":prepared.workflow_run,
            "release":release["html_url"]}),
        )
    }
}
