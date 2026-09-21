"""Source-checkout bootstrap for the small Rust CI planner and gate."""
import json
import os
from pathlib import Path
import subprocess
import sys


def launch(*args):
    root = Path(__file__).resolve().parent.parent
    subprocess.check_call(["cargo", "build", "--locked", "-p", "dispatch-ci"], cwd=root, stdout=sys.stderr)
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--no-deps", "--format-version=1"], cwd=root))
    binary = Path(metadata["target_directory"]) / "debug/dispatch-ci"
    os.execv(binary, [str(binary), *args, "--root", str(root)])
