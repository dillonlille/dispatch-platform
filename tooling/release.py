#!/usr/bin/env python3
"""Release the accepted Dev revision: release PR, checked main build, immutable publication, Production.

Every step first reads what GitHub and the private release directory already
hold, so an interrupted or failed run continues by running the same command.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_artifact import (REPOSITORY, STABLE, command, download_run_artifact, github, latest_run, passed,
                              private_directory, require, unpack, write_json)

ROOT = Path(__file__).resolve().parents[1]
PLATFORM = ROOT.parent
PRODUCTION = "https://dispatch.dillonlille.com"
ASSETS = ("release.json", "provenance.json", "SHA256SUMS")
VERSIONED = ("package.json", "package-lock.json", "backend/Cargo.toml", "Cargo.lock")


def say(message):
    print(f"[release] {message}", flush=True)


def succeeds(*args, cwd=None):
    return subprocess.run(args, cwd=cwd or ROOT, capture_output=True).returncode == 0


def git(*args, cwd=None, timeout=120):
    return command("git", *args, cwd=cwd or ROOT, timeout=timeout)


def next_version(latest, bump="patch"):
    require(re.fullmatch(STABLE, latest), "Latest release is not a stable version")
    major, minor, patch = map(int, latest.split("."))
    return {"major": f"{major + 1}.0.0", "minor": f"{major}.{minor + 1}.0",
            "patch": f"{major}.{minor}.{patch + 1}"}[bump]


def newer(version, latest):
    return tuple(map(int, version.split("."))) > tuple(map(int, latest.split(".")))


def set_versions(root, version):
    """Rewrite only the platform's own version fields; dependency entries stay untouched."""
    def edit(name, pattern, count):
        path = root / name
        text, found = re.subn(pattern, lambda match: match.group(1) + version + match.group(2),
                              path.read_text(), count=count, flags=re.S)
        require(found == count, f"Version field missing in {name}")
        path.write_text(text)
    edit("package.json", r'(\A\{\s*"name": "dispatch-platform",\s*"version": ")[^"]+(")', 1)
    edit("package-lock.json", r'("name": "dispatch-platform",\s*"version": ")[^"]+(")', 2)
    edit("backend/Cargo.toml", r'(\A\[package\]\nname = "dispatch-backend"\nversion = ")[^"]+(")', 1)
    edit("Cargo.lock", r'(\[\[package\]\]\nname = "dispatch-backend"\nversion = ")[^"]+(")', 1)


def current_version(root):
    return json.loads((root / "package.json").read_text())["version"]


def merged_changes(log):
    """Dev PRs from first-parent merge commits: subject names the PR, body holds its title."""
    changes = []
    for entry in filter(None, log.split("\x1e")):
        subject, _, body = entry.strip().partition("\n")
        match = re.match(r"Merge pull request #(\d+) from ", subject)
        if match:
            changes.append(f"- #{match.group(1)} {body.strip().splitlines()[0] if body.strip() else ''}".rstrip())
    return changes


def wait_for_checks(sha, event, branch=None, timeout=1800):
    deadline, announced = time.monotonic() + timeout, False
    while time.monotonic() < deadline:
        query = f"actions/workflows/checks.yml/runs?event={event}&head_sha={sha}&per_page=30"
        run = latest_run(github(query)["workflow_runs"], sha, event, branch)
        if run and not announced:
            say(f"Waiting for {run['html_url']}")
            announced = True
        if run and run["status"] == "completed":
            require(run["conclusion"] == "success",
                    f"Checks ended with {run['conclusion']}: {run['html_url']}\n"
                    "Fix the cause on the branch, push, and run this command again.")
            return run
        time.sleep(10)
    raise RuntimeError(f"No completed checks for {sha} within {timeout // 60} minutes")


def prepare_assets(commit, version, output):
    """Download the fully checked main artifact as the immutable assets of one release."""
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Full source commit required")
    require(re.fullmatch(STABLE, version), "Stable release version required")
    comparison = github(f"compare/{commit}...main")
    require(comparison["status"] in ("ahead", "identical"), "Source must be merged into main")
    runs = github(f"actions/workflows/checks.yml/runs?branch=main&event=push&head_sha={commit}&per_page=30")["workflow_runs"]
    run = latest_run(runs, commit, "push", "main")
    require(run, "No main validation run found")
    require(passed(run), "Main checks have not passed")
    artifacts = github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
    artifacts = [a for a in artifacts if a["name"] == f"dispatch-main-{commit}" and not a["expired"]]
    require(len(artifacts) == 1, "Verified main artifact unavailable")
    artifact = artifacts[0]
    output = Path(output).absolute()
    require(not output.exists(), "Release output already exists; never overwrite prepared assets")
    private_directory(output)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=output) as temporary:
        archive = output / f"dispatch-platform-{version}.tar.gz"
        candidate, manifest = download_run_artifact(artifact, temporary, commit, package=archive)
        require(manifest["version"] == version, "Compiled artifact has another version")
        shutil.copyfile(candidate / "release.json", output / "release.json")
        write_json(output / "provenance.json", {
            "repository": REPOSITORY, "commit": commit, "version": version,
            "workflowRun": run["id"], "workflowAttempt": run["run_attempt"],
            "artifactId": artifact["id"], "artifactDigest": artifact["digest"],
            "runtimeDigest": manifest["digest"],
            "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        })
    names = (archive.name, "release.json", "provenance.json")
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256((output / name).read_bytes()).hexdigest()}  {name}\n" for name in names))
    say(f"Prepared {version} from checked main commit {commit}: {manifest['digest']}")


def asset_problems(release, directory, names):
    """Compare GitHub's recorded digest of every uploaded asset with the prepared bytes."""
    uploaded = {a["name"]: a for a in release["assets"]}
    problems = [f"unexpected asset {name}" for name in sorted(set(uploaded) - set(names))]
    for name in names:
        asset = uploaded.get(name)
        local = directory / name
        if not asset or asset.get("state") != "uploaded":
            problems.append(f"{name} is not uploaded")
        elif asset.get("digest") != "sha256:" + hashlib.sha256(local.read_bytes()).hexdigest() \
                or asset.get("size") != local.stat().st_size:
            problems.append(f"{name} differs from the prepared file")
    return problems


class Release:
    def __init__(self, version, dev_commit, notes, releases):
        self.version, self.tag, self.dev_commit = version, f"v{version}", dev_commit
        self.branch, self.sync_branch = f"release/v{version}", f"chore/sync-main-v{version}"
        self.worktree = PLATFORM / "worktrees" / f"release-v{version}"
        self.sync_worktree = PLATFORM / "worktrees" / f"sync-main-v{version}"
        self.output = releases / f"v{version}"
        self.notes = notes or releases / f"v{version}-notes.md"
        self.archive = f"dispatch-platform-{version}.tar.gz"

    def pull_request(self, branch, base):
        found = json.loads(command("gh", "pr", "list", "--repo", REPOSITORY, "--head", branch, "--base", base,
                                   "--state", "all", "--json", "number,state,url,headRefOid,mergeCommit"))
        require(len(found) <= 1, f"Several pull requests exist for {branch}")
        return found[0] if found else None

    def published(self):
        for release in github("releases?per_page=30"):
            if release["tag_name"] == self.tag:
                return release
        return None

    def checkout(self, worktree, branch, start):
        if not worktree.exists():
            exists = succeeds("git", "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}")
            git("worktree", "add", *([str(worktree), branch] if exists else ["-b", branch, str(worktree), start]))
        require(git("rev-parse", "--abbrev-ref", "HEAD", cwd=worktree) == branch, f"{worktree} is on another branch")
        require(not git("status", "--porcelain", cwd=worktree),
                f"Finish and commit the work in {worktree}, then run this command again")

    def merge_main(self, worktree, message):
        if succeeds("git", "merge-base", "--is-ancestor", "origin/main", "HEAD", cwd=worktree):
            return
        require(succeeds("git", "merge", "--no-edit", "-m", message, "origin/main", cwd=worktree),
                f"origin/main does not merge cleanly in {worktree}.\n"
                "Resolve and commit the merge there, then run this command again.")

    def open_release(self):
        """A branch from the accepted Dev commit plus one version commit, current with main."""
        commit = git("rev-parse", "--verify", f"{self.dev_commit}^{{commit}}")
        require(succeeds("git", "merge-base", "--is-ancestor", commit, "origin/dev"),
                "The release source must be a commit on dev")
        require(not succeeds("git", "diff", "--quiet", "origin/main", commit, "--", ".",
                             *(f":(exclude){name}" for name in VERSIONED)), "Dev has nothing new to release")
        dev_run = latest_run(github(f"actions/workflows/checks.yml/runs?event=push&head_sha={commit}&per_page=30")
                             ["workflow_runs"], commit, "push", "dev")
        require(passed(dev_run),
                f"Dev checks have not passed for {commit}")
        self.checkout(self.worktree, self.branch, commit)
        self.merge_main(self.worktree, f"Merge main into the v{self.version} release")
        if current_version(self.worktree) != self.version:
            set_versions(self.worktree, self.version)
            command("cargo", "metadata", "--locked", "--no-deps", "--format-version=1", cwd=self.worktree)
            git("commit", "-am", f"Prepare v{self.version}", cwd=self.worktree)
        changes = merged_changes(git("log", "--first-parent", "--merges", "--format=%s%n%b%x1e",
                                     f"origin/main..{commit}"))
        git("push", "--set-upstream", "origin", self.branch, cwd=self.worktree, timeout=300)
        body = "\n".join([f"Releases Dev revision {commit} as v{self.version}.", "", *changes])
        command("gh", "pr", "create", "--repo", REPOSITORY, "--base", "main", "--head", self.branch,
                "--title", f"Release Dispatch v{self.version}", "--body", body)
        if changes:
            say("Included changes, for the release notes:\n" + "\n".join(changes))
        return self.pull_request(self.branch, "main")

    def merge_release(self):
        pull = self.pull_request(self.branch, "main") or self.open_release()
        require(pull["state"] != "CLOSED", f"{pull['url']} was closed without merging")
        if pull["state"] == "OPEN":
            say(f"Release PR {pull['url']}")
            head = pull["headRefOid"]
            if self.worktree.exists():
                # Pick up fixes committed on the release branch since the last attempt,
                # and main must be contained before GitHub allows the merge.
                self.checkout(self.worktree, self.branch, self.branch)
                self.merge_main(self.worktree, f"Merge main into the v{self.version} release")
                git("push", "origin", self.branch, cwd=self.worktree, timeout=300)
                head = git("rev-parse", "HEAD", cwd=self.worktree)
            wait_for_checks(head, "pull_request")
            command("gh", "pr", "merge", str(pull["number"]), "--repo", REPOSITORY, "--merge",
                    "--match-head-commit", head)
            pull = self.pull_request(self.branch, "main")
        require(pull["state"] == "MERGED" and pull["mergeCommit"], "Release PR did not merge")
        return pull["mergeCommit"]["oid"]

    def open_sync(self):
        """Return main's release commits to dev so the next release starts from shared history."""
        pull = self.pull_request(self.sync_branch, "dev")
        if pull:
            return pull
        git("fetch", "origin", "main", "dev")
        if succeeds("git", "merge-base", "--is-ancestor", "origin/main", "origin/dev"):
            return None
        try:
            self.checkout(self.sync_worktree, self.sync_branch, "origin/dev")
            self.merge_main(self.sync_worktree, f"Bring the v{self.version} release from main into dev")
        except RuntimeError as error:
            say(f"Dev sync needs attention and does not block this release: {error}")
            return None
        git("push", "--set-upstream", "origin", self.sync_branch, cwd=self.sync_worktree, timeout=300)
        command("gh", "pr", "create", "--repo", REPOSITORY, "--base", "dev", "--head", self.sync_branch,
                "--title", f"Bring the v{self.version} release from main into dev",
                "--body", f"Keeps dev and main on shared history after v{self.version}.")
        return self.pull_request(self.sync_branch, "dev")

    def prepare(self, commit):
        if self.output.exists():
            provenance = json.loads((self.output / "provenance.json").read_text())
            require(provenance["commit"] == commit and provenance["version"] == self.version
                    and (self.output / "SHA256SUMS").exists(), f"{self.output} holds another preparation")
            return provenance
        wait_for_checks(commit, "push", "main")
        prepare_assets(commit, self.version, self.output)
        return json.loads((self.output / "provenance.json").read_text())

    def smoke(self):
        """Start the exact published bytes against disposable state."""
        tsx = ROOT / "node_modules/.bin/tsx"
        require(tsx.exists(), f"Install the platform's Node packages in {ROOT} for the smoke check")
        with tempfile.TemporaryDirectory(prefix="dispatch-release-smoke-") as temporary:
            unpack(self.output / self.archive, Path(temporary) / ".build")
            (Path(temporary) / ".build/services/rust/dispatch-backend").chmod(0o700)
            subprocess.run([str(tsx), str(ROOT / "tooling/browser-check.ts"), "--smoke-only"],
                           cwd=temporary, check=True, timeout=300)

    def publish(self, commit):
        release = self.published()
        if release and not release["draft"]:
            return release
        names = (self.archive, *ASSETS)
        if not release:
            waited = False
            while not self.notes.exists() or not self.notes.read_text().strip():
                if not waited:
                    say(f"Waiting for the release notes in {self.notes}")
                    waited = True
                time.sleep(5)
            shutil.copyfile(self.notes, self.output / "notes.md")
            command("gh", "release", "create", self.tag, "--repo", REPOSITORY, "--draft", "--target", commit,
                    "--title", f"Dispatch {self.version}", "--notes-file", str(self.output / "notes.md"),
                    *(str(self.output / name) for name in names), timeout=600)
            # GitHub can list a new draft a few seconds after creating it.
            deadline = time.monotonic() + 60
            while not (release := self.published()) and time.monotonic() < deadline:
                time.sleep(3)
        require(release and release["draft"] and release["target_commitish"] == commit,
                "Draft release is missing or targets another commit")
        problems = asset_problems(release, self.output, names)
        require(not problems, "Draft assets failed verification: " + "; ".join(problems))
        write_json(self.output / "draft-verification.json",
                   {"releaseId": release["id"], "assetsVerified": True, "commit": commit})
        github(f"releases/{release['id']}", "--method", "PATCH", "-F", "draft=false", "-f", "make_latest=true")
        release = self.published()
        require(release and not release["draft"] and not release["prerelease"], "Publication did not complete")
        return release

    def verify_production(self, provenance, release, timeout=600):
        def fetch(path):
            request = urllib.request.Request(PRODUCTION + path, headers={"User-Agent": "dispatch-release"})
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.read()
        deadline, health = time.monotonic() + timeout, None
        say("Waiting for Production to install the release")
        while time.monotonic() < deadline:
            try:
                health = json.loads(fetch("/api/health"))
                if (health.get("release") == provenance["runtimeDigest"] and health.get("status") == "ready"
                        and health.get("environment") == "production"):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(5)
        else:
            raise RuntimeError(f"Production did not report {provenance['runtimeDigest']}; last health: {health}\n"
                               "Inspect dispatch-production-update.service with read-only access.")
        assets = re.findall(r'(?:src|href)="(\.?/assets/[^"]+)"', fetch("/").decode())
        require(len(assets) >= 2, "Production dashboard is missing its assets")
        for asset in assets:
            fetch("/" + asset.lstrip("./"))
        write_json(self.output / "deployment-verification.json", {
            "version": self.version, "commit": provenance["commit"], "runtimeDigest": provenance["runtimeDigest"],
            "publicHealth": health, "publicAssetsVerified": len(assets),
            "mainCheckRun": provenance["workflowRun"], "release": release["html_url"]})

    def finish_sync(self, pull):
        if not pull or pull["state"] != "OPEN":
            return
        try:
            wait_for_checks(pull["headRefOid"], "pull_request")
            command("gh", "pr", "merge", str(pull["number"]), "--repo", REPOSITORY, "--merge",
                    "--match-head-commit", pull["headRefOid"])
        except RuntimeError as error:
            say(f"Dev sync {pull['url']} is still open: {error}")

    def clean(self):
        for worktree, branch in ((self.worktree, self.branch), (self.sync_worktree, self.sync_branch)):
            base = "dev" if branch == self.sync_branch else "main"
            pull = self.pull_request(branch, base)
            if not pull or pull["state"] != "MERGED":
                continue
            if worktree.exists() and not git("status", "--porcelain", cwd=worktree):
                git("worktree", "remove", str(worktree))
            if not worktree.exists():
                succeeds("git", "branch", "-D", branch)
        if self.notes.exists() and (self.output / "notes.md").exists():
            self.notes.unlink()

    def run(self):
        commit = self.merge_release()
        say(f"Release merged into main as {commit}")
        sync = self.open_sync()
        provenance = self.prepare(commit)
        self.smoke()
        release = self.publish(commit)
        say(f"Published {release['html_url']}")
        self.verify_production(provenance, release)
        say(f"Production is healthy on {self.version} ({provenance['runtimeDigest']})")
        self.finish_sync(sync)
        self.clean()


def unfinished():
    """A release that was started and not yet published, so a bare rerun continues it."""
    pulls = json.loads(command("gh", "pr", "list", "--repo", REPOSITORY, "--base", "main", "--state", "open",
                               "--json", "headRefName"))
    found = {p["headRefName"][len("release/v"):] for p in pulls if p["headRefName"].startswith("release/v")}
    found |= {r["tag_name"][1:] for r in github("releases?per_page=30") if r["draft"]}
    found = {value for value in found if re.fullmatch(STABLE, value)}
    require(len(found) <= 1, "Several releases are unfinished; name the version to continue")
    return found.pop() if found else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", nargs="?", help="Stable X.Y.Z; defaults to the next patch version")
    parser.add_argument("--bump", choices=["patch", "minor", "major"], default="patch")
    parser.add_argument("--dev-commit", default="origin/dev", help="Accepted Dev revision; defaults to the dev tip")
    parser.add_argument("--notes", type=Path, help="Release notes; defaults to <releases>/vX.Y.Z-notes.md")
    parser.add_argument("--releases", type=Path, default=PLATFORM / "releases")
    args = parser.parse_args()
    os.umask(0o077)
    command("gh", "auth", "status")
    git("fetch", "origin", "main", "dev", timeout=300)
    published = [r["tag_name"][1:] for r in github("releases?per_page=100")
                 if not r["draft"] and re.fullmatch("v" + STABLE, r["tag_name"])]
    latest = max(published, key=lambda value: tuple(map(int, value.split("."))), default="0.0.0")
    version = args.version or unfinished() or next_version(latest, args.bump)
    require(re.fullmatch(STABLE, version), "Stable X.Y.Z version required")
    # Continuing an already published release only verifies Production and cleans up.
    require(version in published or newer(version, latest), f"{version} is not newer than {latest}")
    say(f"Releasing {version} (latest published: {latest})")
    releases = args.releases.absolute()
    releases.mkdir(parents=True, exist_ok=True)
    Release(version, args.dev_commit, args.notes, releases).run()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(f"[release] Stopped: {error}")
