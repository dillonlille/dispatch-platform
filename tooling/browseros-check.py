#!/usr/bin/env python3
"""Verify the production Rust worker against BrowserOS using temporary DSPs."""

import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
environment = dict(os.environ)
environment.setdefault("DISPATCH_BWRAP_EXECUTABLE", "/usr/local/libexec/dispatch-dev/bwrap")
subprocess.run([
    "cargo", "test", "--locked", "--test", "browseros_host", "--",
    "--ignored", "--nocapture", "--test-threads=1",
], cwd=root, env=environment, check=True)

environment["DISPATCH_TEST_NATIVE"] = "1"
subprocess.run([
    "node", "node_modules/tsx/dist/cli.mjs", "--test", "--test-concurrency=1",
    "tests/paycom-worker.test.ts", "tests/cortex-worker.test.ts", "tests/cortex-meals-worker.test.ts", "tests/native-browser.test.ts", "tests/multi-dsp-browser.test.ts", "tests/collection-throughput.test.ts",
], cwd=root, env=environment, check=True)
