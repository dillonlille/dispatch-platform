#!/usr/bin/env python3
"""Isolated native suites; the capacity shard gets its own otherwise idle runner."""

import argparse
import os
from pathlib import Path
import subprocess

SHARDS = {
    "paycom": ["tests/paycom-worker.test.ts", "tests/native-browser.test.ts"],
    "cortex": ["tests/cortex-worker.test.ts", "tests/cortex-meals-worker.test.ts"],
    "capacity": ["tests/multi-dsp-browser.test.ts", "tests/collection-throughput.test.ts"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", choices=["all", *SHARDS], default="all")
    shard = parser.parse_args().shard
    root = Path(__file__).resolve().parent.parent
    environment = dict(os.environ)
    environment.setdefault("DISPATCH_BWRAP_EXECUTABLE", "/usr/local/libexec/dispatch-dev/bwrap")
    subprocess.run(["python3", "tooling/cargo-build.py"], cwd=root, env=environment, check=True)
    if shard in ("all", "capacity"):
        subprocess.run([
            "cargo", "test", "--locked", "--test", "browseros_host", "--",
            "--ignored", "--nocapture", "--test-threads=1",
        ], cwd=root, env=environment, check=True)
    environment["DISPATCH_TEST_NATIVE"] = "1"
    files = [file for group in SHARDS.values() for file in group] if shard == "all" else SHARDS[shard]
    subprocess.run([
        "node", "node_modules/tsx/dist/cli.mjs", "--test", "--test-concurrency=1", *files,
    ], cwd=root, env=environment, check=True)


if __name__ == "__main__":
    main()
