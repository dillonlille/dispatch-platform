#!/usr/bin/env python3
"""Preflight final PR validation without pushing, merging or restarting checks."""
import argparse
import json
import subprocess
import sys

REPOSITORY = "dillonlille/dispatch-platform"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def blockers(branch, dirty, current_base, pulls, allow_concurrent=False):
    problems = []
    if branch in ("dev", "main", "HEAD"):
        problems.append("Use an isolated feature branch.")
    if dirty:
        problems.append("Commit the completed changes before starting final validation.")
    if not current_base:
        problems.append("origin/dev has advanced. Incorporate it once, review the combined change, then rerun this preflight.")
    others = [pr for pr in pulls if pr["headRefName"] != branch and not pr["isDraft"]]
    if others and not allow_concurrent:
        problems.append("Finish the ready Dev PRs first, or leave this PR as a draft: "
                        + ", ".join(f"#{pr['number']}" for pr in others)
                        + ". Use --allow-concurrent when overlap is intentional.")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-concurrent", action="store_true")
    args = parser.parse_args()
    branch = run("git", "rev-parse", "--abbrev-ref", "HEAD")
    dirty = bool(run("git", "status", "--porcelain"))
    subprocess.run(["git", "fetch", "origin", "dev"], check=True)
    current = subprocess.run(["git", "merge-base", "--is-ancestor", "origin/dev", "HEAD"]).returncode == 0
    pulls = json.loads(run("gh", "pr", "list", "--repo", REPOSITORY, "--base", "dev", "--state", "open",
                           "--json", "number,headRefName,isDraft,statusCheckRollup"))
    problems = blockers(branch, dirty, current, pulls, args.allow_concurrent)
    if problems:
        print("PR preparation needs attention:\n" + "\n".join("- " + item for item in problems))
        return 1
    print("Run focused local checks for the changed behavior. GitHub runs the full required validation; "
          "review the PR while it runs. Repeat checks only for new changes or failures.")
    print("Ready for final validation against " + run("git", "rev-parse", "--short", "origin/dev") + ".")
    own = next((pr for pr in pulls if pr["headRefName"] == branch), None)
    if own and any(check.get("status") in {"QUEUED", "IN_PROGRESS", "PENDING"}
                   for check in own.get("statusCheckRollup", [])):
        print("This PR already has checks running. Avoid another push unless there is a necessary correction.")
    else:
        print("Push the final head and open the PR, or mark its draft ready once. Await checks before merging.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
