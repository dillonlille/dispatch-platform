#!/usr/bin/env python3
"""Fail closed on missing CI jobs and verify the artifact before Dev publication."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile


def validate(needs):
    mode = needs.get("plan", {}).get("outputs", {}).get("mode")
    if mode not in {"full", "dashboard", "reuse"}:
        raise ValueError("Missing or unknown validation plan")
    expected = {"plan": "success", "build": "success",
                "core": "success" if mode == "full" else "skipped",
                "collectors": "success" if mode == "full" else "skipped"}
    for job, result in expected.items():
        if needs.get(job, {}).get("result") != result:
            raise ValueError(f"Required suite {job} did not report {result}")
    return mode


def verify(archive, commit):
    spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("update-dev.py"))
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    with tempfile.TemporaryDirectory(prefix="dispatch-ci-artifact-") as temp:
        root = Path(temp) / "build"
        updater.unpack(archive, root)
        updater.verify_artifact(root, commit)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path)
    args = parser.parse_args()
    if args.artifact:
        verify(args.artifact, os.environ["GITHUB_SHA"])
        print("Merged candidate inventory and source commit verified")
    else:
        print(f"All required {validate(json.loads(os.environ['CI_NEEDS']))} suites passed")
