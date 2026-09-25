//! `npm run pr:ship -- <number>`: add a PR to the merge queue as soon as GitHub admits it and
//! wait until GitHub merges it. The queue runs the checks on the exact squash commit it will
//! push, so nothing but the admission check runs on the PR itself. Everything is read from
//! GitHub's API, never from a command's text: a newer push is queued in its turn, and the wait
//! stops with the reason when the PR closes or leaves the queue unmerged, naming the failed
//! jobs of its queue run. A PR labelled `ai-review` is queued only once CodeRabbit reviewed it
//! and its review threads are resolved.
use crate::{REPOSITORY, Result, Runner};
use serde_json::Value;

/// Seconds between looks at the PR, and how many looks bound the whole wait: 90 minutes.
const PAUSE: u64 = 20;
const LOOKS: u32 = 270;
/// Consecutive failed API calls, or refused additions to the queue, before giving up.
const ATTEMPTS: u32 = 5;
/// Looks spent waiting for CodeRabbit before giving up: 20 minutes in all, and 5 while it has
/// not started.
const REVIEW_LOOKS: u32 = 60;
const UNSTARTED_LOOKS: u32 = 15;

/// The check the ruleset expects on a PR head before the queue admits it, which
/// `queue-admission.yml` reports, and the queue's own gate.
const REQUIRED: &str = "platform";
/// The label that holds a PR for CodeRabbit's review, and the text of the `CodeRabbit` commit
/// status on a commit it finished reviewing.
const REVIEW_LABEL: &str = "ai-review";
const REVIEWED: &str = "Review completed";
const LOOK: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state isDraft headRefOid mergeable mergeCommit{oid} mergeQueueEntry{state position} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:50){nodes{__typename ...on CheckRun{name conclusion}}}}}}} timelineItems(last:1,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{...on RemovedFromMergeQueueEvent{reason}}} labels(first:20){nodes{name}} reviewed:commits(last:100){nodes{commit{oid status{context(name:\"CodeRabbit\"){state description}}}}} reviewThreads(first:100){nodes{isResolved path line comments(first:1){nodes{author{login} url}}}}}}}";
const ENQUEUE: &str = "mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}";

fn graphql(runner: &dyn Runner, query: &str, variables: &[String]) -> Result<Value> {
    let query = format!("query={query}");
    let mut args = vec!["gh", "api", "graphql", "-f", &query];
    for variable in variables {
        // Numbers go as typed fields, everything else as strings.
        let typed = variable.starts_with("number=");
        args.extend([if typed { "-F" } else { "-f" }, variable]);
    }
    let reply: Value = serde_json::from_slice(&runner.command(&args, None, 60)?)?;
    if let Some(errors) = reply.get("errors") {
        return Err(format!("GitHub refused: {errors}").into());
    }
    Ok(reply["data"].clone())
}

fn rest(runner: &dyn Runner, endpoint: &str) -> Result<Value> {
    let endpoint = format!("repos/{REPOSITORY}/{endpoint}");
    Ok(serde_json::from_slice(&runner.command(
        &["gh", "api", &endpoint],
        None,
        60,
    )?)?)
}

fn look(runner: &dyn Runner, number: u64) -> Result<Value> {
    let (owner, name) = REPOSITORY.split_once('/').ok_or("Invalid repository")?;
    let data = graphql(
        runner,
        LOOK,
        &[
            format!("owner={owner}"),
            format!("name={name}"),
            format!("number={number}"),
        ],
    )?;
    let pr = data["repository"]["pullRequest"].clone();
    if pr.is_object() {
        Ok(pr)
    } else {
        Err(format!("#{number} is not a pull request of {REPOSITORY}").into())
    }
}

/// What the admission check says about the PR's current head.
#[derive(Debug, PartialEq)]
enum Admission {
    Pending,
    Passed,
    Failed,
}

fn admission(pr: &Value) -> Admission {
    let commit = &pr["commits"]["nodes"][0]["commit"];
    if commit["oid"] != pr["headRefOid"] {
        return Admission::Pending;
    }
    let contexts = &commit["statusCheckRollup"]["contexts"]["nodes"];
    match contexts
        .as_array()
        .into_iter()
        .flatten()
        .find(|context| context["__typename"] == "CheckRun" && context["name"] == REQUIRED)
        .and_then(|context| context["conclusion"].as_str())
    {
        Some("SUCCESS") => Admission::Passed,
        Some("FAILURE" | "CANCELLED" | "TIMED_OUT" | "STARTUP_FAILURE") => Admission::Failed,
        _ => Admission::Pending,
    }
}

/// Where CodeRabbit's review of the PR stands, read from the status it keeps on each commit.
#[derive(Debug, PartialEq)]
enum Review {
    /// It finished reviewing a commit of the PR and is reviewing none now.
    Done,
    Running,
    /// It reported an error on the head, or on an earlier commit with no review since.
    Failed(String),
    /// Never asked, or skipped or rate limited, as the head's status says.
    Unstarted(String),
}

fn review(pr: &Value) -> Review {
    let statuses: Vec<_> = pr["reviewed"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|node| (&node["commit"]["oid"], &node["commit"]["status"]["context"]))
        .collect();
    let head = statuses
        .iter()
        .find(|(oid, _)| **oid == pr["headRefOid"])
        .map(|(_, status)| *status);
    let failed = statuses
        .iter()
        .rev()
        .map(|(_, status)| *status)
        .find(|status| matches!(status["state"].as_str(), Some("FAILURE" | "ERROR")));
    let said = |status: Option<&Value>| {
        status
            .and_then(|status| status["description"].as_str())
            .unwrap_or("none yet")
            .to_owned()
    };
    match head.and_then(|status| status["state"].as_str()) {
        Some("PENDING") => Review::Running,
        Some("FAILURE" | "ERROR") => Review::Failed(said(head)),
        // A push while it reviews leaves the review on the earlier commit, and a review asked
        // for again outranks the one it follows.
        _ if statuses
            .iter()
            .any(|(_, status)| status["state"] == "PENDING") =>
        {
            Review::Running
        }
        _ if statuses.iter().any(|(_, status)| {
            status["state"] == "SUCCESS" && status["description"] == REVIEWED
        }) =>
        {
            Review::Done
        }
        _ if failed.is_some() => Review::Failed(said(failed)),
        _ => Review::Unstarted(said(head)),
    }
}

/// The PR's unresolved review threads, as "path:line author link" lines.
fn unresolved(pr: &Value) -> Vec<String> {
    pr["reviewThreads"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|thread| thread["isResolved"] == false)
        .map(|thread| {
            let comment = &thread["comments"]["nodes"][0];
            let path = thread["path"].as_str().unwrap_or("");
            let place = match thread["line"].as_u64() {
                Some(line) => format!("{path}:{line}"),
                None => path.to_owned(),
            };
            format!(
                "{place} {} {}",
                comment["author"]["login"].as_str().unwrap_or("someone"),
                comment["url"].as_str().unwrap_or("")
            )
        })
        .collect()
}

/// The newest queue run for `number`, if any. The queue names its branch after the PR, which
/// is how the run is found. Any API trouble here only costs detail, never the verdict.
fn queue_run(runner: &dyn Runner, number: u64) -> Option<Value> {
    let prefix = format!("gh-readonly-queue/main/pr-{number}-");
    let runs = rest(
        runner,
        "actions/workflows/checks.yml/runs?event=merge_group&per_page=30",
    )
    .ok()?;
    runs["workflow_runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|run| {
            run["head_branch"]
                .as_str()
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .max_by_key(|run| run["id"].as_u64().unwrap_or(0))
        .cloned()
}

/// The failed jobs of `run`, as "name: conclusion link" lines.
fn failed_jobs(runner: &dyn Runner, run: &Value) -> Vec<String> {
    let Ok(jobs) = rest(
        runner,
        &format!("actions/runs/{}/jobs?per_page=100", run["id"]),
    ) else {
        return vec![];
    };
    jobs["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|job| {
            matches!(
                job["conclusion"].as_str(),
                Some("failure" | "cancelled" | "timed_out" | "startup_failure")
            )
        })
        .map(|job| {
            format!(
                "{}: {} {}",
                job["name"].as_str().unwrap_or("job"),
                job["conclusion"].as_str().unwrap_or(""),
                job["html_url"].as_str().unwrap_or("")
            )
        })
        .collect()
}

fn short(head: &Value) -> &str {
    head.as_str().map_or("", |head| &head[..head.len().min(7)])
}

/// Queue `number` and wait for the merge; returns the squash commit. `pause` waits between
/// looks and `say` reports each change of progress once.
pub fn run(
    number: u64,
    runner: &dyn Runner,
    pause: &dyn Fn(u64),
    say: &mut dyn FnMut(&str),
) -> Result<String> {
    let mut last = String::new();
    let mut note = |text: String| {
        if text != last {
            say(&text);
            last = text;
        }
    };
    // The head this run queued or found queued, and how often it was then seen outside it.
    let mut queued: Option<Value> = None;
    let mut outside = 0;
    // The newest queue run of this PR before this run queued it: only a later run is its own.
    let mut earlier: Option<u64> = None;
    let (mut seen, mut unanswered, mut refused) = (false, 0, 0);
    // Looks spent waiting for CodeRabbit, in all and since it last reported a running review.
    let (mut waited, mut unstarted) = (0, 0);
    for _ in 0..LOOKS {
        let pr = match look(runner, number) {
            Ok(pr) => {
                (seen, unanswered) = (true, 0);
                pr
            }
            Err(error) => {
                // Failing on the first look is a wrong number or missing access, not an outage.
                unanswered += 1;
                if unanswered >= ATTEMPTS || !seen {
                    return Err(error);
                }
                pause(PAUSE);
                continue;
            }
        };
        let head = &pr["headRefOid"];
        match pr["state"].as_str() {
            Some("MERGED") => {
                return Ok(pr["mergeCommit"]["oid"].as_str().unwrap_or("").into());
            }
            Some("CLOSED") => return Err(format!("#{number} was closed without merging").into()),
            _ => {}
        }
        if pr["isDraft"] == true {
            return Err(
                format!("#{number} is a draft; mark it ready for review, then ship it").into(),
            );
        }
        let entry = &pr["mergeQueueEntry"];
        if entry.is_object() {
            queued = Some(head.clone());
            outside = 0;
            note(format!(
                "#{number} is in the merge queue at position {}: {}",
                entry["position"],
                entry["state"].as_str().unwrap_or("").to_lowercase()
            ));
            pause(PAUSE);
            continue;
        }
        if queued.as_ref() == Some(head) {
            // Just queued or just merged, GitHub can briefly show neither; a second look decides.
            outside += 1;
            if outside >= 2 {
                let reason = pr["timelineItems"]["nodes"][0]["reason"]
                    .as_str()
                    .unwrap_or("removed")
                    .to_owned();
                let failed = match queue_run(runner, number) {
                    Some(run) if run["id"].as_u64() > earlier || earlier.is_none() => {
                        failed_jobs(runner, &run)
                    }
                    _ => vec![],
                };
                return Err(if failed.is_empty() {
                    format!(
                        "#{number} left the merge queue without merging: {reason}. Queue runs: https://github.com/{REPOSITORY}/actions?query=event%3Amerge_group"
                    )
                } else {
                    format!(
                        "#{number} left the merge queue without merging: {reason}. Failed jobs of its queue run:\n- {}",
                        failed.join("\n- ")
                    )
                }
                .into());
            }
            pause(PAUSE);
            continue;
        }
        // The queue admits a head only once its admission check passed and GitHub knows it
        // merges cleanly; queued before that, GitHub drops it as an invalid merge commit.
        if pr["mergeable"] == "CONFLICTING" {
            return Err(format!(
                "#{number} conflicts with main; merge origin/main, push and ship it again"
            )
            .into());
        }
        match admission(&pr) {
            Admission::Failed => {
                return Err(format!(
                    "The admission check failed on {} of #{number}; rerun it, or fix queue-admission.yml",
                    short(head)
                )
                .into());
            }
            Admission::Passed if pr["mergeable"] == "MERGEABLE" => {}
            _ => {
                note(format!(
                    "Waiting for the admission check on {} of #{number}",
                    short(head)
                ));
                pause(PAUSE);
                continue;
            }
        }
        // Asked for with the label, CodeRabbit's review comes first; any commit it reviewed
        // counts, since later pushes are not reviewed again. Its threads must then be resolved,
        // as GitHub queues no PR with an open conversation.
        let labelled = pr["labels"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|label| label["name"] == REVIEW_LABEL);
        let unreviewed = format!(
            "comment `@coderabbitai review` on it, or remove the {REVIEW_LABEL} label to ship it unreviewed"
        );
        let waiting = match review(&pr) {
            _ if !labelled => None,
            Review::Done => {
                let open = unresolved(&pr);
                if !open.is_empty() {
                    return Err(format!(
                        "#{number} has unresolved review threads; answer and resolve each, then ship it again:\n- {}",
                        open.join("\n- ")
                    )
                    .into());
                }
                None
            }
            Review::Failed(said) => {
                return Err(
                    format!("CodeRabbit failed to review #{number}: {said}; {unreviewed}").into(),
                );
            }
            Review::Running => {
                unstarted = 0;
                Some(format!("Waiting for CodeRabbit to review #{number}"))
            }
            Review::Unstarted(said) => {
                unstarted += 1;
                if unstarted > UNSTARTED_LOOKS {
                    return Err(format!(
                        "CodeRabbit has not started reviewing #{number}, its status: {said}; {unreviewed}"
                    )
                    .into());
                }
                Some(format!(
                    "Waiting for CodeRabbit to start reviewing #{number}"
                ))
            }
        };
        if let Some(text) = waiting {
            waited += 1;
            if waited > REVIEW_LOOKS {
                return Err(format!(
                    "CodeRabbit has not finished reviewing #{number} after {} minutes; ship it again to keep waiting, or remove the {REVIEW_LABEL} label to ship it unreviewed",
                    u64::from(REVIEW_LOOKS) * PAUSE / 60
                )
                .into());
            }
            note(text);
            pause(PAUSE);
            continue;
        }
        if earlier.is_none() {
            earlier = Some(
                queue_run(runner, number)
                    .and_then(|run| run["id"].as_u64())
                    .unwrap_or(0),
            );
        }
        let id = pr["id"].as_str().unwrap_or("");
        let head = head.as_str().unwrap_or("");
        match graphql(
            runner,
            ENQUEUE,
            &[format!("id={id}"), format!("head={head}")],
        ) {
            Ok(_) => {
                refused = 0;
                queued = Some(head.into());
                note(format!(
                    "Added #{number} to the merge queue at {}; the queue runs the checks on its squash commit",
                    short(&head.into())
                ));
            }
            // Refused when the head moved meanwhile, or while GitHub catches up with the
            // admission check: the next look follows the new head or tries again.
            Err(error) => {
                refused += 1;
                if refused >= ATTEMPTS {
                    return Err(error);
                }
            }
        }
        pause(PAUSE);
    }
    Err(format!(
        "Gave up after {} minutes; #{number} has not merged",
        u64::from(LOOKS) * PAUSE / 60
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{cell::RefCell, collections::BTreeMap, collections::VecDeque, path::Path};

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";

    /// GitHub as a script: each look answers with the next PR state, the last one repeating,
    /// and each REST endpoint likewise.
    #[derive(Default)]
    struct GitHub {
        looks: RefCell<VecDeque<Result<Value>>>,
        refusals: RefCell<VecDeque<String>>,
        queued: RefCell<Vec<String>>,
        rest: RefCell<BTreeMap<String, VecDeque<Value>>>,
    }
    impl Runner for GitHub {
        fn command(&self, args: &[&str], _cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>> {
            assert_eq!(&args[..2], ["gh", "api"]);
            assert_eq!(timeout, 60);
            if let Some(endpoint) = args[2].strip_prefix(&format!("repos/{REPOSITORY}/")) {
                assert_eq!(args.len(), 3);
                let mut rest = self.rest.borrow_mut();
                let replies = rest.get_mut(endpoint).ok_or("not found")?;
                let reply = if replies.len() > 1 {
                    replies.pop_front().unwrap()
                } else {
                    replies.front().ok_or("not found")?.clone()
                };
                return Ok(serde_json::to_vec(&reply)?);
            }
            assert_eq!(&args[2..4], ["graphql", "-f"]);
            if args[4].contains("enqueuePullRequest") {
                assert_eq!(args[5..8], ["-f", "id=PR_1", "-f"]);
                if let Some(error) = self.refusals.borrow_mut().pop_front() {
                    return Err(error.into());
                }
                self.queued.borrow_mut().push(args[8].into());
                return Ok(
                    br#"{"data":{"enqueuePullRequest":{"mergeQueueEntry":{"position":1}}}}"#
                        .to_vec(),
                );
            }
            assert!(args.contains(&"number=7") && args.contains(&"-F"));
            let mut looks = self.looks.borrow_mut();
            let next = if looks.len() > 1 {
                looks.pop_front().unwrap()
            } else {
                match looks.front().unwrap() {
                    Ok(value) => Ok(value.clone()),
                    Err(error) => Err(error.to_string().into()),
                }
            };
            Ok(serde_json::to_vec(
                &json!({"data":{"repository":{"pullRequest":next?}}}),
            )?)
        }
    }
    fn github(looks: Vec<Value>) -> GitHub {
        GitHub {
            looks: RefCell::new(looks.into_iter().map(Ok).collect()),
            ..Default::default()
        }
    }
    /// An open PR whose head the admission check passed and which merges cleanly.
    fn open(head: &str) -> Value {
        let mut value = unadmitted(head);
        value["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0]["conclusion"] =
            "SUCCESS".into();
        value
    }
    /// An open PR whose admission check has not reported yet.
    fn unadmitted(head: &str) -> Value {
        json!({"id":"PR_1","state":"OPEN","isDraft":false,"headRefOid":head,"mergeable":"MERGEABLE",
            "mergeCommit":null,"mergeQueueEntry":null,
            "commits":{"nodes":[{"commit":{"oid":head,"statusCheckRollup":{"contexts":{"nodes":[
                {"__typename":"CheckRun","name":REQUIRED,"conclusion":null}]}}}}]},
            "timelineItems":{"nodes":[]}})
    }
    fn in_queue(head: &str) -> Value {
        let mut value = open(head);
        value["mergeQueueEntry"] = json!({"state":"AWAITING_CHECKS","position":1});
        value
    }
    fn removed(head: &str, reason: &str) -> Value {
        let mut value = open(head);
        value["timelineItems"]["nodes"] = json!([{"reason":reason}]);
        value
    }
    fn merged(head: &str) -> Value {
        let mut value = open(head);
        value["state"] = "MERGED".into();
        value["mergeCommit"] = json!({"oid":"3333333"});
        value
    }
    /// `pr` labelled for CodeRabbit's review, with its status on each listed commit.
    fn labelled(mut pr: Value, statuses: &[(&str, &str, &str)]) -> Value {
        pr["labels"] = json!({"nodes":[{"name":"collectors"},{"name":REVIEW_LABEL}]});
        let nodes: Vec<_> = statuses
            .iter()
            .map(|(oid, state, description)| {
                json!({"commit":{"oid":oid,"status":{"context":{"state":state,"description":description}}}})
            })
            .collect();
        pr["reviewed"] = json!({ "nodes": nodes });
        pr
    }
    fn ship(github: &GitHub) -> (Result<String>, Vec<String>, usize) {
        let pauses = RefCell::new(0);
        let mut said = vec![];
        let result = run(
            7,
            github,
            &|seconds| {
                assert_eq!(seconds, PAUSE);
                *pauses.borrow_mut() += 1;
            },
            &mut |text| said.push(text.to_owned()),
        );
        (result, said, pauses.into_inner())
    }
    const RUNS: &str = "actions/workflows/checks.yml/runs?event=merge_group&per_page=30";
    fn runs(ids: &[u64]) -> Value {
        let runs: Vec<_> = ids
            .iter()
            .map(|id| json!({"id":id,"head_branch":format!("gh-readonly-queue/main/pr-7-{id}")}))
            .chain([json!({"id":99,"head_branch":"gh-readonly-queue/main/pr-70-aaaa"})])
            .collect();
        json!({ "workflow_runs": runs })
    }
    fn jobs() -> Value {
        json!({"jobs":[
            {"name":"build","conclusion":"success","html_url":"https://github.com/job/1"},
            {"name":"core","conclusion":"failure","html_url":"https://github.com/job/2"},
            {"name":"platform","conclusion":"failure","html_url":"https://github.com/job/3"}]})
    }

    #[test]
    fn queues_an_admitted_head_at_once_and_returns_the_merge() {
        let github = github(vec![
            unadmitted(OLD),
            unadmitted(OLD),
            open(OLD),
            in_queue(OLD),
            in_queue(OLD),
            merged(OLD),
        ]);
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(*github.queued.borrow(), [format!("head={OLD}")]);
        // Each change of progress is reported once.
        assert_eq!(
            said,
            [
                "Waiting for the admission check on 1111111 of #7",
                "Added #7 to the merge queue at 1111111; the queue runs the checks on its squash commit",
                "#7 is in the merge queue at position 1: awaiting_checks",
            ]
        );
    }

    #[test]
    fn unknown_mergeability_waits_and_a_conflict_or_failed_admission_stops_it() {
        let mut unknown = open(OLD);
        unknown["mergeable"] = "UNKNOWN".into();
        let github = github(vec![unknown, open(OLD), in_queue(OLD), merged(OLD)]);
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(said[0], "Waiting for the admission check on 1111111 of #7");
        let mut conflicting = open(OLD);
        conflicting["mergeable"] = "CONFLICTING".into();
        let github = self::github(vec![conflicting]);
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(error.contains("conflicts with main"), "{error}");
        assert!(github.queued.borrow().is_empty());
        let mut failed = open(OLD);
        failed["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0]["conclusion"] =
            "FAILURE".into();
        let github = self::github(vec![failed]);
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(error.contains("admission check failed"), "{error}");
        // Checks attached to another commit than the head are not the head's.
        let mut stale = open(OLD);
        stale["headRefOid"] = NEW.into();
        assert_eq!(admission(&stale), Admission::Pending);
        assert_eq!(admission(&open(OLD)), Admission::Passed);
    }

    #[test]
    fn a_newer_push_is_queued_in_its_turn() {
        let github = github(vec![
            open(OLD),
            in_queue(OLD),
            open(NEW),
            in_queue(NEW),
            merged(NEW),
        ]);
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(
            *github.queued.borrow(),
            [format!("head={OLD}"), format!("head={NEW}")]
        );
        assert!(said.iter().any(|text| text.contains("at 2222222")));
    }

    #[test]
    fn an_already_queued_pr_is_not_queued_again() {
        let github = github(vec![in_queue(OLD), merged(OLD)]);
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        assert!(github.queued.borrow().is_empty());
    }

    #[test]
    fn leaving_the_queue_unmerged_reports_the_reason_and_the_failed_jobs_of_its_own_run() {
        // Queued here: only a run newer than the one before counts as this attempt's.
        let github = github(vec![
            open(OLD),
            in_queue(OLD),
            removed(OLD, "failed_checks"),
            removed(OLD, "failed_checks"),
        ]);
        github
            .rest
            .borrow_mut()
            .insert(RUNS.into(), VecDeque::from([runs(&[39]), runs(&[39, 40])]));
        github.rest.borrow_mut().insert(
            "actions/runs/40/jobs?per_page=100".into(),
            VecDeque::from([jobs()]),
        );
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(
            error.contains("#7 left the merge queue without merging: failed_checks"),
            "{error}"
        );
        assert!(
            error.contains("- core: failure https://github.com/job/2"),
            "{error}"
        );
        assert!(!error.contains("build"), "{error}");
        // Removed for another reason, the reason is the message and no stale run is blamed.
        let github = self::github(vec![
            open(OLD),
            in_queue(OLD),
            removed(OLD, "invalid_merge_commit"),
            removed(OLD, "invalid_merge_commit"),
        ]);
        github
            .rest
            .borrow_mut()
            .insert(RUNS.into(), VecDeque::from([runs(&[39])]));
        github.rest.borrow_mut().insert(
            "actions/runs/39/jobs?per_page=100".into(),
            VecDeque::from([jobs()]),
        );
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(error.contains("invalid_merge_commit"), "{error}");
        assert!(!error.contains("core"), "{error}");
        assert!(error.contains("query=event%3Amerge_group"), "{error}");
        // Found already queued, the newest run is its own.
        let github = self::github(vec![
            in_queue(OLD),
            removed(OLD, "failed_checks"),
            removed(OLD, "failed_checks"),
        ]);
        github
            .rest
            .borrow_mut()
            .insert(RUNS.into(), VecDeque::from([runs(&[40])]));
        github.rest.borrow_mut().insert(
            "actions/runs/40/jobs?per_page=100".into(),
            VecDeque::from([jobs()]),
        );
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(error.contains("- core: failure"), "{error}");
        assert!(github.queued.borrow().is_empty());
        // One look outside it right after queueing is GitHub catching up, not a failure.
        let github = self::github(vec![open(OLD), open(OLD), in_queue(OLD), merged(OLD)]);
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        assert_eq!(github.queued.borrow().len(), 1);
    }

    #[test]
    fn closed_and_draft_prs_stop_at_once() {
        let mut closed = open(OLD);
        closed["state"] = "CLOSED".into();
        let error = ship(&github(vec![closed])).0.unwrap_err().to_string();
        assert_eq!(error, "#7 was closed without merging");
        let mut draft = open(OLD);
        draft["isDraft"] = true.into();
        let github = github(vec![draft]);
        assert!(
            ship(&github)
                .0
                .unwrap_err()
                .to_string()
                .contains("is a draft")
        );
        assert!(github.queued.borrow().is_empty());
    }

    #[test]
    fn brief_api_failures_are_retried_and_lasting_ones_stop_it() {
        let github = GitHub {
            looks: RefCell::new(VecDeque::from([
                Ok(open(OLD)),
                Err("offline".into()),
                Err("offline".into()),
                Ok(in_queue(OLD)),
                Ok(merged(OLD)),
            ])),
            ..Default::default()
        };
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        let github = GitHub {
            looks: RefCell::new(VecDeque::from([Ok(open(OLD)), Err("offline".into())])),
            ..Default::default()
        };
        let (result, _, pauses) = ship(&github);
        assert_eq!(result.unwrap_err().to_string(), "offline");
        assert_eq!(pauses, ATTEMPTS as usize);
        // A PR that cannot be read at all stops at once: a wrong number or missing access.
        let github = GitHub {
            looks: RefCell::new(VecDeque::from([Err("no such pull request".into())])),
            ..Default::default()
        };
        let (result, _, pauses) = ship(&github);
        assert_eq!(result.unwrap_err().to_string(), "no such pull request");
        assert_eq!(pauses, 0);
    }

    #[test]
    fn a_refused_addition_is_retried_and_a_lasting_refusal_stops_it() {
        let github = github(vec![open(OLD), open(OLD), in_queue(OLD), merged(OLD)]);
        github
            .refusals
            .borrow_mut()
            .push_back("mergeability unknown".into());
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        assert_eq!(github.queued.borrow().len(), 1);
        let github = self::github(vec![open(OLD)]);
        github
            .refusals
            .borrow_mut()
            .extend((0..ATTEMPTS).map(|_| "Pull request is not mergeable".to_owned()));
        assert_eq!(
            ship(&github).0.unwrap_err().to_string(),
            "Pull request is not mergeable"
        );
    }

    #[test]
    fn it_gives_up_after_ninety_minutes() {
        let (result, _, pauses) = ship(&github(vec![in_queue(OLD)]));
        assert_eq!(
            result.unwrap_err().to_string(),
            "Gave up after 90 minutes; #7 has not merged"
        );
        assert_eq!(pauses, LOOKS as usize);
        // So does a head the admission check never reports on.
        let (result, _, pauses) = ship(&github(vec![unadmitted(OLD)]));
        assert!(result.unwrap_err().to_string().contains("Gave up"));
        assert_eq!(pauses, LOOKS as usize);
    }

    const SKIPPED: &str = "Review skipped: manual review required for this OSS repository";
    const MIDDLE: &str = "4444444444444444444444444444444444444444";

    #[test]
    fn a_labelled_pr_waits_for_coderabbit_before_it_is_queued() {
        let github = github(vec![
            labelled(open(OLD), &[]),
            labelled(open(OLD), &[(OLD, "SUCCESS", SKIPPED)]),
            labelled(open(OLD), &[(OLD, "PENDING", "Review in progress")]),
            labelled(open(OLD), &[(OLD, "SUCCESS", REVIEWED)]),
            in_queue(OLD),
            merged(OLD),
        ]);
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(*github.queued.borrow(), [format!("head={OLD}")]);
        assert_eq!(
            said[..3],
            [
                "Waiting for CodeRabbit to start reviewing #7",
                "Waiting for CodeRabbit to review #7",
                "Added #7 to the merge queue at 1111111; the queue runs the checks on its squash commit",
            ]
        );
        // A push after the review is not reviewed again; a review still running on an earlier
        // commit, or asked for again, is awaited.
        let github = self::github(vec![
            labelled(
                open(NEW),
                &[(OLD, "SUCCESS", REVIEWED), (NEW, "SUCCESS", SKIPPED)],
            ),
            in_queue(NEW),
            merged(NEW),
        ]);
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        let again = labelled(
            open(NEW),
            &[
                (OLD, "SUCCESS", REVIEWED),
                (NEW, "PENDING", "Review in progress"),
            ],
        );
        assert_eq!(review(&again), Review::Running);
        let pushed = labelled(open(NEW), &[(OLD, "PENDING", "Review in progress")]);
        assert_eq!(review(&pushed), Review::Running);
        let rerun = labelled(
            open(NEW),
            &[
                (OLD, "SUCCESS", REVIEWED),
                (MIDDLE, "PENDING", "Review in progress"),
            ],
        );
        assert_eq!(review(&rerun), Review::Running);
        // Without the label, CodeRabbit's status holds nothing up.
        let mut unlabelled = labelled(open(OLD), &[(OLD, "PENDING", "Review in progress")]);
        unlabelled["labels"]["nodes"] = json!([]);
        let github = self::github(vec![unlabelled, in_queue(OLD), merged(OLD)]);
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        assert_eq!(github.queued.borrow().len(), 1);
    }

    #[test]
    fn unresolved_review_threads_stop_a_labelled_pr() {
        let mut pr = labelled(open(OLD), &[(OLD, "SUCCESS", REVIEWED)]);
        pr["reviewThreads"]["nodes"] = json!([
            {"isResolved":false,"path":"backend/src/jobs.rs","line":42,
                "comments":{"nodes":[{"author":{"login":"coderabbitai"},"url":"https://github.com/c/1"}]}},
            {"isResolved":true,"path":"backend/src/mail.rs","line":7,
                "comments":{"nodes":[{"author":{"login":"coderabbitai"},"url":"https://github.com/c/2"}]}},
            {"isResolved":false,"path":"docs/ci.md","line":null,
                "comments":{"nodes":[{"author":{"login":"fixture-owner"},"url":"https://github.com/c/3"}]}}
        ]);
        let github = github(vec![pr]);
        let error = ship(&github).0.unwrap_err().to_string();
        assert_eq!(
            error,
            "#7 has unresolved review threads; answer and resolve each, then ship it again:\n\
             - backend/src/jobs.rs:42 coderabbitai https://github.com/c/1\n\
             - docs/ci.md fixture-owner https://github.com/c/3"
        );
        assert!(github.queued.borrow().is_empty());
    }

    #[test]
    fn coderabbit_failing_never_starting_or_running_too_long_stops_it() {
        let failed = labelled(open(OLD), &[(OLD, "FAILURE", "Review failed")]);
        let (result, _, pauses) = ship(&github(vec![failed]));
        let error = result.unwrap_err().to_string();
        assert!(
            error.starts_with("CodeRabbit failed to review #7: Review failed;"),
            "{error}"
        );
        assert_eq!(pauses, 0);
        // So does a failure on an earlier commit that nothing reviewed since.
        let pushed = labelled(open(NEW), &[(OLD, "ERROR", "Review failed")]);
        assert_eq!(review(&pushed), Review::Failed("Review failed".into()));
        let retried = labelled(
            open(NEW),
            &[
                (OLD, "ERROR", "Review failed"),
                (MIDDLE, "SUCCESS", REVIEWED),
            ],
        );
        assert_eq!(review(&retried), Review::Done);
        let skipped = labelled(open(OLD), &[(OLD, "SUCCESS", SKIPPED)]);
        let (result, _, pauses) = ship(&github(vec![skipped]));
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains(&format!(
                "has not started reviewing #7, its status: {SKIPPED};"
            )),
            "{error}"
        );
        assert!(
            error.contains("comment `@coderabbitai review` on it"),
            "{error}"
        );
        assert_eq!(pauses, UNSTARTED_LOOKS as usize);
        let running = labelled(open(OLD), &[(OLD, "PENDING", "Review in progress")]);
        let github = github(vec![running]);
        let (result, _, pauses) = ship(&github);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .starts_with("CodeRabbit has not finished reviewing #7 after 20 minutes;")
        );
        assert_eq!(pauses, REVIEW_LOOKS as usize);
        assert!(github.queued.borrow().is_empty());
    }
}
