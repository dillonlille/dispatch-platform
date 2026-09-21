#!/usr/bin/env python3
"""Promote a gated PR build only when the merged source and validation match exactly."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_artifact as runtime


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


ci = module("ci_plan", "ci-plan.py")
rust = module("cargo_build", "cargo-build.py")


class ValidationChanged(RuntimeError):
    """A previously green PR no longer authorizes skipping its checks."""


def base_ref():
    return ci.TRUSTED.get(os.environ.get("GITHUB_REF", ""))


def require_validation(context):
    if not context or context["commit"] != os.environ.get("GITHUB_SHA"):
        raise ValidationChanged("Actual merged commit required")
    try:
        verified = ci.validated_receipt(context, base_ref() or "dev")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile,
            subprocess.SubprocessError) as error:
        raise ValidationChanged("Cannot confirm PR validation; rerun the workflow") from error
    if not verified:
        raise ValidationChanged("PR validation changed; rerun the workflow for a fresh validation plan")
    return verified


def retarget(candidate, old_commit, new_commit):
    """Only commit metadata changes; preserve every tested application byte."""
    runtime.host("artifact", "retarget", candidate, old_commit, new_commit)
    (candidate / "services/rust/dispatch-backend").chmod(0o700)


def warm_rust_cache(candidate, receipt):
    # The PR records its actual compiler/input key. Only seed the trusted branch
    # cache when this runner computes the same key; never relabel a binary.
    root = Path(__file__).resolve().parent.parent
    if not receipt.get("rustKey") or not rust.cache_eligible(root, os.environ, allow_ci=True):
        return
    key = rust.cache_key(root, "release", os.environ)
    if key != receipt["rustKey"]:
        return
    entry = root / ".ci-rust-cache" / key
    entry.mkdir(parents=True, exist_ok=True)
    binary = entry / "dispatch-backend"
    rust.copy_binary(candidate / "services/rust/dispatch-backend", binary)
    (entry / "sha256").write_text(hashlib.sha256(binary.read_bytes()).hexdigest() + "\n")


def restore(destination):
    runtime.require(os.environ.get("GITHUB_EVENT_NAME") == "push" and base_ref(),
                    "Dev or main push required")
    context = ci.merge_context()
    verified = require_validation(context)
    run, receipt = verified
    artifacts = ci.github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
    name = f"dispatch-pr-build-{run['id']}-{run.get('run_attempt', 1)}"
    matches = [a for a in artifacts if a["name"] == name and not a["expired"]]
    runtime.require(len(matches) == 1, "Gated PR build unavailable")
    runtime.require(not destination.exists() and not destination.is_symlink(), "Build destination already exists")
    with tempfile.TemporaryDirectory(prefix="dispatch-pr-build-", dir=destination.parent) as temp:
        candidate, _manifest = runtime.download_run_artifact(matches[0], temp, receipt["commit"])
        retarget(candidate, receipt["commit"], context["commit"])
        # Do not revive validation if a new run/rerun failed or became pending while downloading.
        if require_validation(context) != verified:
            raise ValidationChanged("PR validation changed during download; rerun the workflow")
        warm_rust_cache(candidate, receipt)
        candidate.rename(destination)
    print(f"Reused tested PR build from run {run['id']} for {context['commit']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".build"))
    args = parser.parse_args()
    try:
        restore(args.output.absolute())
        reused = True
    except ValidationChanged:
        raise
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, EOFError, tarfile.TarError,
            zipfile.BadZipFile, subprocess.SubprocessError) as error:
        require_validation(ci.merge_context())
        print(f"PR build reuse unavailable ({type(error).__name__}); building normally.")
        reused = False
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"reused={str(reused).lower()}\n")


if __name__ == "__main__":
    main()
