use super::*;
use std::io::Write;

const VERSIONED: [&str; 5] = [
    "package.json",
    "package-lock.json",
    "backend/Cargo.toml",
    "backend/host/Cargo.toml",
    "Cargo.lock",
];

fn set_versions(root: &Path, version: &str) -> Result<()> {
    releases::version(version)?;
    let mut files = std::collections::BTreeMap::new();
    for name in VERSIONED {
        files.insert(name, fs::read_to_string(root.join(name))?);
    }
    let patterns = [
        (
            "package.json",
            r#"(\A\{\s*"name": "dispatch-platform",\s*"version": ")[^"]+(")"#.to_string(),
            1,
        ),
        (
            "package-lock.json",
            r#"("name": "dispatch-platform",\s*"version": ")[^"]+(")"#.to_string(),
            2,
        ),
        (
            "backend/Cargo.toml",
            r#"(\A\[package\]\nname = "dispatch-backend"\nversion = ")[^"]+(")"#.to_string(),
            1,
        ),
        (
            "backend/host/Cargo.toml",
            r#"(\A\[package\]\nname = "dispatch-host"\nversion = ")[^"]+(")"#.to_string(),
            1,
        ),
        (
            "Cargo.lock",
            r#"(\[\[package\]\]\nname = "dispatch-backend"\nversion = ")[^"]+(")"#.to_string(),
            1,
        ),
        (
            "Cargo.lock",
            r#"(\[\[package\]\]\nname = "dispatch-host"\nversion = ")[^"]+(")"#.to_string(),
            1,
        ),
    ];
    for (name, pattern, count) in patterns {
        let pattern = regex::Regex::new(&pattern)?;
        let text = files.get_mut(name).ok_or("Missing version file")?;
        require(
            pattern.captures_iter(text).count() == count,
            &format!("Version field missing or duplicated in {name}"),
        )?;
        *text = pattern
            .replace_all(text, |captures: &regex::Captures<'_>| {
                format!("{}{version}{}", &captures[1], &captures[2])
            })
            .into_owned();
    }
    // Validate every field before touching any file. A process interruption still
    // leaves an ordinary dirty worktree to inspect instead of committing it.
    for (name, text) in files {
        fs::write(root.join(name), text)?;
    }
    Ok(())
}
fn merged_changes(log: &str) -> Result<Vec<String>> {
    let pattern = regex::Regex::new(r"^Merge pull request #(\d+) from ")?;
    Ok(log
        .split('\u{1e}')
        .filter_map(|entry| {
            let (subject, body) = entry.trim().split_once('\n').unwrap_or((entry.trim(), ""));
            pattern.captures(subject).map(|c| {
                format!("- #{} {}", &c[1], body.trim().lines().next().unwrap_or(""))
                    .trim_end()
                    .into()
            })
        })
        .collect())
}

impl Release<'_> {
    pub(super) fn git(&self, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<String> {
        let mut command = vec!["git"];
        command.extend_from_slice(args);
        self.command(&command, cwd, timeout)
    }
    pub(super) fn pull_request(&self, branch: &str, base: &str) -> Result<Option<Value>> {
        let pulls: Vec<Value> = serde_json::from_str(&self.command(
            &[
                "gh",
                "pr",
                "list",
                "--repo",
                REPOSITORY,
                "--head",
                branch,
                "--base",
                base,
                "--state",
                "all",
                "--limit",
                "100",
                "--json",
                "number,state,url,headRefOid,mergeCommit,isCrossRepository",
            ],
            None,
            120,
        )?)?;
        require(
            pulls.len() <= 1,
            &format!("Several pull requests exist for {branch}"),
        )?;
        if let Some(pull) = pulls.first() {
            require(
                pull["isCrossRepository"] == false,
                "Release PR must belong to this repository",
            )?;
        }
        Ok(pulls.into_iter().next())
    }
    fn checkout(&self, worktree: &Path, branch: &str, start: &str) -> Result<()> {
        require(
            worktree.parent() == Some(self.platform.join("worktrees").as_path()),
            "Release worktree must be under the platform worktrees directory",
        )?;
        if !worktree.try_exists()? {
            fs::create_dir_all(worktree.parent().ok_or("Missing worktree parent")?)?;
            let path = worktree.to_str().ok_or("Invalid worktree path")?;
            if self
                .git(
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        &format!("refs/heads/{branch}"),
                    ],
                    None,
                    120,
                )
                .is_ok()
            {
                self.git(&["worktree", "add", path, branch], None, 120)?;
            } else {
                self.git(&["worktree", "add", "-b", branch, path, start], None, 120)?;
            }
        }
        require(
            self.git(&["branch", "--show-current"], Some(worktree), 120)? == branch,
            "Release worktree is on another branch",
        )?;
        require(
            self.git(&["status", "--porcelain"], Some(worktree), 120)?
                .is_empty(),
            &format!(
                "Finish and commit the work in {}, then rerun",
                worktree.display()
            ),
        )
    }
    fn merge_main(&self, worktree: &Path, message: &str) -> Result<()> {
        if self
            .git(
                &["merge-base", "--is-ancestor", "origin/main", "HEAD"],
                Some(worktree),
                120,
            )
            .is_ok()
        {
            return Ok(());
        }
        self.git(
            &["merge", "--no-edit", "-m", message, "origin/main"],
            Some(worktree),
            120,
        )
        .map_err(|e| {
            format!(
                "Resolve and commit the merge in {}, then rerun: {e}",
                worktree.display()
            )
        })?;
        Ok(())
    }
    fn create_pr(&self, branch: &str, base: &str, title: &str, body: &str) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new()?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
        let url = self.command(
            &[
                "gh",
                "pr",
                "create",
                "--repo",
                REPOSITORY,
                "--base",
                base,
                "--head",
                branch,
                "--title",
                title,
                "--body-file",
                file.path().to_str().ok_or("Invalid PR body path")?,
            ],
            None,
            120,
        )?;
        say(format!("Pull request: {url}"));
        Ok(())
    }
    fn open_release(&self, requested: Option<&str>) -> Result<Value> {
        let mut journal = self.journal()?;
        let commit = match &journal.dev_commit {
            Some(commit) => {
                if let Some(requested) = requested {
                    require(
                        self.git(
                            &["rev-parse", "--verify", &format!("{requested}^{{commit}}")],
                            None,
                            120,
                        )? == *commit,
                        "Accepted Dev commit is already pinned; resume with the original commit",
                    )?;
                }
                commit.clone()
            }
            None => self.git(
                &[
                    "rev-parse",
                    "--verify",
                    &format!("{}^{{commit}}", requested.unwrap_or("origin/dev")),
                ],
                None,
                120,
            )?,
        };
        require(artifact::hex(&commit, 40), "Full Dev commit required")?;
        self.git(
            &["merge-base", "--is-ancestor", &commit, "origin/dev"],
            None,
            120,
        )
        .map_err(|_| "The release source must be a commit on dev")?;
        let excludes: Vec<_> = VERSIONED
            .iter()
            .map(|name| format!(":(exclude){name}"))
            .collect();
        let mut diff = vec!["diff", "--name-only", "origin/main", &commit, "--", "."];
        diff.extend(excludes.iter().map(String::as_str));
        require(
            !self.git(&diff, None, 120)?.is_empty(),
            "Dev has nothing new to release",
        )?;
        self.checks(&commit, "push", Some("dev"), false)?;
        journal.dev_commit = Some(commit.clone());
        self.save(&journal)?;
        self.checkout(&self.worktree, &self.branch, &commit)?;
        self.git(
            &["merge-base", "--is-ancestor", &commit, "HEAD"],
            Some(&self.worktree),
            120,
        )
        .map_err(|_| "Existing release branch does not contain the accepted Dev commit")?;
        self.merge_main(
            &self.worktree,
            &format!("Merge main into the {} release", self.tag),
        )?;
        if io::read_json(&self.worktree.join("package.json"))?["version"] != self.version {
            set_versions(&self.worktree, &self.version)?;
            self.command(
                &[
                    "cargo",
                    "metadata",
                    "--locked",
                    "--no-deps",
                    "--format-version=1",
                ],
                Some(&self.worktree),
                120,
            )?;
            self.git(
                &["commit", "-am", &format!("Prepare {}", self.tag)],
                Some(&self.worktree),
                120,
            )?;
        }
        let changes = merged_changes(&self.git(
            &[
                "log",
                "--first-parent",
                "--merges",
                "--format=%s%n%b%x1e",
                &format!("origin/main..{commit}"),
            ],
            None,
            120,
        )?)?;
        self.git(
            &["push", "--set-upstream", "origin", &self.branch],
            Some(&self.worktree),
            300,
        )?;
        self.create_pr(
            &self.branch,
            "main",
            &format!("Release Dispatch {}", self.tag),
            &format!(
                "Releases Dev revision {commit} as {}.\n\n{}",
                self.tag,
                changes.join("\n")
            ),
        )?;
        if !changes.is_empty() {
            say(format!(
                "Included changes, for the release notes:\n{}",
                changes.join("\n")
            ));
        }
        self.pull_request(&self.branch, "main")?
            .ok_or_else(|| "Release PR not yet visible; rerun".into())
    }
    pub(super) fn merge_release(&self, requested: Option<&str>) -> Result<String> {
        let mut pull = match self.pull_request(&self.branch, "main")? {
            Some(pull) => pull,
            None => self.open_release(requested)?,
        };
        require(
            pull["state"] != "CLOSED",
            "Release PR was closed without merging",
        )?;
        if let Some(requested) = requested
            && let Some(pinned) = self.journal()?.dev_commit
        {
            require(
                self.git(
                    &["rev-parse", "--verify", &format!("{requested}^{{commit}}")],
                    None,
                    120,
                )? == pinned,
                "Accepted Dev commit changed",
            )?;
        }
        if pull["state"] == "OPEN" {
            say(format!("Release PR: {}", io::text(&pull, "url")));
            let mut head = io::text(&pull, "headRefOid");
            if self.worktree.try_exists()? {
                self.checkout(&self.worktree, &self.branch, &self.branch)?;
                self.merge_main(
                    &self.worktree,
                    &format!("Merge main into the {} release", self.tag),
                )?;
                self.git(&["push", "origin", &self.branch], Some(&self.worktree), 300)?;
                head = self.git(&["rev-parse", "HEAD"], Some(&self.worktree), 120)?;
            }
            require(artifact::hex(&head, 40), "Invalid release PR head")?;
            self.checks(&head, "pull_request", Some(&self.branch), true)?;
            self.command(
                &[
                    "gh",
                    "pr",
                    "merge",
                    &pull["number"].to_string(),
                    "--repo",
                    REPOSITORY,
                    "--merge",
                    "--match-head-commit",
                    &head,
                ],
                None,
                120,
            )?;
            pull = self
                .pull_request(&self.branch, "main")?
                .ok_or("Release PR disappeared")?;
        }
        let commit = io::text(&pull["mergeCommit"], "oid");
        require(
            pull["state"] == "MERGED" && artifact::hex(&commit, 40),
            "Release PR did not merge",
        )?;
        Ok(commit)
    }
    pub(super) fn open_sync(&self) -> Result<Option<Value>> {
        if let Some(pull) = self.pull_request(&self.sync_branch, "dev")? {
            return Ok(Some(pull));
        }
        self.git(&["fetch", "origin", "main", "dev"], None, 300)?;
        if self
            .git(
                &["merge-base", "--is-ancestor", "origin/main", "origin/dev"],
                None,
                120,
            )
            .is_ok()
        {
            return Ok(None);
        }
        self.checkout(&self.sync_worktree, &self.sync_branch, "origin/dev")?;
        self.merge_main(
            &self.sync_worktree,
            &format!("Bring the {} release from main into dev", self.tag),
        )?;
        self.git(
            &["push", "--set-upstream", "origin", &self.sync_branch],
            Some(&self.sync_worktree),
            300,
        )?;
        self.create_pr(
            &self.sync_branch,
            "dev",
            &format!("Bring the {} release from main into dev", self.tag),
            &format!("Keeps dev and main on shared history after {}.", self.tag),
        )?;
        Ok(Some(
            self.pull_request(&self.sync_branch, "dev")?
                .ok_or("Dev sync PR not yet visible; rerun")?,
        ))
    }
    pub(super) fn finish_sync(&self) -> Result<()> {
        let Some(mut pull) = self.open_sync()? else {
            return Ok(());
        };
        if pull["state"] == "MERGED" {
            return Ok(());
        }
        require(
            pull["state"] == "OPEN",
            "Dev sync PR was closed without merging",
        )?;
        let mut head = io::text(&pull, "headRefOid");
        if self.sync_worktree.try_exists()? {
            self.checkout(&self.sync_worktree, &self.sync_branch, &self.sync_branch)?;
            self.git(&["fetch", "origin", "dev"], None, 300)?;
            self.git(
                &["merge", "--no-edit", "origin/dev"],
                Some(&self.sync_worktree),
                120,
            )
            .map_err(|e| {
                format!(
                    "Resolve and commit the Dev sync merge in {}, then rerun: {e}",
                    self.sync_worktree.display()
                )
            })?;
            self.git(
                &["push", "origin", &self.sync_branch],
                Some(&self.sync_worktree),
                300,
            )?;
            head = self.git(&["rev-parse", "HEAD"], Some(&self.sync_worktree), 120)?;
        }
        require(artifact::hex(&head, 40), "Invalid Dev sync PR head")?;
        self.checks(&head, "pull_request", Some(&self.sync_branch), true)?;
        self.command(
            &[
                "gh",
                "pr",
                "merge",
                &pull["number"].to_string(),
                "--repo",
                REPOSITORY,
                "--merge",
                "--match-head-commit",
                &head,
            ],
            None,
            120,
        )?;
        pull = self
            .pull_request(&self.sync_branch, "dev")?
            .ok_or("Dev sync PR disappeared")?;
        require(pull["state"] == "MERGED", "Dev sync PR did not merge")
    }
    pub(super) fn clean(&self) -> Result<()> {
        for (worktree, branch, base) in [
            (&self.worktree, &self.branch, "main"),
            (&self.sync_worktree, &self.sync_branch, "dev"),
        ] {
            let Some(pull) = self.pull_request(branch, base)? else {
                continue;
            };
            if pull["state"] != "MERGED" {
                continue;
            }
            if worktree.try_exists()? {
                // A reused directory or uncommitted fixes are never removed.
                if self.git(&["branch", "--show-current"], Some(worktree), 120)? != *branch
                    || !self
                        .git(&["status", "--porcelain"], Some(worktree), 120)?
                        .is_empty()
                {
                    continue;
                }
                let head = self.git(&["rev-parse", "HEAD"], Some(worktree), 120)?;
                if pull["headRefOid"] != head {
                    continue;
                }
                self.git(
                    &[
                        "worktree",
                        "remove",
                        worktree.to_str().ok_or("Invalid worktree path")?,
                    ],
                    None,
                    120,
                )?;
            }
            let local = self.git(
                &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
                None,
                120,
            );
            if local.as_ref().is_ok_and(|head| pull["headRefOid"] == *head) {
                self.git(&["branch", "-D", branch], None, 120)?;
            }
        }
        // Preserve custom notes and any edits made after their published copy.
        if self.notes == self.directory.join(format!("{}-notes.md", self.tag))
            && self.notes.try_exists()?
            && self.output.join("notes.md").try_exists()?
            && fs::read(&self.notes)? == fs::read(self.output.join("notes.md"))?
        {
            fs::remove_file(&self.notes)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_touch_only_platform_fields_and_validate_before_writing() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        for name in VERSIONED {
            fs::create_dir_all(temp.path().join(name).parent().unwrap()).unwrap();
            fs::copy(source.join(name), temp.path().join(name)).unwrap();
        }
        set_versions(temp.path(), "9.8.7").unwrap();
        for (name, count) in VERSIONED.into_iter().zip([1, 2, 1, 1, 2]) {
            let before = fs::read_to_string(source.join(name)).unwrap();
            let after = fs::read_to_string(temp.path().join(name)).unwrap();
            assert_eq!(before.lines().count(), after.lines().count());
            let changes: Vec<_> = before
                .lines()
                .zip(after.lines())
                .filter(|(a, b)| a != b)
                .collect();
            assert_eq!(changes.len(), count, "{name}");
            assert!(changes.iter().all(|(_, line)| line.contains("9.8.7")));
        }
        fs::write(temp.path().join("Cargo.lock"), "broken").unwrap();
        assert!(set_versions(temp.path(), "9.8.8").is_err());
        assert_eq!(
            io::read_json(&temp.path().join("package.json")).unwrap()["version"],
            "9.8.7"
        );
    }
    #[test]
    fn notes_list_only_first_parent_pr_merges() {
        let log = "Merge pull request #76 from owner/fix\n\nFix account\n\u{1e}\nMerge dev\n\u{1e}\nMerge pull request #74 from owner/other\n\u{1e}";
        assert_eq!(merged_changes(log).unwrap(), ["- #76 Fix account", "- #74"]);
    }
}
