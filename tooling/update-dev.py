#!/usr/bin/env python3
"""Install verified artifacts from successful dev push checks. Never targets Production."""

import argparse
from datetime import datetime, timezone
import fcntl
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
from runtime_artifact import (REPOSITORY, command, download_run_artifact, github, latest_run, passed,
                              private_directory, require, verify_artifact, write_json)

PRIVATE_PATHS = ("config", "data", "dsps", ".platform.lock")


# The updater imports the shared module, so that is replaced first.
MANAGEMENT = ("runtime_artifact.py", "update-dev.py")


def management_drift(live, tooling=None):
    """Installed host updater files that differ from the checkout's copies."""
    tooling = Path(tooling) if tooling else Path(live) / "tooling"
    installed = Path(live) / ".runtime/management"
    return [name for name in MANAGEMENT if (tooling / name).is_file() and not (
        (installed / name).is_file() and (installed / name).read_bytes() == (tooling / name).read_bytes())]


def install_management(live, tooling=None):
    """The units run this copy, so rolling a failed update's source back never
    changes the updater performing the recovery."""
    target = private_directory(Path(live) / ".runtime/management")
    for name in MANAGEMENT:
        source = (Path(tooling) if tooling else Path(__file__).parent) / name
        if not source.is_file():
            continue
        fd, temporary = tempfile.mkstemp(prefix=".install-", dir=target)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(source.read_bytes())
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, target / name)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class DevUpdater:
    def __init__(self, root):
        self.root = Path(root).absolute()
        require(self.root.name == "dev" and self.root.resolve() == self.root,
                "Updater requires a real dev environment directory")
        private_directory(self.root)
        self.live = self.root
        require((self.live / ".git").is_dir(), "Dev requires its persistent repository checkout")
        # Local exclusions keep private state ignored after rollback to an older .gitignore.
        exclude = self.live / ".git/info/exclude"
        existing = exclude.read_text().splitlines() if exclude.exists() else []
        missing = [f"/{name}" for name in PRIVATE_PATHS if f"/{name}" not in existing]
        if missing:
            with exclude.open("a") as out:
                out.write("\n# Private Dev environment; preserve across updates.\n" + "\n".join(missing) + "\n")
        self.platform = private_directory(self.root / "data/platform")
        self.runtime = private_directory(self.live / ".runtime")
        self.receipt = self.platform / "dev-activation.json"
        self.status_file = self.platform / "dev-update.json"
        self.config = json.loads((self.root / "config/updater.json").read_text())
        require(self.config["service"] == "dispatch-dev.service", "Dev service required")
        require(re.fullmatch(r"http://127\.0\.0\.1:\d+/api/health", self.config["healthUrl"]),
                "Dev health endpoint must be loopback")

    def git(self, *args):
        return command("git", *args, cwd=self.live)

    def clean_checkout(self):
        require(self.git("branch", "--show-current") == "dev", "Dev checkout is on another branch")
        require(not self.git("status", "--porcelain", "--untracked-files=all"),
                "Dev checkout contains unfinished changes")
        require(self.git("remote", "get-url", "origin") in (
            f"https://github.com/{REPOSITORY}.git", f"git@github.com:{REPOSITORY}.git"),
            "Unexpected repository origin")
        self.check_source("HEAD")

    def check_source(self, commit):
        require(not self.git("ls-tree", "-r", "--name-only", commit, "--", *PRIVATE_PATHS),
                "Dev source must not contain private environment paths")

    def status(self, state, commit=None):
        write_json(self.status_file, {"status": state, "commit": commit,
                                    "digest": json.loads((self.live / ".build/release.json").read_text())["digest"],
                                    "updatedAt": datetime.now(timezone.utc).isoformat()})

    def service(self, action):
        command("systemctl", "--user", action, self.config["service"], timeout=90)

    def healthy(self, digest, timeout=40):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(self.config["healthUrl"], timeout=2) as response:
                    data = json.load(response)
                if data.get("status") == "ready" and data.get("environment") == "preview" and data.get("release") == digest:
                    return True
            except (OSError, ValueError):
                pass
            time.sleep(1)
        return False

    def recover(self):
        if not self.receipt.exists():
            return
        record = json.loads(self.receipt.read_text())
        require(record["previous"] == "previous" and
                re.fullmatch(r"[a-f0-9]{40}", record["oldCommit"]) and
                re.fullmatch(r"[a-f0-9]{40}", record["commit"]), "Invalid activation receipt")
        self.clean_checkout()
        require(self.git("rev-parse", "HEAD") in (record["oldCommit"], record["commit"]),
                "Checkout changed during interrupted update")
        previous, active = self.runtime / "previous", self.live / ".build"
        self.service("stop")
        if previous.exists():
            verify_artifact(previous, record["oldCommit"])
            if active.exists():
                require(active.resolve() == active and not active.is_symlink(), "Unsafe build path")
                shutil.rmtree(active)
            previous.rename(active)
        else:
            verify_artifact(active, record["oldCommit"])
        self.git("reset", "--hard", record["oldCommit"])
        self.service("start")
        require(self.healthy(record["oldDigest"]), "Previous Dev build failed health check")
        self.status("rolled_back", record["oldCommit"])
        self.receipt.unlink()

    def activate(self, candidate, commit):
        manifest = verify_artifact(candidate, commit)
        (candidate / "services/rust/dispatch-backend").chmod(0o700)
        self.clean_checkout()
        self.check_source(commit)
        current = self.git("rev-parse", "HEAD")
        old = verify_artifact(self.live / ".build", current)
        require(old["schema"] == manifest["schema"], "Schema change requires an explicit migration plan")
        self.git("merge-base", "--is-ancestor", current, commit)
        self.git("merge-base", "--is-ancestor", commit, "origin/dev")
        previous = self.runtime / "previous"
        if previous.exists():
            require(previous.resolve() == previous and not previous.is_symlink(), "Unsafe rollback path")
            shutil.rmtree(previous)
        write_json(self.receipt, {"commit": commit, "oldCommit": current,
                                 "oldDigest": old["digest"], "previous": "previous"})
        try:
            self.service("stop")
            self.clean_checkout()
            require(self.git("rev-parse", "HEAD") == current, "Checkout changed during update")
            (self.live / ".build").rename(previous)
            candidate.rename(self.live / ".build")
            self.git("merge", "--ff-only", commit)
            self.service("start")
            require(self.healthy(manifest["digest"]), "New Dev build failed health check")
            self.status("ready", commit)
            self.receipt.unlink()
        except BaseException:
            self.recover()
            raise

    def refresh_management(self):
        """Follow the clean, activated checkout so the installed updater cannot drift from it."""
        tooling = self.live / "tooling"
        if not (tooling / "update-dev.py").is_file() or not management_drift(self.live):
            return
        with tempfile.TemporaryDirectory(prefix="management-", dir=self.runtime) as staged:
            install_management(staged, tooling)
            try:
                # Never replace a working updater with one this host cannot even load.
                command(sys.executable, str(Path(staged) / ".runtime/management/update-dev.py"), "--help", timeout=30)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                print(f"Host updater of the checkout does not start and was not installed: {error}", file=sys.stderr)
                return
        install_management(self.live, tooling)

    def update(self):
        self.recover()
        self.clean_checkout()
        self.refresh_management()
        self.git("fetch", "origin", "dev")
        commit = self.git("rev-parse", "origin/dev")
        current = self.git("rev-parse", "HEAD")
        if commit == current:
            return
        runs = github(f"actions/workflows/checks.yml/runs?branch=dev&event=push&head_sha={commit}&per_page=20")["workflow_runs"]
        run = latest_run(runs, commit, "push", "dev")
        if not passed(run):
            self.status("checks_failed" if run and run["status"] == "completed" else "waiting_for_checks", current)
            return
        artifacts = github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
        artifacts = [a for a in artifacts if a["name"] == f"dispatch-dev-{commit}" and not a["expired"]]
        require(len(artifacts) == 1, "Verified Dev artifact unavailable")
        with tempfile.TemporaryDirectory(prefix="update-", dir=self.runtime) as temporary:
            candidate, _manifest = download_run_artifact(artifacts[0], temporary, commit)
            # Fetch/check again so a superseded build never replaces a newer Dev head.
            self.git("fetch", "origin", "dev")
            if self.git("rev-parse", "origin/dev") != commit:
                self.status("waiting_for_checks", current)
                return
            self.activate(candidate, commit)
        self.refresh_management()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--verify-management", action="store_true",
                        help="Fail when the installed host updater differs from the checkout; no unit runs this")
    parser.add_argument("--install-management", action="store_true",
                        help="Install reviewed host updater outside tracked source")
    args = parser.parse_args()
    os.umask(0o077)
    updater = DevUpdater(args.root)
    if args.install_management:
        updater.clean_checkout()
        install_management(updater.live)
        return
    if args.verify:
        updater.clean_checkout()
        verify_artifact(updater.live / ".build", updater.git("rev-parse", "HEAD"))
        (updater.live / ".build/services/rust/dispatch-backend").chmod(0o700)
        # The service runs this before every start, also in the middle of an activation
        # and its rollback, where the checkout is already ahead of or behind the installed
        # updater. Starting never depends on that difference; the next update run removes it.
        drift = management_drift(updater.live)
        if drift:
            print(f"Installed host updater differs from the checkout ({', '.join(drift)}); "
                  "the next update run installs the checkout's copy", file=sys.stderr)
        return
    if args.verify_management:
        drift = management_drift(updater.live)
        require(not drift, f"Installed host updater differs from the checkout ({', '.join(drift)}); "
                "run tooling/update-dev.py --install-management from the checkout")
        return
    with (updater.platform / "dev-update.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        updater.update()


if __name__ == "__main__":
    main()
