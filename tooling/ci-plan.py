#!/usr/bin/env python3
"""Choose conservative checks and reuse validation only for the identical merge tree."""

import argparse
from functools import partial
import hashlib
import io
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_artifact
from runtime_artifact import REPOSITORY, latest_run

WORKFLOW = ".github/workflows/checks.yml"
# Branches whose merged PR validation may be promoted instead of repeated.
TRUSTED = {"refs/heads/dev": "dev", "refs/heads/main": "main"}
DASHBOARD_TESTS = json.loads((Path(__file__).resolve().parent / "test-plan.json").read_text())["dashboard"]


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


# The plan job has three minutes; an unreachable API must leave time for the normal plan.
github = partial(runtime_artifact.github, timeout=20)


def scope(paths):
    # Renames include both paths. New shared modules, contracts, dependencies,
    # shared test infrastructure and build configuration deliberately require full CI.
    # The dashboard logic tests are the ones the build check runs in dashboard mode.
    # Everything under tests/browser/, specs and their helpers alike, runs only in the
    # browser suite, which that mode runs in full.
    # Documentation is read by no code or test. It still takes the dashboard checks rather
    # than none: they format-check it and build the artifact Dev installs for every commit.
    # backend/ is excluded because Rust can embed a file with include_str!.
    dashboard = {"dashboard/index.html", "shared/meal-breaks.ts", *DASHBOARD_TESTS}
    allowed = lambda name: (name in dashboard
                            or name.startswith("dashboard/src/")
                            or name.startswith("dashboard/public/")
                            or (name.startswith("tests/browser/") and name.endswith(".ts"))
                            or (name.endswith(".md") and not name.startswith("backend/")))
    if not paths or not all(allowed(name) for name in paths):
        return "full"
    # This helper is browser-only today. Fail closed if a non-dashboard runtime
    # starts consuming it, even when that consumer did not change in this PR.
    if "shared/meal-breaks.ts" in paths:
        for root in (Path("shared"), Path("tooling"), Path("backend")):
            for file in root.rglob("*"):
                if file.is_file() and file.suffix in {".ts", ".tsx", ".js", ".mjs", ".rs"}:
                    content = file.read_text()
                    imported = re.search(
                        r'''(?:from\s*|import\s*\(?|require\s*\()\s*['"][^'"]*meal-breaks(?:\.js|\.ts)?['"]''', content)
                    embedded = file.suffix == ".rs" and re.search(
                        r'''include_(?:str|bytes)!\s*\(\s*"[^"]*meal-breaks\.(?:ts|js)"''', content)
                    if file.as_posix() != "shared/meal-breaks.ts" and (imported or embedded):
                        return "full"
    return "dashboard"


def changes(base, commit="HEAD"):
    output = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, commit], text=True)
    return output.split("\0")[:-1]


def merge_context():
    parts = git("rev-list", "--parents", "-n", "1", "HEAD").split()
    if len(parts) != 3:
        return None
    commit, base, head = parts
    return {"commit": commit, "base": base, "head": head, "tree": git("rev-parse", "HEAD^{tree}")}


def trusted_run(run, head):
    return (run.get("head_sha") == head and run.get("event") == "pull_request"
            and run.get("status") == "completed" and run.get("conclusion") == "success"
            and run.get("path") == WORKFLOW
            and (run.get("head_repository") or {}).get("full_name") == REPOSITORY)


def read_receipt(archive, digest):
    if len(archive) > 100_000 or digest != "sha256:" + hashlib.sha256(archive).hexdigest():
        raise ValueError("Validation archive digest mismatch")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        if bundle.namelist() != ["validation.json"] or bundle.getinfo("validation.json").file_size > 16_000:
            raise ValueError("Invalid validation archive")
        receipt = json.loads(bundle.read("validation.json"))
        if not isinstance(receipt, dict):
            raise ValueError("Invalid validation receipt")
        return receipt


def matches(receipt, run, context, expected_scope, base_ref="dev"):
    return (receipt.get("format") == 1 and receipt.get("repository") == REPOSITORY
            and receipt.get("workflow") == WORKFLOW and receipt.get("baseRef") == base_ref
            and receipt.get("runId") == run["id"]
            and receipt.get("attempt") == run.get("run_attempt", 1)
            and receipt.get("base") == context["base"]
            and receipt.get("head") == context["head"]
            and receipt.get("tree") == context["tree"]
            and receipt.get("scope") in {"full", expected_scope})


def validated_receipt(context, base_ref="dev"):
    runs = github(f"actions/workflows/checks.yml/runs?event=pull_request&head_sha={context['head']}&per_page=5")["workflow_runs"]
    # Never revive an older green run after a newer failed/pending rerun, nor after
    # the PR returned to draft, where the newest run skipped every check.
    run = latest_run(runs, context["head"], "pull_request", skipped=True)
    if not run or not trusted_run(run, context["head"]):
        return None
    name = f"dispatch-validation-{run['id']}-{run.get('run_attempt', 1)}"
    artifacts = github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
    candidates = [item for item in artifacts if item["name"] == name and not item["expired"]]
    if len(candidates) != 1 or candidates[0]["size_in_bytes"] > 100_000:
        return None
    artifact = candidates[0]
    archive = github(f"actions/artifacts/{artifact['id']}/zip", binary=True)
    receipt = read_receipt(archive, artifact.get("digest"))
    # Release PRs always run every suite, so main never accepts a narrower receipt.
    expected = scope(changes(context["base"])) if base_ref == "dev" else "full"
    if matches(receipt, run, context, expected, base_ref):
        return run, receipt
    return None


def validated_run(context, base_ref="dev"):
    verified = validated_receipt(context, base_ref)
    return verified[0]["id"] if verified else None


def plan(event_name, ref, event):
    if event_name == "pull_request" and event["pull_request"].get("draft"):
        return "draft", "Draft PR: expensive checks start when marked ready for review"
    if event_name == "push" and ref in TRUSTED:
        context = merge_context()
        if context:
            try:
                run = validated_run(context, TRUSTED[ref])
                if run:
                    return "reuse", f"Identical base, head and source tree validated by PR run {run}"
            except (OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile,
                    subprocess.SubprocessError):
                print("Validation receipt unavailable; running checks normally.")
        if ref != "refs/heads/dev":
            return "full", "Full validation for a release without a reusable PR validation"
        base = event.get("before")
    elif event_name == "pull_request" and event["pull_request"]["base"]["ref"] == "dev":
        base = event["pull_request"]["base"]["sha"]
    else:
        return "full", "Full validation for release, manual or scheduled checks"
    try:
        selected = scope(changes(base)) if base else "full"
    except subprocess.SubprocessError:
        selected = "full"
    return selected, "Dashboard, browser tests or documentation only" if selected == "dashboard" else "Backend, shared contracts, infrastructure or unknown changes"


def receipt(event, selected):
    context = merge_context()
    pr = event["pull_request"]
    base_ref = pr["base"]["ref"]
    if (not context or pr.get("draft") or selected not in ("dashboard", "full")
            or base_ref not in TRUSTED.values() or (base_ref != "dev" and selected != "full")
            or pr["base"]["repo"]["full_name"] != REPOSITORY
            or (pr["head"]["repo"] or {}).get("full_name") != REPOSITORY
            or context["commit"] != os.environ["GITHUB_SHA"]
            or context["base"] != pr["base"]["sha"] or context["head"] != pr["head"]["sha"]):
        raise ValueError("Validation receipt requires the actual same-repository PR merge")
    if selected != "full" and selected != scope(changes(context["base"])):
        raise ValueError("Insufficient validation scope")
    value = {"format": 1, "repository": REPOSITORY, "workflow": WORKFLOW, "baseRef": base_ref,
             "runId": int(os.environ["GITHUB_RUN_ID"]), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
             "scope": selected, **context}
    rust_key = os.environ.get("CI_RUST_KEY", "")
    if re.fullmatch(r"[a-f0-9]{64}", rust_key):
        value["rustKey"] = rust_key
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "receipt"])
    parser.add_argument("--scope", choices=["dashboard", "full"])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if args.command == "receipt":
        args.output.write_text(json.dumps(receipt(event, args.scope)) + "\n")
        return
    selected, reason = plan(os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"], event)
    print(f"Validation: {selected} — {reason}")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"mode={selected}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(f"Validation: **{selected}**. {reason}.\n")


if __name__ == "__main__":
    main()
