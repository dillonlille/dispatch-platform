#!/usr/bin/env python3
"""Run the isolated Rust BrowserOS proof and remove its synthetic state/reports."""

import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
release = json.loads((root / "tooling/browseros-release.json").read_text())
browser = f"/opt/dispatch-browseros/{release['version']}/browseros"
sandbox = os.environ.get("DISPATCH_BWRAP_EXECUTABLE", "/usr/local/libexec/dispatch-dev/bwrap")
with tempfile.TemporaryDirectory(prefix="dispatch-browseros-check-") as directory:
    subprocess.run([
        "cargo", "test", "--locked", "--example", "browseros_probe",
    ], cwd=root, check=True)
    subprocess.run([
        "cargo", "run", "--locked", "--example", "browseros_probe", "--",
        browser, sandbox, str(Path(directory) / "report"),
    ], cwd=root, check=True)
