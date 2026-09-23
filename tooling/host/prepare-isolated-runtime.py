#!/usr/bin/env python3
"""Copy an updater-verified runtime into a root-owned, read-only service snapshot."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


def prepare(source, parent, verify):
    source, parent = Path(source), Path(parent)
    if not source.is_absolute() or not parent.is_absolute() or source == parent:
        raise ValueError("Separate absolute source and snapshot paths required")
    for directory in [source, parent, *source.parents, *parent.parents]:
        if directory.is_symlink():
            raise ValueError("Symlink directories denied")
    info = parent.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("Snapshot directory must be owned by the installer and not writable by others")
    expected = verify(source)["digest"]
    active = parent / "current"
    previous = parent / "previous"
    for path in (active, previous):
        if path.is_symlink():
            raise ValueError("Snapshot symlinks denied")
    staging = Path(tempfile.mkdtemp(prefix=".candidate-", dir=parent))
    try:
        # Retain links rather than following them; the shared artifact verifier rejects them.
        shutil.copytree(source, staging, symlinks=True, dirs_exist_ok=True)
        if verify(staging)["digest"] != expected:
            raise ValueError("Runtime changed during the snapshot")
        for directory, dirs, files in os.walk(staging):
            os.chmod(directory, 0o755)
            for name in files:
                path = Path(directory) / name
                executable = path.relative_to(staging).as_posix() == "services/rust/dispatch-backend"
                os.chmod(path, 0o555 if executable else 0o444)
        if previous.exists():
            shutil.rmtree(previous)
        if active.exists():
            active.rename(previous)
        try:
            staging.rename(active)
        except OSError:
            if previous.exists():
                previous.rename(active)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, default=Path("/opt/dispatch-production"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run from the system service as root")
    verifier = Path("/usr/local/libexec/dispatch-runtime/dispatch-host")
    info = verifier.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit("Root-owned artifact verifier required")
    def verify(path):
        return json.loads(subprocess.check_output([str(verifier), "artifact", "verify", str(path)], timeout=60))
    prepare(args.source, args.destination, verify)


if __name__ == "__main__":
    main()
