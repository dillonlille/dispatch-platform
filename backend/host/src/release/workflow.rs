use super::*;

/// The PRs in the log, as number and title: a squash commit names its PR in the `(#N)`
/// suffix of its subject, and a merge commit from before squash merges in its
/// `Merge pull request #N` subject, with the title on its body's first line.
fn merged_changes(log: &str) -> Result<Vec<(u64, String)>> {
    let squash = regex::Regex::new(r"^(.*) \(#(\d+)\)$")?;
    let merge = regex::Regex::new(r"^Merge pull request #(\d+) from ")?;
    Ok(log
        .split('\u{1e}')
        .filter_map(|entry| {
            let (subject, body) = entry.trim().split_once('\n').unwrap_or((entry.trim(), ""));
            if let Some(c) = squash.captures(subject) {
                return Some((c[2].parse().ok()?, c[1].to_owned()));
            }
            let c = merge.captures(subject)?;
            Some((
                c[1].parse().ok()?,
                body.trim().lines().next().unwrap_or("").trim().to_owned(),
            ))
        })
        .collect())
}

/// A PR title as a release note reads it: without the `type(scope):` prefix, capitalized.
fn plain_title(title: &str) -> String {
    let prefix = regex::Regex::new(r"^[a-z]+(\([^)]*\))?!?: ").unwrap();
    let title = prefix.replace(title, "");
    let mut chars = title.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The first paragraph of a PR body's Change section, as the template lays it out.
fn change_summary(body: &str) -> Option<String> {
    let mut lines = body
        .lines()
        .map(str::trim)
        .skip_while(|line| line.trim_start_matches('#').trim() != "Change")
        .skip(1)
        .skip_while(|line| line.is_empty())
        .take_while(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && !matches!(*line, "Verification" | "Problem")
                && !line.starts_with("Review:")
                && !line.starts_with("Docs:")
        })
        .map(|line| line.trim_start_matches("- ").trim());
    let first = lines.next()?;
    Some(
        std::iter::once(first)
            .chain(lines)
            .collect::<Vec<_>>()
            .join(" "),
    )
}

impl Release<'_> {
    pub(super) fn git(&self, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<String> {
        let mut command = vec!["git"];
        command.extend_from_slice(args);
        self.command(&command, cwd, timeout)
    }
    /// The newest published stable release before this one.
    fn previous(&self) -> Result<Option<String>> {
        let listed: Vec<_> = all_releases(self.system)?
            .into_iter()
            .filter(|r| r["tag_name"] != self.tag)
            .collect();
        let latest = latest_version(&listed);
        Ok((latest != "0.0.0").then(|| format!("v{latest}")))
    }
    /// The commit this release publishes: main's head, or the commit on main `--commit`
    /// names. A resumed release keeps its pin; `--commit` replaces it only while nothing
    /// has been prepared from it, such as after its full checks failed.
    pub(super) fn pin(&self, requested: Option<&str>) -> Result<String> {
        let mut journal = self.journal()?;
        let commit = match (&journal.commit, requested) {
            (Some(pinned), None) => pinned.clone(),
            (pinned, requested) => {
                let commit = self.git(
                    &[
                        "rev-parse",
                        "--verify",
                        &format!("{}^{{commit}}", requested.unwrap_or("origin/main")),
                    ],
                    None,
                    120,
                )?;
                if let Some(pinned) = pinned
                    && *pinned != commit
                {
                    require(
                        !self.output.try_exists()?,
                        "The release is prepared from its pinned commit; resume without --commit",
                    )?;
                    say(format!("Replacing the unprepared release commit {pinned}"));
                }
                commit
            }
        };
        require(artifact::hex(&commit, 40), "Full release commit required")?;
        self.git(
            &["merge-base", "--is-ancestor", &commit, "origin/main"],
            None,
            120,
        )
        .map_err(|_| "The release commit must be on main")?;
        if journal.commit.as_ref() != Some(&commit) {
            if let Some(previous) = self.previous()? {
                let comparison =
                    io::github(self.system, &format!("compare/{previous}...{commit}"))?;
                require(
                    comparison["status"] == "ahead",
                    &format!("Main has nothing new since {previous}"),
                )?;
                let changes = self.changes_after(&previous, &commit)?;
                if !changes.is_empty() {
                    say(format!(
                        "Included changes:\n{}",
                        changes
                            .iter()
                            .map(|(number, title)| format!("- #{number} {title}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    ));
                }
            }
            journal.commit = Some(commit.clone());
            self.save(&journal)?;
        }
        say(format!("Releasing main commit {commit}"));
        Ok(commit)
    }
    /// The PRs on main's first-parent line after `previous` up to `commit`.
    fn changes_after(&self, previous: &str, commit: &str) -> Result<Vec<(u64, String)>> {
        merged_changes(&self.git(
            &[
                "log",
                "--first-parent",
                "--format=%s%n%b%x1e",
                &format!("{previous}..{commit}"),
            ],
            None,
            120,
        )?)
    }
    /// Writes the release notes from the merged PRs: one line per PR, its title and the first
    /// paragraph of its Change section, then the list of PRs. A body GitHub cannot serve
    /// leaves the title alone.
    pub(super) fn generate_notes(&self, commit: &str) -> Result<()> {
        let changes = match self.previous()? {
            Some(previous) => self.changes_after(&previous, commit)?,
            None => vec![],
        };
        let mut notes = String::new();
        for (number, title) in &changes {
            let body = self
                .command(
                    &[
                        "gh",
                        "pr",
                        "view",
                        &number.to_string(),
                        "--repo",
                        REPOSITORY,
                        "--json",
                        "body",
                        "--jq",
                        ".body",
                    ],
                    None,
                    60,
                )
                .ok();
            let summary = body.as_deref().and_then(change_summary);
            let title = plain_title(title).trim_end_matches('.').to_owned();
            notes.push_str(&match summary {
                Some(summary) => format!("- {title}. {summary}\n"),
                None => format!("- {title}.\n"),
            });
        }
        let links: Vec<_> = changes
            .iter()
            .map(|(number, _)| {
                format!("[#{number}](https://github.com/{REPOSITORY}/pull/{number})")
            })
            .collect();
        match links.len() {
            0 => notes.push_str(&format!("Release {}.\n", self.tag)),
            1 => notes.push_str(&format!("\nIncludes {}.\n", links[0])),
            n => notes.push_str(&format!(
                "\nIncludes {} and {}.\n",
                links[..n - 1].join(", "),
                links[n - 1]
            )),
        }
        fs::write(&self.notes, notes)?;
        Ok(())
    }
    /// Whether `run` ran the whole suite: its `core` job ran, which a scoped run of the
    /// former workflow skipped, and its `platform` gate ran, which a partial manual run skips.
    fn full_run(&self, run: &Value) -> Result<bool> {
        let jobs = io::github(
            self.system,
            &format!("actions/runs/{}/jobs?filter=latest&per_page=100", run["id"]),
        )?;
        let passed = |name: &str| {
            jobs["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|job| job["name"] == name && job["conclusion"] == "success")
        };
        Ok(passed("core") && passed("platform"))
    }
    /// The newest run that passed the full suite on exactly `commit`: its merge queue group,
    /// which published the build, a dispatched run, or the push run of history before the
    /// queue published builds.
    pub(super) fn fully_validated(&self, commit: &str) -> Result<Option<Value>> {
        let runs = io::github(
            self.system,
            &format!("actions/workflows/checks.yml/runs?head_sha={commit}&per_page=100"),
        )?;
        for (event, branch) in [
            ("merge_group", None),
            ("push", Some("main")),
            ("workflow_dispatch", None),
        ] {
            if let Some(run) =
                releases::latest_run(&runs["workflow_runs"], commit, event, branch, false)
                && releases::passed(run)
                && self.full_run(run)?
            {
                return Ok(Some(run.clone()));
            }
        }
        Ok(None)
    }
    /// Requires the full suite on exactly `commit`. Every queue run is one, so only a build
    /// that expired or a commit that reached `main` another way gets a run dispatched on a
    /// temporary branch at the commit and awaited.
    pub(super) fn full_suite(&self, commit: &str) -> Result<()> {
        let url = match self.fully_validated(commit)? {
            Some(run) => io::text(&run, "html_url"),
            None => self.dispatch_full(commit)?,
        };
        say(format!("Full checks: {url}"));
        // The temporary branch only ever serves a dispatched run.
        self.remove_checks_branch()
    }
    fn dispatch_full(&self, commit: &str) -> Result<String> {
        let runs = io::github(
            self.system,
            &format!(
                "actions/workflows/checks.yml/runs?event=workflow_dispatch&head_sha={commit}&per_page=100"
            ),
        )?;
        if releases::latest_run(
            &runs["workflow_runs"],
            commit,
            "workflow_dispatch",
            Some(&self.checks_branch),
            false,
        )
        .is_none()
        {
            say("Nothing ran the full suite on this commit; starting it");
            self.checks_branch_at(commit)?;
            self.command(
                &[
                    "gh",
                    "workflow",
                    "run",
                    "checks.yml",
                    "--repo",
                    REPOSITORY,
                    "--ref",
                    &self.checks_branch,
                ],
                None,
                120,
            )?;
        }
        // A failure stays for inspection; rerunning its failed jobs lets this resume.
        let run = self.checks(commit, "workflow_dispatch", Some(&self.checks_branch), true)?;
        require(
            self.full_run(&run)?,
            "The dispatched checks did not run the full suite",
        )?;
        Ok(io::text(&run, "html_url"))
    }
    fn checks_ref(&self) -> Result<Option<String>> {
        let name = format!("refs/heads/{}", self.checks_branch);
        let refs = self.api(
            &format!("git/matching-refs/heads/{}", self.checks_branch),
            &[],
        )?;
        Ok(refs
            .as_array()
            .ok_or("Invalid branch refs")?
            .iter()
            .find(|r| r["ref"] == name)
            .map(|r| io::text(&r["object"], "sha")))
    }
    fn checks_branch_at(&self, commit: &str) -> Result<()> {
        match self.checks_ref()? {
            Some(sha) if sha == commit => {}
            Some(_) => {
                self.api(
                    &format!("git/refs/heads/{}", self.checks_branch),
                    &[
                        "--method",
                        "PATCH",
                        "-f",
                        &format!("sha={commit}"),
                        "-F",
                        "force=true",
                    ],
                )?;
            }
            None => {
                self.api(
                    "git/refs",
                    &[
                        "-f",
                        &format!("ref=refs/heads/{}", self.checks_branch),
                        "-f",
                        &format!("sha={commit}"),
                    ],
                )?;
            }
        }
        Ok(())
    }
    fn remove_checks_branch(&self) -> Result<()> {
        if self.checks_ref()?.is_some() {
            self.command(
                &[
                    "gh",
                    "api",
                    &format!("repos/{REPOSITORY}/git/refs/heads/{}", self.checks_branch),
                    "--method",
                    "DELETE",
                ],
                None,
                120,
            )?;
        }
        Ok(())
    }
    pub(super) fn clean(&self) -> Result<()> {
        self.remove_checks_branch()?;
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
    fn notes_list_squash_and_merge_commits_of_prs() {
        let log = "fix(host): keep the lock (#80)\n\nThe body.\n\u{1e}\nMerge pull request #76 from owner/fix\n\nFix account\n\u{1e}\nMerge dev\n\u{1e}\nRelease notes\n\u{1e}\nMerge pull request #74 from owner/other\n\u{1e}";
        assert_eq!(
            merged_changes(log).unwrap(),
            [
                (80, "fix(host): keep the lock".to_owned()),
                (76, "Fix account".to_owned()),
                (74, String::new())
            ]
        );
    }
    #[test]
    fn notes_read_titles_and_the_first_paragraph_of_a_change_section() {
        assert_eq!(plain_title("fix(host): keep the lock"), "Keep the lock");
        assert_eq!(plain_title("ci!: rebuild"), "Rebuild");
        assert_eq!(plain_title("Sort every column"), "Sort every column");
        let body = "Problem\n\nIt broke.\n\nChange\n\nThe lock is held explicitly.\nIt unlocks on drop.\n\nMore detail.\n\nVerification\n\nTests.\n";
        assert_eq!(
            change_summary(body).as_deref(),
            Some("The lock is held explicitly. It unlocks on drop.")
        );
        assert_eq!(
            change_summary("## Change\n\n- one\n- two\n").as_deref(),
            Some("one two")
        );
        assert_eq!(change_summary("Problem\n\nNo change section.\n"), None);
        assert_eq!(change_summary("Change\n\nVerification\n\nx"), None);
    }
}
