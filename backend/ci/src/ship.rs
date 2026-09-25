//! `npm run pr:ship -- <number>`: add a PR to the merge queue at once and wait until GitHub
//! merges it. The queue runs the checks on the exact squash commit it will push, so nothing
//! runs on the PR itself and there is nothing to wait for before queueing. Everything is read
//! from GitHub's API, never from a command's text: a newer push is queued in its turn, and the
//! wait stops with the reason when the PR closes or leaves the queue unmerged, naming the
//! failed jobs of its queue run.
use crate::{REPOSITORY, Result, Runner};
use serde_json::Value;

/// Seconds between looks at the PR, and how many looks bound the whole wait: 90 minutes.
const PAUSE: u64 = 20;
const LOOKS: u32 = 270;
/// Consecutive failed API calls, or refused additions to the queue, before giving up.
const ATTEMPTS: u32 = 5;

const LOOK: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state isDraft headRefOid mergeCommit{oid} mergeQueueEntry{state position}}}}";
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

/// The failed jobs of the newest queue run for `number`, as "name: conclusion link" lines.
/// The queue names its branch after the PR, which is how the run is found. Any API trouble
/// here only costs detail, never the verdict.
fn failed_jobs(runner: &dyn Runner, number: u64) -> Vec<String> {
    let prefix = format!("gh-readonly-queue/main/pr-{number}-");
    let Ok(runs) = rest(
        runner,
        "actions/workflows/checks.yml/runs?event=merge_group&per_page=30",
    ) else {
        return vec![];
    };
    let Some(run) = runs["workflow_runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|run| {
            run["head_branch"]
                .as_str()
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .max_by_key(|run| run["id"].as_u64().unwrap_or(0))
    else {
        return vec![];
    };
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
    let (mut seen, mut unanswered, mut refused) = (false, 0, 0);
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
                let failed = failed_jobs(runner, number);
                return Err(if failed.is_empty() {
                    format!(
                        "#{number} left the merge queue without merging: its queue run failed or it was removed. Queue runs: https://github.com/{REPOSITORY}/actions?query=event%3Amerge_group"
                    )
                } else {
                    format!(
                        "#{number} left the merge queue without merging. Failed jobs of its queue run:\n- {}",
                        failed.join("\n- ")
                    )
                }
                .into());
            }
            pause(PAUSE);
            continue;
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
            // Refused until the admission check has reported on this head, which takes a
            // runner and so a moment; otherwise while GitHub still computes mergeability, or
            // when the head moved meanwhile: the next look tries again or follows the new head.
            Err(error) if error.to_string().contains("is expected") => {
                note(format!(
                    "Waiting for the admission check on {} of #{number}",
                    short(&head.into())
                ));
            }
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

    /// GitHub as a script: each look answers with the next PR state, the last one repeating.
    #[derive(Default)]
    struct GitHub {
        looks: RefCell<VecDeque<Result<Value>>>,
        refusals: RefCell<VecDeque<String>>,
        queued: RefCell<Vec<String>>,
        rest: RefCell<BTreeMap<String, Value>>,
    }
    impl Runner for GitHub {
        fn command(&self, args: &[&str], _cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>> {
            assert_eq!(&args[..2], ["gh", "api"]);
            assert_eq!(timeout, 60);
            if let Some(endpoint) = args[2].strip_prefix(&format!("repos/{REPOSITORY}/")) {
                assert_eq!(args.len(), 3);
                let reply = self.rest.borrow().get(endpoint).cloned();
                return Ok(serde_json::to_vec(&reply.ok_or("not found")?)?);
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
    fn open(head: &str) -> Value {
        json!({"id":"PR_1","state":"OPEN","isDraft":false,"headRefOid":head,"mergeCommit":null,"mergeQueueEntry":null})
    }
    fn in_queue(head: &str) -> Value {
        let mut value = open(head);
        value["mergeQueueEntry"] = json!({"state":"AWAITING_CHECKS","position":1});
        value
    }
    fn merged(head: &str) -> Value {
        let mut value = open(head);
        value["state"] = "MERGED".into();
        value["mergeCommit"] = json!({"oid":"3333333"});
        value
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

    #[test]
    fn queues_the_head_at_once_and_returns_the_merge() {
        let github = github(vec![open(OLD), in_queue(OLD), in_queue(OLD), merged(OLD)]);
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(*github.queued.borrow(), [format!("head={OLD}")]);
        // Each change of progress is reported once.
        assert_eq!(
            said,
            [
                "Added #7 to the merge queue at 1111111; the queue runs the checks on its squash commit",
                "#7 is in the merge queue at position 1: awaiting_checks",
            ]
        );
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
    fn leaving_the_queue_unmerged_names_the_failed_jobs_of_its_run() {
        let github = github(vec![in_queue(OLD), open(OLD), open(OLD)]);
        github.rest.borrow_mut().insert(
            "actions/workflows/checks.yml/runs?event=merge_group&per_page=30".into(),
            json!({"workflow_runs":[
                {"id":40,"head_branch":"gh-readonly-queue/main/pr-7-aaaa"},
                {"id":41,"head_branch":"gh-readonly-queue/main/pr-70-aaaa"},
                {"id":39,"head_branch":"gh-readonly-queue/main/pr-7-bbbb"}]}),
        );
        github.rest.borrow_mut().insert(
            "actions/runs/40/jobs?per_page=100".into(),
            json!({"jobs":[
                {"name":"build","conclusion":"success","html_url":"https://github.com/job/1"},
                {"name":"core","conclusion":"failure","html_url":"https://github.com/job/2"},
                {"name":"platform","conclusion":"failure","html_url":"https://github.com/job/3"}]}),
        );
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(
            error.contains("#7 left the merge queue without merging"),
            "{error}"
        );
        assert!(
            error.contains("- core: failure https://github.com/job/2"),
            "{error}"
        );
        assert!(!error.contains("build"), "{error}");
        assert!(github.queued.borrow().is_empty());
        // Without a run to blame, the queue runs are linked instead.
        let github = self::github(vec![in_queue(OLD), open(OLD), open(OLD)]);
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(error.contains("query=event%3Amerge_group"), "{error}");
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
    fn the_admission_check_is_awaited_without_limit_and_reported_once() {
        let github = github(vec![
            open(OLD),
            open(OLD),
            open(OLD),
            in_queue(OLD),
            merged(OLD),
        ]);
        github.refusals.borrow_mut().extend(
            (0..ATTEMPTS + 2).map(|_| {
                r#"Pull request Required status check "platform" is expected."#.to_owned()
            }),
        );
        let github = GitHub {
            looks: RefCell::new(VecDeque::from([
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(open(OLD)),
                Ok(in_queue(OLD)),
                Ok(merged(OLD)),
            ])),
            refusals: github.refusals,
            ..Default::default()
        };
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(github.queued.borrow().len(), 1);
        assert_eq!(
            said.iter()
                .filter(|text| text.contains("admission"))
                .count(),
            1
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
    }
}
