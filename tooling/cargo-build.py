#!/usr/bin/env python3
"""Reuse verified local backend binaries across worktrees with identical Rust inputs.

CI uses Cargo's normal dependency cache. Local entries live beside Git metadata,
never in a runtime/data directory, and are copied into each checkout's own target.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import tomllib


def output(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def fingerprint(root, profile, compiler, environment):
    digest = hashlib.sha256()
    flags = {key: value for key, value in environment.items()
             if key.startswith(("CARGO_", "RUST", "CC_", "CXX_", "PKG_CONFIG"))
             or key in {"CC", "CXX", "CFLAGS", "CPPFLAGS", "CXXFLAGS", "LDFLAGS", "AR", "RANLIB"}}
    digest.update(json.dumps([2, profile, compiler, platform.system(), platform.machine(), flags], sort_keys=True).encode())
    files = [root / name for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain",
                                      "tooling/cargo-build.py")]
    for directory in (root / "backend", root / ".cargo"):
        files.extend(file for file in directory.rglob("*") if file.is_file())
    # Cargo reads configuration from ancestor directories and CARGO_HOME too.
    for parent in root.parents:
        files.extend(parent / ".cargo" / name for name in ("config", "config.toml"))
    cargo_home = Path(environment.get("CARGO_HOME", str(Path.home() / ".cargo")))
    files.extend(cargo_home / name for name in ("config", "config.toml"))
    for file in sorted(set(files)):
        if file.is_file():
            name = str(file.relative_to(root)) if file.is_relative_to(root) else str(file)
            digest.update(name.encode() + b"\0" + file.read_bytes() + b"\0")
    return digest.hexdigest()


def copy_binary(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".dispatch-backend-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as out, source.open("rb") as inp:
            shutil.copyfileobj(inp, out)
        os.chmod(name, 0o700)
        os.replace(name, destination)
    finally:
        Path(name).unlink(missing_ok=True)


def cached_binary(entry):
    binary = entry / "dispatch-backend"
    try:
        expected = (entry / "sha256").read_text().strip()
        return binary if hashlib.sha256(binary.read_bytes()).hexdigest() == expected else None
    except OSError:
        return None


def cache_eligible(root, environment):
    if (environment.get("CI") or environment.get("DISPATCH_DISABLE_RUST_CACHE")
            or environment.get("CARGO_TARGET_DIR")):
        return False
    # Unbounded external build inputs belong to Cargo, not this small cache.
    if any(key.startswith(("CARGO_SOURCE_", "CARGO_BUILD_")) or key in {
            "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CC", "CXX", "AR", "RANLIB"
    } for key in environment):
        return False
    cargo_home = Path(environment.get("CARGO_HOME", str(Path.home() / ".cargo")))
    configs = [parent / ".cargo" / name for parent in [root, *root.parents]
               for name in ("config", "config.toml")]
    configs.extend(cargo_home / name for name in ("config", "config.toml"))
    if any(file.exists() for file in configs):
        return False
    workspace = tomllib.loads((root / "Cargo.toml").read_text())
    if workspace.get("workspace", {}).get("members") != ["backend"]:
        return False
    for file in (root / "backend").rglob("*"):
        if file.is_symlink() or file.name == "build.rs":
            return False
    for manifest in [root / "Cargo.toml", root / "backend/Cargo.toml"]:
        data = tomllib.loads(manifest.read_text())
        if data.get("package", {}).get("build"):
            return False
        def external(value):
            if isinstance(value, dict):
                return any((key == "path" and isinstance(item, str)
                            and not (manifest.parent / item).resolve().is_relative_to(root / "backend"))
                           or external(item) for key, item in value.items())
            return isinstance(value, list) and any(external(item) for item in value)
        if external(data):
            return False
    return True


def build(release=False):
    root = Path(__file__).resolve().parent.parent
    profile = "release" if release else "debug"
    args = ["cargo", "build", "--locked", *(["--release"] if release else [])]
    # Custom output roots and build scripts can have extra inputs. Let Cargo
    # handle them, and never use a local binary cache in CI or on request.
    if not cache_eligible(root, os.environ):
        subprocess.run(args, cwd=root, check=True)
        return
    compiler = output("rustc", "-vV", cwd=root) + "\n" + output("cc", "--version", cwd=root)
    key = fingerprint(root, profile, compiler, os.environ)
    common = Path(output("git", "rev-parse", "--path-format=absolute", "--git-common-dir", cwd=root))
    cache = common / "dispatch-rust-builds"
    cache.mkdir(mode=0o700, exist_ok=True)
    entry = cache / key
    target = root / "target" / profile / "dispatch-backend"
    with (cache / (key + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        binary = cached_binary(entry)
        if binary:
            copy_binary(binary, target)
            print(f"Reused local {profile} backend for identical Rust inputs.", flush=True)
            return
        subprocess.run(args, cwd=root, check=True)
        if fingerprint(root, profile, compiler, os.environ) != key:
            raise RuntimeError("Rust inputs changed during the build; run it again before packaging")
        entry.mkdir(mode=0o700, exist_ok=True)
        copy_binary(target, entry / "dispatch-backend")
        (entry / "sha256").write_text(hashlib.sha256(target.read_bytes()).hexdigest() + "\n")
        print(f"Cached local {profile} backend for other worktrees.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true")
    build(parser.parse_args().release)
