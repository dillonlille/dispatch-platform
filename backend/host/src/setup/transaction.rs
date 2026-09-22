use super::*;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Journal {
    format: u32,
    options: Options,
    pub staging: String,
    pub prepared: bool,
    pub commit: String,
    pub digest: String,
    pub inventory: BTreeMap<String, BTreeMap<String, String>>,
}
impl Journal {
    pub fn new(options: &Options, staging: &str) -> Self {
        Self {
            format: 1,
            options: options.clone(),
            staging: staging.into(),
            prepared: false,
            commit: String::new(),
            digest: String::new(),
            inventory: BTreeMap::new(),
        }
    }
    pub fn validate(&self, options: &Options) -> Result<()> {
        require(
            self.format == 1
                && self.options == *options
                && self.staging.starts_with(".setup-")
                && self.staging.len() > 7
                && self
                    .staging
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte)),
            "Setup journal differs; preserve it and inspect the unfinished initialization",
        )?;
        let stage = options.root.join(".runtime").join(&self.staging);
        artifact::real_directory(&stage)?;
        if self.prepared {
            require(
                artifact::hex(&self.commit, 40) && artifact::hex(&self.digest, 64),
                "Invalid prepared setup journal",
            )?;
        }
        Ok(())
    }
    pub fn placements(&self) -> Vec<(&'static str, &'static str)> {
        let mut paths = vec![
            ("data", "data"),
            ("dsps", "dsps"),
            (
                "management",
                if self.options.production {
                    "management"
                } else {
                    ".runtime/management"
                },
            ),
        ];
        if self.options.production {
            paths.push(("live", "live"));
        }
        paths.push(("config", "config"));
        paths
    }
    pub fn write(&self) -> Result<()> {
        io::write_json(
            &self.options.root.join(".runtime/setup.json"),
            &serde_json::to_value(self)?,
        )
    }
}
pub(super) fn fresh(options: &Options) -> Result<()> {
    let journal = Journal::new(options, "unused");
    for (_, target) in journal.placements() {
        let target = options.root.join(target);
        require(
            !target.exists() && !target.is_symlink(),
            "Environment already contains private state or management; preserve existing initialization",
        )?;
    }
    Ok(())
}
fn inventory(root: &Path) -> Result<BTreeMap<String, String>> {
    fn visit(root: &Path, directory: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
        artifact::real_directory(directory)?;
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            require(!path.is_symlink(), "Setup symlink denied")?;
            let info = path.symlink_metadata()?;
            if info.is_dir() {
                visit(root, &path, files)?;
            } else {
                require(
                    info.is_file() && info.nlink() == 1,
                    "Setup special file or hardlink denied",
                )?;
                fs::File::open(&path)?.sync_all()?;
                files.insert(
                    path.strip_prefix(root)?
                        .to_str()
                        .ok_or("Invalid setup path")?
                        .into(),
                    artifact::file_hash(&path)?,
                );
            }
        }
        fs::File::open(directory)?.sync_all()?;
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files)?;
    Ok(files)
}
pub(super) fn snapshot(
    root: &Path,
    placements: &[(&str, &str)],
) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    placements
        .iter()
        .map(|(name, _)| Ok(((*name).into(), inventory(&root.join(name))?)))
        .collect()
}
pub(super) fn publish(journal: &Journal) -> Result<()> {
    let root = &journal.options.root;
    let staging = root.join(".runtime").join(&journal.staging);
    journal.validate(&journal.options)?;
    require(journal.prepared, "Setup has not finished staging")?;
    // Configuration is published last. Its identity proves every earlier rename
    // completed, even if the application started before setup removed its journal.
    let finished = !staging.join("config").exists() && root.join("config/setup.json").is_file();
    if finished {
        require(
            io::read_json(&root.join("config/setup.json"))?["staging"] == journal.staging,
            "Setup identity changed",
        )?;
    } else {
        for (name, target) in journal.placements() {
            let source = staging.join(name);
            let destination = root.join(target);
            let actual = if source.exists() {
                &source
            } else {
                &destination
            };
            require(
                journal.inventory.get(name) == Some(&inventory(actual)?),
                "Prepared setup files changed; preserve them for inspection",
            )?;
            if source.exists() {
                management::rename(&source, &destination, libc::RENAME_NOREPLACE)?;
                fs::File::open(destination.parent().ok_or("Destination parent required")?)?
                    .sync_all()?;
                fs::File::open(&staging)?.sync_all()?;
            }
        }
    }
    let active = root.join(if journal.options.production {
        "live"
    } else {
        ".build"
    });
    require(
        artifact::verify(&active, Some(&journal.commit))?.digest == journal.digest,
        "Initialized runtime changed",
    )?;
    io::remove_receipt(&root.join(".runtime/setup.json"))?;
    fs::remove_dir_all(staging)?;
    Ok(())
}
