"""Shared GitHub access, runtime inventory verification, safe extraction and the
service lifecycle of the host updaters.

Installed beside the host updaters, so it imports only the standard library.
"""

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
# Top-level names an artifact may contain; tooling/artifact.ts builds from the same list.
MANAGED = {"dashboard", "services", "tooling", "release.json"}
MAX_BYTES = 1024 * 1024 * 1024
STABLE = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
# Both trusted branches retain the historical package name so an already
# installed Dev updater continues to work unchanged.
PACKAGE = "dispatch-dev.tar.gz"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def command(*args, cwd=None, timeout=120, binary=False):
    result = subprocess.run(args, cwd=cwd, text=not binary, capture_output=True, timeout=timeout)
    if result.returncode:
        problem = result.stderr if isinstance(result.stderr, str) else result.stderr.decode(errors="replace")
        raise RuntimeError(f"{' '.join(args[:3])} failed: {problem.strip()[-600:]}")
    return result.stdout if binary else result.stdout.strip()


def github(endpoint, *args, binary=False, timeout=120):
    """Authenticated repository API through the GitHub CLI."""
    data = command("gh", "api", f"repos/{REPOSITORY}/{endpoint}", *args, binary=binary, timeout=timeout)
    return data if binary else json.loads(data)


def latest_run(runs, sha, event, branch=None, skipped=False):
    """The newest run of this repository for the commit, whatever its outcome.

    A newer failed or pending rerun always replaces an older success. A skipped run
    checked nothing, so it neither passes nor fails the commit; callers that must
    not look past one (a PR returned to draft) count it with skipped=True.
    """
    runs = [r for r in runs if r.get("head_sha") == sha and r.get("event") == event
            and (skipped or r.get("conclusion") != "skipped")
            and (branch is None or r.get("head_branch") == branch)
            and (r.get("head_repository") or {}).get("full_name") == REPOSITORY]
    return max(runs, key=lambda r: (r["id"], r.get("run_attempt", 1)), default=None)


def passed(run):
    return bool(run) and run.get("status") == "completed" and run.get("conclusion") == "success"


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


def download_run_artifact(artifact, directory, commit, package=None):
    """Fetch one Actions artifact and return its verified, unpacked runtime.

    GitHub's recorded size and digest must describe the downloaded bytes. The inner
    package is kept at `package` when given. Returns the candidate directory inside
    the caller's private temporary `directory` and its manifest.
    """
    directory = Path(directory)
    require(0 < artifact["size_in_bytes"] <= MAX_BYTES, "Invalid artifact size")
    download = directory / "artifact.zip"
    with download.open("xb") as output:
        subprocess.run(["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"],
                       stdout=output, stderr=subprocess.PIPE, check=True, timeout=180)
    require(download.stat().st_size == artifact["size_in_bytes"] and
            artifact.get("digest") == "sha256:" + hashlib.sha256(download.read_bytes()).hexdigest(),
            "GitHub artifact digest mismatch")
    package = Path(package) if package else directory / "build.tar.gz"
    with zipfile.ZipFile(download) as bundle:
        require(bundle.namelist() == [PACKAGE], "Unexpected artifact package")
        require(bundle.getinfo(PACKAGE).file_size <= MAX_BYTES, "Package is too large")
        with bundle.open(PACKAGE) as source, package.open("xb") as target:
            shutil.copyfileobj(source, target)
    candidate = directory / "candidate"
    unpack(package, candidate)
    return candidate, verify_artifact(candidate, commit)


class RuntimeUpdater:
    """Stopping, switching, starting and rolling back one environment's service.

    A subclass names its systemd user unit, what its health endpoint must report and its
    lock file, and sets `platform`, `previous`, `receipt` and `config`. What may be
    installed, and everything about where it comes from, stays with each updater.
    """

    SERVICE = None
    # What /api/health must report beside the expected release digest.
    HEALTH = {}
    LOCK = None

    def load_config(self, filename, service_message, health_message):
        self.config = json.loads(Path(filename).read_text())
        require(self.config["service"] == self.SERVICE, service_message)
        require(re.fullmatch(r"http://127\.0\.0\.1:\d+/api/health", self.config["healthUrl"]),
                health_message)

    def service(self, action):
        command("systemctl", "--user", action, self.config["service"], timeout=90)

    def healthy(self, digest, timeout=40):
        expected = {"status": "ready", **self.HEALTH, "release": digest}
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(self.config["healthUrl"], timeout=2) as response:
                    data = json.load(response)
                if all(data.get(key) == value for key, value in expected.items()):
                    return True
            except (OSError, ValueError):
                pass
            time.sleep(1)
        return False

    def switch(self, candidate, active, record, digest, failure, stopped=None, switched=None, ready=None):
        """Replace `active` with `candidate`, keeping the old runtime until the new one is healthy.

        `record` is written as the activation receipt before anything changes, so an
        interrupted switch is rolled back by `recover` on the next run. `stopped` runs
        once the service is down, `switched` once the runtimes are exchanged and `ready`
        once the new one answers; any failure, in them too, recovers and is raised again.
        """
        if self.previous.exists():
            require(self.previous.resolve() == self.previous and not self.previous.is_symlink(),
                    "Unsafe rollback path")
            shutil.rmtree(self.previous)
        write_json(self.receipt, record)
        try:
            self.service("stop")
            if stopped:
                stopped()
            active.rename(self.previous)
            candidate.rename(active)
            if switched:
                switched()
            self.service("start")
            require(self.healthy(digest), failure)
            if ready:
                ready()
            self.receipt.unlink()
        except BaseException:
            self.recover()
            raise

    def roll_back(self, active, verify, digest, unsafe, failure, restored=None):
        """Stop, put the retained runtime back and start it; the caller then clears the receipt.

        `verify(path)` raises unless `path` holds the runtime the receipt names. It sees
        the retained copy, or `active` when the interruption came before the exchange.
        `restored` runs with its result before the service starts.
        """
        self.service("stop")
        if self.previous.exists():
            old = verify(self.previous)
            if active.exists():
                require(active.resolve() == active and not active.is_symlink(), unsafe)
                shutil.rmtree(active)
            self.previous.rename(active)
        else:
            old = verify(active)
        if restored:
            restored(old)
        self.service("start")
        require(self.healthy(digest), failure)
        return old

    def run_locked(self):
        """One update at a time; a timer tick that finds another one running does nothing."""
        with (self.platform / self.LOCK).open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            self.update()
