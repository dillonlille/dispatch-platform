use crate::{REPOSITORY, Result, Runner};
use serde_json::Value;
use std::path::Path;
/// Problems that stop a push. With a merge queue on `main`, the queue validates the actual
/// merged state, so a moved `main` and other ready PRs no longer block.
pub fn blockers(
    branch: &str,
    dirty: bool,
    current: bool,
    pulls: &[Value],
    concurrent: bool,
    queued: bool,
) -> Vec<String> {
    let mut problems = vec![];
    if matches!(branch, "main" | "HEAD") {
        problems.push("Use an isolated feature branch.".into());
    }
    if dirty {
        problems.push("Commit the completed changes before starting final validation.".into());
    }
    if !current && !queued {
        problems.push("origin/main has advanced. Incorporate it once, review the combined change, then rerun this preflight.".into());
    }
    let others: Vec<_> = pulls
        .iter()
        .filter(|pr| pr["headRefName"] != branch && pr["isDraft"] != true)
        .map(|pr| format!("#{}", pr["number"]))
        .collect();
    if !concurrent && !queued && !others.is_empty() {
        problems.push(format!("Finish the ready PRs first, or leave this PR as a draft: {}. Use --allow-concurrent when overlap is intentional.",others.join(", ")));
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
    command(&["git", "fetch", "origin", "main"])?;
    // Compare object IDs instead of treating arbitrary Git failures as ancestry results.
    let base = command(&["git", "rev-parse", "origin/main"])?;
    let ancestor = command(&["git", "merge-base", "origin/main", "HEAD"])?;
    let pulls: Vec<Value> = serde_json::from_str(&command(&[
        "gh",
        "pr",
        "list",
        "--repo",
        REPOSITORY,
        "--base",
        "main",
        "--state",
        "open",
        "--json",
        "number,headRefName,isDraft,statusCheckRollup",
    ])?)?;
    let queued = merge_queue(&command);
    let problems = blockers(&branch, dirty, base == ancestor, &pulls, concurrent, queued);
    if !problems.is_empty() {
        return Err(format!(
            "PR preparation needs attention:\n- {}",
            problems.join("\n- ")
        )
        .into());
    }
    println!(
        "Run focused local checks for the changed behavior. The merge queue runs the full suite on the squash commit; nothing runs on the PR itself."
    );
    println!(
        "Ready for final validation against {}.",
        command(&["git", "rev-parse", "--short", "origin/main"])?
    );
    if queued {
        println!(
            "main has a merge queue: merging enqueues the PR, and the queue validates the actual merged state."
        );
    }
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
            "This PR is already being checked in the queue. Avoid another push unless there is a necessary correction."
        } else {
            "Push the final head, open the PR and ship it: npm run pr:ship -- <n> queues it at once."
        }
    );
    Ok(())
}
/// Whether `main` requires a merge queue. Any failure or unexpected answer counts as no queue.
fn merge_queue(command: &dyn Fn(&[&str]) -> Result<String>) -> bool {
    let (owner, name) = REPOSITORY.split_once('/').unwrap_or((REPOSITORY, ""));
    let query = format!(
        "query={{ repository(owner: \"{owner}\", name: \"{name}\") {{ mergeQueue(branch: \"main\") {{ id }} }} }}"
    );
    command(&["gh", "api", "graphql", "-f", &query])
        .ok()
        .and_then(|reply| serde_json::from_str::<Value>(&reply).ok())
        .is_some_and(|reply| reply["data"]["repository"]["mergeQueue"]["id"].is_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preflight_coordinates_ready_branches_without_blocking_drafts() {
        let mut pull = json!({"number":1,"headRefName":"another","isDraft":true});
        assert!(blockers("feature", false, true, &[pull.clone()], false, false).is_empty());
        pull["isDraft"] = false.into();
        assert!(!blockers("feature", false, true, &[pull.clone()], false, false).is_empty());
        assert!(blockers("feature", false, true, &[pull.clone()], true, false).is_empty());
        assert!(blockers("another", false, true, &[pull.clone()], false, false).is_empty());
        for branch in ["main", "HEAD"] {
            assert!(!blockers(branch, false, true, &[], false, false).is_empty());
        }
        assert!(!blockers("feature", true, true, &[], true, false).is_empty());
        assert!(!blockers("feature", false, false, &[], true, false).is_empty());
        // A merge queue validates the merged state: a moved main and other ready PRs are fine,
        // but the branch and a dirty tree still block.
        assert!(blockers("feature", false, false, &[pull], false, true).is_empty());
        assert!(!blockers("feature", true, true, &[], true, true).is_empty());
        assert!(!blockers("main", false, true, &[], true, true).is_empty());
    }
    #[test]
    fn merge_queue_is_detected_only_from_a_well_formed_answer() {
        let answer = |reply: &'static str| {
            merge_queue(&|args: &[&str]| {
                assert_eq!(&args[..3], ["gh", "api", "graphql"]);
                assert!(args[4].contains("mergeQueue(branch: \"main\")"));
                Ok(reply.into())
            })
        };
        assert!(answer(
            r#"{"data":{"repository":{"mergeQueue":{"id":"MQ_1"}}}}"#
        ));
        assert!(!answer(r#"{"data":{"repository":{"mergeQueue":null}}}"#));
        assert!(!answer("[]"));
        assert!(!answer("not json"));
        assert!(!merge_queue(&|_: &[&str]| Err("offline".into())));
    }
}
