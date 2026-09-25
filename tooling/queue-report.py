#!/usr/bin/env python3
"""The report job of a failed queue run: `queue-report.py --run <id> --attempt <n> --head-ref
<ref> --base-sha <sha> --head-sha <sha>` posts the run's failed jobs, the step each failed at,
a link to each log and the first failure's output as one comment on the PR the queue was
testing, which GitHub otherwise records only as a one-line timeline event."""
import argparse
from datetime import datetime
import json
import re
import sys
import tempfile

from runtime_artifact import REPOSITORY, github, require

# The queue's branch names the PR: refs/heads/gh-readonly-queue/main/pr-<number>-<base sha>.
QUEUE_BRANCH = re.compile(r"/pr-(\d+)-[0-9a-f]+$")
FAILED = {"failure", "cancelled", "timed_out", "startup_failure"}
# Jobs whose failure never fails the run: `tools` continues on error, and the gate fails only
# because a suite did, so it is listed only when it failed alone.
NEVER_LISTED = {"tools"}
GATE = "platform"
# Where a log's failure begins, in the order the test runners print them: Playwright's numbered
# failure, unittest, Cargo's failure list and panics, TAP, rustc, npm and a generic error line.
MARKERS = re.compile(
    r"^(\s*\d+\) |FAIL: |ERROR: |failures:$|thread '.*' panicked|not ok \d|error(\[E\d+\])?: |"
    r"npm error |\s*Error: )"
)
STOP = "##[error]"
# The line `check:ci` prints when a check fails, after which a job's log moves on to its next check.
END = re.compile(r"^\[fail\] ")
ESCAPES = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
TIMESTAMP = re.compile(r"^\S+Z ")
EXCERPT_LINES = 30
LINE_WIDTH = 200


def pull_number(head_ref):
    found = QUEUE_BRANCH.search(head_ref or "")
    require(found, f"Not a merge queue branch: {head_ref!r}")
    return int(found.group(1))


def failed_jobs(jobs):
    """The jobs that failed the run, each with the step it failed at: the gate alone only when
    nothing else failed, since it fails whenever a suite did."""
    failed = [job for job in jobs if job.get("conclusion") in FAILED and job["name"] not in NEVER_LISTED]
    suites = [job for job in failed if job["name"] != GATE]
    return [
        {
            "name": job["name"],
            "conclusion": job.get("conclusion"),
            "step": next((step["name"] for step in job.get("steps") or [] if step.get("conclusion") in FAILED), ""),
            "url": job.get("html_url", ""),
            "id": job.get("id"),
        }
        for job in (suites or failed)
    ]


def clean(log):
    """The log's lines without timestamps, colours and the runner's grouping markers."""
    lines = []
    for line in log.decode("utf-8", errors="replace").splitlines():
        line = TIMESTAMP.sub("", ESCAPES.sub("", line)).rstrip()
        if line.startswith("##[group]") or line.startswith("##[endgroup]"):
            continue
        lines.append(line)
    return lines


def excerpt(log):
    """The first failure in `log`: the lines from its first failure marker through the check's
    own failure line, or the lines before the runner's error line when nothing else marks the
    failure."""
    lines = clean(log)
    stop = next((i for i, line in enumerate(lines) if line.startswith(STOP)), len(lines))
    start = next((i for i, line in enumerate(lines[:stop]) if MARKERS.match(line)), None)
    if start is None:
        start = max(stop - EXCERPT_LINES, 0)
    limit = min(start + EXCERPT_LINES, stop)
    end = next((i + 1 for i in range(start, limit) if END.match(lines[i])), limit)
    chosen = [line[:LINE_WIDTH] for line in lines[start:end]]
    while chosen and not chosen[-1].strip():
        chosen.pop()
    more = stop - (start + len(chosen))
    return "\n".join(chosen), max(more, 0)


def duration(run):
    """The run's wall time, as the PR page shows it."""
    try:
        started = datetime.fromisoformat(run["run_started_at"].replace("Z", "+00:00"))
        ended = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        return ""
    seconds = max(int((ended - started).total_seconds()), 0)
    return f"{seconds // 60}m {seconds % 60:02d}s"


def comment(run, attempt, base_sha, head_sha, failed, first_excerpt):
    url = run.get("html_url", "")
    lines = [
        f"### :x: Queue run failed on `{head_sha[:7]}`",
        "",
        f"The merge queue tested this PR squashed onto `main` at `{base_sha[:7]}` and removed it. "
        "Nothing was merged. Fix on the branch, push, and ship again.",
        "",
        "| Job | Failed step | Log |",
        "|---|---|---|",
    ]
    for job in failed:
        step = job["step"] or job["conclusion"] or ""
        lines.append(f"| `{job['name']}` | {step} | [view]({job['url']}) |")
    text, more = first_excerpt
    if text:
        tail = f"\n\n… {more} more lines in the log" if more else ""
        lines += [
            "",
            "<details>",
            f"<summary>First failure in <code>{failed[0]['name']}</code></summary>",
            "",
            "```",
            text.replace("```", "'''"),
            f"```{tail}",
            "",
            "</details>",
        ]
    when = duration(run)
    lines += ["", f"[Full run]({url}) · attempt {attempt}" + (f" · {when}" if when else "")]
    return "\n".join(lines) + "\n"


def post(number, body):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as out:
        json.dump({"body": body}, out)
    github(f"issues/{number}/comments", "--method", "POST", "--input", out.name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, help="the workflow run's id")
    parser.add_argument("--attempt", required=True, type=int)
    parser.add_argument("--head-ref", required=True, help="the merge group's branch, which names the PR")
    parser.add_argument("--base-sha", required=True, help="the main commit the PR was squashed onto")
    parser.add_argument("--head-sha", required=True, help="the squash commit the queue tested")
    args = parser.parse_args(argv)
    number = pull_number(args.head_ref)
    run = github(f"actions/runs/{args.run}")
    jobs = github(f"actions/runs/{args.run}/jobs?filter=latest&per_page=100").get("jobs") or []
    failed = failed_jobs(jobs)
    require(failed, "No failed job to report")
    log = github(f"actions/jobs/{failed[0]['id']}/logs", "--allow-escape-sequences", binary=True)
    post(number, comment(run, args.attempt, args.base_sha, args.head_sha, failed, excerpt(log)))
    print(f"Reported {len(failed)} failed job(s) of run {args.run} on https://github.com/{REPOSITORY}/pull/{number}")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as problem:
        print(problem, file=sys.stderr)
        sys.exit(1)
