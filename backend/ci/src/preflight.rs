use crate::{REPOSITORY, Result, Runner};
use serde_json::Value;
use std::path::Path;
pub fn blockers(
    branch: &str,
    dirty: bool,
    current: bool,
    pulls: &[Value],
    concurrent: bool,
) -> Vec<String> {
    let mut problems = vec![];
    if matches!(branch, "dev" | "main" | "HEAD") {
        problems.push("Use an isolated feature branch.".into());
    }
    if dirty {
        problems.push("Commit the completed changes before starting final validation.".into());
    }
    if !current {
        problems.push("origin/dev has advanced. Incorporate it once, review the combined change, then rerun this preflight.".into());
    }
    let others: Vec<_> = pulls
        .iter()
        .filter(|pr| pr["headRefName"] != branch && pr["isDraft"] != true)
        .map(|pr| format!("#{}", pr["number"]))
        .collect();
    if !concurrent && !others.is_empty() {
        problems.push(format!("Finish the ready Dev PRs first, or leave this PR as a draft: {}. Use --allow-concurrent when overlap is intentional.",others.join(", ")));
    }
    problems
}
pub fn run(root: &Path, concurrent: bool, runner: &dyn Runner) -> Result<()> {
    let command = |args: &[&str]| -> Result<String> {
        Ok(String::from_utf8(runner.command(args, Some(root), 120)?)?
            .trim()
            .to_owned())
    };
    let branch = command(&["git", "rev-parse", "--abbrev-ref", "HEAD"])?;
    let dirty = !command(&["git", "status", "--porcelain"])?.is_empty();
    command(&["git", "fetch", "origin", "dev"])?;
    // Compare object IDs instead of treating arbitrary Git failures as ancestry results.
    let base = command(&["git", "rev-parse", "origin/dev"])?;
    let ancestor = command(&["git", "merge-base", "origin/dev", "HEAD"])?;
    let pulls: Vec<Value> = serde_json::from_str(&command(&[
        "gh",
        "pr",
        "list",
        "--repo",
        REPOSITORY,
        "--base",
        "dev",
        "--state",
        "open",
        "--json",
        "number,headRefName,isDraft,statusCheckRollup",
    ])?)?;
    let problems = blockers(&branch, dirty, base == ancestor, &pulls, concurrent);
    if !problems.is_empty() {
        return Err(format!(
            "PR preparation needs attention:\n- {}",
            problems.join("\n- ")
        )
        .into());
    }
    println!(
        "Run focused local checks for the changed behavior. GitHub runs the full required validation; review the PR while it runs. Repeat checks only for new changes or failures."
    );
    println!(
        "Ready for final validation against {}.",
        command(&["git", "rev-parse", "--short", "origin/dev"])?
    );
    let running = pulls
        .iter()
        .find(|pr| pr["headRefName"] == branch)
        .is_some_and(|pr| {
            pr["statusCheckRollup"].as_array().is_some_and(|checks| {
                checks.iter().any(|check| {
                    matches!(
                        check["status"].as_str(),
                        Some("QUEUED" | "IN_PROGRESS" | "PENDING")
                    )
                })
            })
        });
    println!(
        "{}",
        if running {
            "This PR already has checks running. Avoid another push unless there is a necessary correction."
        } else {
            "Push the final head and open the PR, or mark its draft ready once. Await checks before merging."
        }
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preflight_coordinates_ready_branches_without_blocking_drafts() {
        let mut pull = json!({"number":1,"headRefName":"another","isDraft":true});
        assert!(blockers("feature", false, true, &[pull.clone()], false).is_empty());
        pull["isDraft"] = false.into();
        assert!(!blockers("feature", false, true, &[pull.clone()], false).is_empty());
        assert!(blockers("feature", false, true, &[pull.clone()], true).is_empty());
        assert!(blockers("another", false, true, &[pull], false).is_empty());
        for branch in ["dev", "main", "HEAD"] {
            assert!(!blockers(branch, false, true, &[], false).is_empty());
        }
        assert!(!blockers("feature", true, true, &[], true).is_empty());
        assert!(!blockers("feature", false, false, &[], true).is_empty());
    }
}
