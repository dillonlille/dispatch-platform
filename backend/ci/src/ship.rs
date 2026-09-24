//! `npm run pr:ship -- <number>`: wait for a PR's checks, add it to the merge queue bound to
//! the head they passed on, and wait until GitHub merges it. Everything is read from GitHub's
//! API, never from a command's text: a newer push is followed to its own checks, and the wait
//! stops with the reason when a check fails, the PR closes or it leaves the queue unmerged.
use crate::{REPOSITORY, Result, Runner};
use serde_json::Value;

/// The one check branch protection requires; the queue refuses a PR without it.
const REQUIRED: &str = "platform";
/// Seconds between looks at the PR, and how many looks bound the whole wait: 90 minutes.
const PAUSE: u64 = 20;
const LOOKS: u32 = 270;
/// Consecutive failed API calls, or refused additions to the queue, before giving up.
const ATTEMPTS: u32 = 5;

const LOOK: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state isDraft headRefOid mergeCommit{oid} mergeQueueEntry{state position} commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){nodes{__typename ...on CheckRun{name conclusion detailsUrl} ...on StatusContext{context state targetUrl}}}}}}}}}}";
const ENQUEUE: &str = "mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}";

/// What the checks on a PR's current head say.
#[derive(Debug, PartialEq)]
enum Checks {
    Pending,
    Passed,
    Failed(Vec<String>),
}

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

/// The checks of the PR's current head. A commit GitHub has not attached checks to yet, or
/// a head the checks do not belong to, is still pending.
fn checks(pr: &Value) -> Checks {
    let commit = &pr["commits"]["nodes"][0]["commit"];
    if commit["oid"] != pr["headRefOid"] {
        return Checks::Pending;
    }
    let rollup = &commit["statusCheckRollup"];
    let mut required = false;
    let mut failed = vec![];
    for context in rollup["contexts"]["nodes"].as_array().into_iter().flatten() {
        let (name, result, url) = if context["__typename"] == "CheckRun" {
            (
                &context["name"],
                &context["conclusion"],
                &context["detailsUrl"],
            )
        } else {
            (
                &context["context"],
                &context["state"],
                &context["targetUrl"],
            )
        };
        let result = result.as_str().unwrap_or("");
        required |= name == REQUIRED && result == "SUCCESS";
        if matches!(
            result,
            "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "ERROR"
        ) {
            failed.push(format!(
                "{}: {} {}",
                name.as_str().unwrap_or("check"),
                result.to_lowercase(),
                url.as_str().unwrap_or("")
            ));
        }
    }
    if !failed.is_empty() {
        Checks::Failed(failed)
    } else if rollup["state"] == "SUCCESS" && required {
        Checks::Passed
    } else {
        Checks::Pending
    }
}

fn short(head: &Value) -> &str {
    head.as_str().map_or("", |head| &head[..head.len().min(7)])
}

/// Wait for `number`'s checks, queue it and wait for the merge; returns the merge commit.
/// `pause` waits between looks and `say` reports each change of progress once.
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
                return Err(format!(
                    "#{number} left the merge queue without merging: its queue run failed or it was removed. Queue runs: https://github.com/{REPOSITORY}/actions?query=event%3Amerge_group"
                )
                .into());
            }
            pause(PAUSE);
            continue;
        }
        match checks(&pr) {
            Checks::Pending => note(format!("Waiting for the checks on {}", short(head))),
            Checks::Failed(failed) => {
                return Err(format!(
                    "Checks failed on {} of #{number}:\n- {}",
                    short(head),
                    failed.join("\n- ")
                )
                .into());
            }
            Checks::Passed => {
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
                            "Checks passed on {}; added #{number} to the merge queue",
                            short(&head.into())
                        ));
                    }
                    // Refused when the head moved meanwhile: the next look follows it.
                    Err(error) => {
                        refused += 1;
                        if refused >= ATTEMPTS {
                            return Err(error);
                        }
                    }
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
    use std::{cell::RefCell, collections::VecDeque, path::Path};

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";

    /// GitHub as a script: each look answers with the next PR state, the last one repeating.
    #[derive(Default)]
    struct GitHub {
        looks: RefCell<VecDeque<Result<Value>>>,
        refusals: RefCell<VecDeque<String>>,
        queued: RefCell<Vec<String>>,
    }
    impl Runner for GitHub {
        fn command(&self, args: &[&str], _cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>> {
            assert_eq!(&args[..4], ["gh", "api", "graphql", "-f"]);
            assert_eq!(timeout, 60);
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
    fn pr(head: &str, checks: &[(&str, &str)], rollup: &str) -> Value {
        let nodes: Vec<_> = checks
            .iter()
            .map(|(name, conclusion)| json!({"__typename":"CheckRun","name":name,"conclusion":conclusion,"detailsUrl":format!("https://github.com/run/{name}")}))
            .collect();
        json!({"id":"PR_1","state":"OPEN","isDraft":false,"headRefOid":head,"mergeCommit":null,"mergeQueueEntry":null,
            "commits":{"nodes":[{"commit":{"oid":head,"statusCheckRollup":{"state":rollup,"contexts":{"nodes":nodes}}}}]}})
    }
    fn green(head: &str) -> Value {
        pr(
            head,
            &[
                ("build", "SUCCESS"),
                ("tools", "SKIPPED"),
                (REQUIRED, "SUCCESS"),
            ],
            "SUCCESS",
        )
    }
    fn running(head: &str) -> Value {
        pr(head, &[("build", "SUCCESS"), (REQUIRED, "")], "PENDING")
    }
    fn in_queue(head: &str) -> Value {
        let mut value = green(head);
        value["mergeQueueEntry"] = json!({"state":"AWAITING_CHECKS","position":1});
        value
    }
    fn merged(head: &str) -> Value {
        let mut value = green(head);
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
    fn waits_for_the_checks_then_queues_that_head_and_returns_the_merge() {
        let github = github(vec![
            running(OLD),
            running(OLD),
            green(OLD),
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
                "Waiting for the checks on 1111111",
                "Checks passed on 1111111; added #7 to the merge queue",
                "#7 is in the merge queue at position 1: awaiting_checks",
            ]
        );
    }

    #[test]
    fn a_newer_push_is_followed_to_its_own_checks() {
        // The old head's checks were cancelled by the push; only the new head's decide.
        let cancelled = pr(OLD, &[(REQUIRED, "CANCELLED")], "FAILURE");
        let mut moved = cancelled.clone();
        moved["headRefOid"] = NEW.into();
        let github = github(vec![
            running(OLD),
            moved,
            running(NEW),
            green(NEW),
            merged(NEW),
        ]);
        let (result, said, _) = ship(&github);
        assert_eq!(result.unwrap(), "3333333");
        assert_eq!(*github.queued.borrow(), [format!("head={NEW}")]);
        assert!(said.contains(&"Waiting for the checks on 2222222".to_owned()));
    }

    #[test]
    fn a_failed_check_stops_with_its_name_and_link_and_nothing_is_queued() {
        let failing = pr(
            OLD,
            &[("build", "SUCCESS"), ("core", "FAILURE"), (REQUIRED, "")],
            "FAILURE",
        );
        let github = github(vec![running(OLD), failing]);
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(error.contains("Checks failed on 1111111 of #7"), "{error}");
        assert!(
            error.contains("- core: failure https://github.com/run/core"),
            "{error}"
        );
        assert!(github.queued.borrow().is_empty());
    }

    #[test]
    fn success_without_the_required_check_is_still_pending() {
        // A rollup can turn green before the gate job reports; only the gate decides.
        let early = pr(OLD, &[("build", "SUCCESS")], "SUCCESS");
        assert_eq!(checks(&early), Checks::Pending);
        assert_eq!(checks(&green(OLD)), Checks::Passed);
        // Checks attached to another commit than the head are not the head's.
        let mut stale = green(OLD);
        stale["headRefOid"] = NEW.into();
        assert_eq!(checks(&stale), Checks::Pending);
        let mut none = green(OLD);
        none["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null;
        assert_eq!(checks(&none), Checks::Pending);
    }

    #[test]
    fn an_already_queued_pr_is_not_queued_again() {
        let github = github(vec![in_queue(OLD), merged(OLD)]);
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        assert!(github.queued.borrow().is_empty());
    }

    #[test]
    fn leaving_the_queue_unmerged_stops_after_a_second_look() {
        let github = github(vec![in_queue(OLD), green(OLD), green(OLD)]);
        let error = ship(&github).0.unwrap_err().to_string();
        assert!(
            error.contains("#7 left the merge queue without merging"),
            "{error}"
        );
        assert!(github.queued.borrow().is_empty());
        // One look outside it right after queueing is GitHub catching up, not a failure.
        let github = self::github(vec![green(OLD), green(OLD), in_queue(OLD), merged(OLD)]);
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        assert_eq!(github.queued.borrow().len(), 1);
    }

    #[test]
    fn closed_and_draft_prs_stop_at_once() {
        let mut closed = green(OLD);
        closed["state"] = "CLOSED".into();
        let error = ship(&github(vec![closed])).0.unwrap_err().to_string();
        assert_eq!(error, "#7 was closed without merging");
        let mut draft = green(OLD);
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
                Ok(running(OLD)),
                Err("offline".into()),
                Err("offline".into()),
                Ok(green(OLD)),
                Ok(merged(OLD)),
            ])),
            ..Default::default()
        };
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        let github = GitHub {
            looks: RefCell::new(VecDeque::from([Ok(running(OLD)), Err("offline".into())])),
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
        let github = github(vec![green(OLD), green(OLD), in_queue(OLD), merged(OLD)]);
        github.refusals.borrow_mut().push_back("head moved".into());
        assert_eq!(ship(&github).0.unwrap(), "3333333");
        let github = self::github(vec![green(OLD)]);
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
        let (result, _, pauses) = ship(&github(vec![running(OLD)]));
        assert_eq!(
            result.unwrap_err().to_string(),
            "Gave up after 90 minutes; #7 has not merged"
        );
        assert_eq!(pauses, LOOKS as usize);
    }
}
