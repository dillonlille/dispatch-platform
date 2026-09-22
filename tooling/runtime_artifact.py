"""CI/release adapters and the one-time Python-to-Rust host handoff.

Artifact policy and updater state machines live in backend/host. The bootstrap
verifier is retained only for already-installed Python units to install their
first trusted Rust management copy after a successful legacy activation.
"""
import functools
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile

REPOSITORY = "dillonlille/dispatch-platform"
MANAGED = {"dashboard", "services", "tooling", "release.json"}
MAX_BYTES = 1024 * 1024 * 1024
STABLE = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
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


def _bootstrap_verify(directory, commit=None):
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


@functools.cache
def host_binary():
    tooling = Path(__file__).resolve().parent
    root = tooling.parent
    if (root / "backend/host/Cargo.toml").is_file():
        # Build from this checkout, never search the candidate being verified.
        subprocess.check_call(["cargo", "build", "--locked", "--release", "-p", "dispatch-host"], cwd=root,
                              stdout=sys.stderr)
        metadata = json.loads(command("cargo", "metadata", "--locked", "--no-deps", "--format-version=1", cwd=root))
        return Path(metadata["target_directory"]) / "release/dispatch-host"
    require(tooling.name == "management", "Run host tooling from a checkout or installed management directory")
    binary = tooling / "dispatch-host"
    if not binary.exists():
        environment = "dev" if root.name == ".runtime" else "production"
        live = root.parent if environment == "dev" else root
        require(live.name == ("dev" if environment == "dev" else "public"), "Invalid environment root")
        active = live / (".build" if environment == "dev" else "live")
        receipt = json.loads((live / f"data/platform/{environment}-update.json").read_text())
        require(receipt.get("status") == "ready", "Rust handoff requires a healthy completed activation")
        manifest = _bootstrap_verify(active, receipt.get("commit"))
        require(manifest["digest"] == receipt.get("digest"), "Handoff runtime differs from activation receipt")
        metadata = json.loads((active / "tooling/build-info.json").read_text())
        require(metadata.get("hostManagement") == 1, "Active runtime has no Rust host management")
        if environment == "dev":
            require(command("git", "branch", "--show-current", cwd=live) == "dev"
                    and not command("git", "status", "--porcelain", "--untracked-files=all", cwd=live),
                    "Clean Dev checkout required for handoff")
            require(command("git", "rev-parse", "HEAD", cwd=live) == metadata["commit"], "Handoff source differs")
        private_directory(tooling)
        fd, staged = tempfile.mkstemp(prefix=".host-", dir=tooling)
        try:
            with os.fdopen(fd, "wb") as out, (active / "services/rust/dispatch-backend").open("rb") as source:
                shutil.copyfileobj(source, out)
                out.flush()
                os.fsync(out.fileno())
            require(hashlib.sha256(Path(staged).read_bytes()).hexdigest() == next(
                entry["sha256"] for entry in manifest["files"] if entry["path"] == "services/rust/dispatch-backend"),
                "Host management copy changed")
            os.chmod(staged, 0o700)
            require(json.loads(command(staged, "host", "capabilities"))["hostManagement"] == 1,
                    "Host updater does not start")
            os.replace(staged, binary)
            fd = os.open(tooling, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            Path(staged).unlink(missing_ok=True)
    info = binary.lstat()
    require(binary.is_file() and not binary.is_symlink() and info.st_nlink == 1
            and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "Private installed host executable required")
    return binary


def host(*args, value=None):
    process = subprocess.Popen([str(host_binary()), "host", *map(str, args)],
                               stdin=subprocess.PIPE if value is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, stderr = process.communicate(None if value is None else json.dumps(value), timeout=600)
    except BaseException:
        process.kill()
        process.wait()
        raise
    require(process.returncode == 0, stderr.strip() or "Host management failed")
    return json.loads(stdout)


def verify_artifact(directory, commit=None):
    return host("artifact", "verify", directory, *([commit] if commit else []))


def unpack(archive, destination):
    return host("artifact", "unpack", archive, destination)


def install_management(live, environment="dev", tooling=None):
    live = Path(live)
    host(environment, "--root", live, "--install-management")
    target = private_directory(live / (".runtime/management" if environment == "dev" else "management"))
    source = Path(tooling) if tooling else Path(__file__).parent
    for name in ("runtime_artifact.py", f"update-{environment}.py"):
        fd, temporary = tempfile.mkstemp(prefix=".install-", dir=target)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write((source / name).read_bytes())
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, target / name)
        finally:
            Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        print(json.dumps(host(*sys.argv[1:])))
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
