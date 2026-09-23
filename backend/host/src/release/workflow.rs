use super::*;
use dispatch_ci::policy::Policy;

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
                let changes = merged_changes(&self.git(
                    &[
                        "log",
                        "--first-parent",
                        "--merges",
                        "--format=%s%n%b%x1e",
                        &format!("{previous}..{commit}"),
                    ],
                    None,
                    120,
                )?)?;
                if !changes.is_empty() {
                    say(format!(
                        "Included changes, for the release notes:\n{}",
                        changes.join("\n")
                    ));
                }
            }
            journal.commit = Some(commit.clone());
            self.save(&journal)?;
        }
        say(format!("Releasing main commit {commit}"));
        Ok(commit)
    }
    fn ran_core(&self, run: &Value) -> Result<bool> {
        let jobs = io::github(
            self.system,
            &format!("actions/runs/{}/jobs?filter=latest&per_page=100", run["id"]),
        )?;
        Ok(jobs["jobs"]
            .as_array()
            .ok_or("Missing workflow jobs")?
            .iter()
            .any(|job| job["name"] == "core" && job["conclusion"] == "success"))
    }
    /// A run that passed the full suite on exactly `commit`. The core suite runs only in
    /// full validation. A run of the commit itself counts: its merge queue group, main's
    /// push or a dispatched run, the newest of each deciding. So does a group that reused
    /// its PR run, when that run's receipt records full validation of this same merge.
    fn fully_validated(&self, commit: &str) -> Result<Option<String>> {
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
                && self.ran_core(run)?
            {
                return Ok(Some(io::text(run, "html_url")));
            }
        }
        let runner = crate::ci::Runner(self.system);
        let policy = Policy {
            root: &self.root,
            runner: &runner,
        };
        if let Some(context) = policy.context_at(commit)?
            && let Some(validation) = policy.validated(&context, "main")?
            && validation.receipt["scope"] == "full"
        {
            return Ok(Some(io::text(&validation.run, "html_url")));
        }
        Ok(None)
    }
    /// Requires the full suite on exactly `commit`. When nothing has run it, one full run
    /// is dispatched on a temporary branch at the commit and awaited.
    pub(super) fn full_suite(&self, commit: &str) -> Result<()> {
        let url = match self.fully_validated(commit)? {
            Some(url) => url,
            None => {
                // A commit merged without the queue is validated by main's push run alone.
                self.checks(commit, "push", Some("main"), true)?;
                match self.fully_validated(commit)? {
                    Some(url) => url,
                    None => self.dispatch_full(commit)?,
                }
            }
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
            self.ran_core(&run)?,
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
    fn notes_list_only_first_parent_pr_merges() {
        let log = "Merge pull request #76 from owner/fix\n\nFix account\n\u{1e}\nMerge dev\n\u{1e}\nMerge pull request #74 from owner/other\n\u{1e}";
        assert_eq!(merged_changes(log).unwrap(), ["- #76 Fix account", "- #74"]);
    }
}
