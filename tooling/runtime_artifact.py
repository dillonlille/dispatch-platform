"""Shared runtime inventory verification and safe extraction; no environment mutations."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

REPOSITORY = "dillonlille/dispatch-platform"
MANAGED = {"api", "dashboard", "services", "integrations", "shared", "tooling",
           "node_modules", "package.json", "package-lock.json", "release.json"}
MAX_BYTES = 1024 * 1024 * 1024


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

