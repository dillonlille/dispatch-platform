#!/usr/bin/env python3
"""Isolated native suites; the capacity shard gets its own otherwise idle runner."""

import argparse
import json
import os
from pathlib import Path
import subprocess

# The one list of native suites, shared with the check that no test file is left out.
SHARDS = json.loads((Path(__file__).resolve().parent / "test-plan.json").read_text())["native"]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", choices=["all", *SHARDS], default="all")
    parser.add_argument("--host-only", action="store_true")
    args = parser.parse_args()
    shard = args.shard
    root = Path(__file__).resolve().parent.parent
    environment = dict(os.environ)
    environment.setdefault("DISPATCH_BWRAP_EXECUTABLE", "/usr/local/libexec/dispatch-dev/bwrap")
    subprocess.run(["python3", "tooling/cargo-build.py"], cwd=root, env=environment, check=True)
    if args.host_only or shard in ("all", "capacity"):
        subprocess.run([
            "cargo", "test", "--locked", "--test", "browseros_host", "--",
            "--ignored", "--nocapture", "--test-threads=1",
        ], cwd=root, env=environment, check=True)
    if args.host_only:
        return
    environment["DISPATCH_TEST_NATIVE"] = "1"
    files = [file for group in SHARDS.values() for file in group] if shard == "all" else SHARDS[shard]
    subprocess.run([
        "node", "node_modules/tsx/dist/cli.mjs", "--test", "--test-concurrency=1", *files,
    ], cwd=root, env=environment, check=True)


if __name__ == "__main__":
    main()
