#!/usr/bin/env python3
"""Install verified artifacts from successful dev push checks. Never targets Production."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile

REPOSITORY = "dillonlille/dispatch-platform"
MANAGED = {"api", "dashboard", "services", "integrations", "shared", "tooling",
           "node_modules", "package.json", "package-lock.json", "release.json"}
MAX_BYTES = 1024 * 1024 * 1024
PRIVATE_PATHS = ("config", "data", "dsps", ".platform.lock")


def require(value, message):
    if not value:
        raise RuntimeError(message)


def command(*args, cwd=None, timeout=120):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    require(result.returncode == 0, f"Command failed: {args[0]} {args[1] if len(args) > 1 else ''}")
    return result.stdout.strip()


def private_directory(directory):
    directory = Path(directory)
    require(not directory.is_symlink(), "Private directory cannot be a symlink")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "Private directory permissions required")
    return directory


def write_json(filename, value):
    private_directory(filename.parent)
    fd, temp = tempfile.mkstemp(prefix=".update-", dir=filename.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, filename)
        fd = os.open(filename.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def safe_path(name):
    require(isinstance(name, str) and name and "\\" not in name, "Invalid artifact path")
    parts = name.split("/")
    require(not PurePosixPath(name).is_absolute() and
            all(part not in ("", ".", "..") for part in parts) and parts[0] in MANAGED,
            "Artifact path is outside managed code")
    return name


def unpack(archive, destination):
    """Extract regular files only; do not trust tar paths, links or modes."""
    private_directory(destination)
    seen, total = set(), 0
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = member.name
            if name in (".", "./") and member.isdir():
                continue
            if name.startswith("./"):
                name = name[2:]
            name = safe_path(name.rstrip("/") if member.isdir() else name)
            require(name not in seen, "Duplicate artifact entry")
            seen.add(name)
            require(len(seen) <= 50000, "Artifact has too many files")
            target = destination / name
            if member.isdir():
                private_directory(target)
            else:
                require(member.isfile() and not member.issparse(), "Artifact links/special files denied")
                total += member.size
                require(total <= MAX_BYTES, "Artifact is too large")
                private_directory(target.parent)
                with bundle.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o600)


def verify_artifact(directory, commit=None):
    directory = Path(directory)
    require(directory.resolve() == directory.absolute(), "Artifact symlink denied")
    manifest = json.loads((directory / "release.json").read_text())
    rust_only = (set(manifest) == {"format", "version", "runtime", "schema", "files", "digest"}
                 and manifest["format"] == 3 and manifest["runtime"] == "rust"
                 and manifest["schema"] == 3)
    require(rust_only, "Unsupported artifact format/schema")
    require(re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", manifest["version"]),
            "Invalid artifact version")
    payload = {key: value for key, value in manifest.items() if key != "digest"}
    digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    require(digest == manifest["digest"], "Artifact manifest changed")
    files = {}
    for entry in manifest["files"]:
        require(set(entry) == {"path", "sha256", "size"}, "Invalid inventory entry")
        name = safe_path(entry["path"])
        require(name not in files and name != "release.json", "Duplicate inventory entry")
        files[name] = entry
    actual = set()
    for item in directory.rglob("*"):
        require(not item.is_symlink(), "Artifact symlink denied")
        if item.is_dir():
            safe_path(item.relative_to(directory).as_posix())
            continue
        info = item.stat()
        require(item.is_file() and info.st_nlink == 1, "Artifact special file/hardlink denied")
        name = item.relative_to(directory).as_posix()
        if name == "release.json":
            continue
        actual.add(name)
        require(name in files and info.st_size == files[name]["size"] and
                hashlib.sha256(item.read_bytes()).hexdigest() == files[name]["sha256"],
                "Artifact file verification failed")
    required = {"dashboard/index.html", "tooling/build-info.json", "services/rust/dispatch-backend"}
    require(all(name.startswith("dashboard/") or name in
                ("services/rust/dispatch-backend", "tooling/build-info.json")
                for name in actual), "Rust-only artifact contains retired runtime files")
    require(actual == set(files) and required <= actual,
            "Artifact incomplete or contains extra files")
    metadata = json.loads((directory / "tooling/build-info.json").read_text())
    require(re.fullmatch(r"[a-f0-9]{40}", metadata["commit"]), "Invalid build commit")
    if commit:
        require(metadata["commit"] == commit, "Artifact belongs to another commit")
    return manifest


def github(endpoint):
    return json.loads(command("gh", "api", f"repos/{REPOSITORY}/{endpoint}"))


def install_management(live):
    """Keep the reviewed host updater independent of checkout changes/rollback."""
    target = private_directory(Path(live) / ".runtime/management")
    for name in ("update-dev.py", "runtime_artifact.py"):
        source = Path(__file__).with_name(name)
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
        # Accept the old layout during migration; new installations use dev/.
        self.live = self.root if (self.root / ".git").is_dir() else self.root / "live"
        require(self.live.resolve() == self.live and (self.live / ".git").is_dir(),
                "Dev requires its persistent repository checkout")
        if self.live == self.root:
            # These exclusions survive rollback to commits predating this layout.
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

    def update(self):
        require(not (self.runtime / "rust-reset-receipt.json").exists(),
                "Recover the interrupted Rust fresh-state cutover first")
        self.recover()
        self.clean_checkout()
        self.git("fetch", "origin", "dev")
        commit = self.git("rev-parse", "origin/dev")
        current = self.git("rev-parse", "HEAD")
        if commit == current:
            return
        runs = github(f"actions/workflows/checks.yml/runs?branch=dev&event=push&head_sha={commit}&per_page=20")["workflow_runs"]
        runs = [r for r in runs if r["head_sha"] == commit and r["head_branch"] == "dev"
                and r["event"] == "push" and r["head_repository"]["full_name"] == REPOSITORY]
        if not runs:
            self.status("waiting_for_checks", current)
            return
        run = max(runs, key=lambda r: r["id"])
        if run["status"] != "completed" or run["conclusion"] != "success":
            self.status("checks_failed" if run["status"] == "completed" else "waiting_for_checks", current)
            return
        artifacts = github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
        artifacts = [a for a in artifacts if a["name"] == f"dispatch-dev-{commit}" and not a["expired"]]
        require(len(artifacts) == 1, "Verified Dev artifact unavailable")
        artifact = artifacts[0]
        require(artifact["size_in_bytes"] <= MAX_BYTES, "Download is too large")
        with tempfile.TemporaryDirectory(prefix="update-", dir=self.runtime) as temporary:
            temporary = Path(temporary)
            download = temporary / "artifact.zip"
            with download.open("xb") as output:
                subprocess.run(["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"],
                               stdout=output, stderr=subprocess.PIPE, check=True, timeout=180)
            expected = artifact.get("digest")
            require(expected and expected == "sha256:" + hashlib.sha256(download.read_bytes()).hexdigest(),
                    "GitHub artifact digest mismatch")
            with zipfile.ZipFile(download) as bundle:
                require(bundle.namelist() == ["dispatch-dev.tar.gz"], "Unexpected artifact package")
                require(bundle.getinfo("dispatch-dev.tar.gz").file_size <= MAX_BYTES, "Package is too large")
                with bundle.open("dispatch-dev.tar.gz") as source, (temporary / "build.tar.gz").open("xb") as target:
                    shutil.copyfileobj(source, target)
            candidate = temporary / "candidate"
            unpack(temporary / "build.tar.gz", candidate)
            # Fetch/check again so a superseded build never replaces a newer Dev head.
            self.git("fetch", "origin", "dev")
            if self.git("rev-parse", "origin/dev") != commit:
                self.status("waiting_for_checks", current)
                return
            self.activate(candidate, commit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
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
        manifest = verify_artifact(updater.live / ".build", updater.git("rev-parse", "HEAD"))
        (updater.live / ".build/services/rust/dispatch-backend").chmod(0o700)
        return
    with (updater.platform / "dev-update.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        updater.update()


if __name__ == "__main__":
    main()
