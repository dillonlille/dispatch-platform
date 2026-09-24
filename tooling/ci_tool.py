"""Source-checkout bootstrap for the small Rust CI planner and gate."""
import json
import os
from pathlib import Path
import subprocess
import sys


def prebuilt(root, name):
    """A tool the tools job of this ref or of main built from identical inputs, restored here.

    Only the workspace's own `.ci-tools` directory is trusted, and only on CI; anywhere else
    the tools are built from the checkout.
    """
    tools = os.environ.get("DISPATCH_CI_TOOLS")
    if os.environ.get("CI") != "true" or not tools or Path(tools) != Path(root) / ".ci-tools":
        return None
    binary = Path(root) / ".ci-tools/tools" / name
    if binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK):
        return None
    return binary


def launch(*args):
    root = Path(__file__).resolve().parent.parent
    binary = prebuilt(root, "dispatch-ci")
    if binary is None:
        subprocess.check_call(["cargo", "build", "--locked", "-p", "dispatch-ci"], cwd=root, stdout=sys.stderr)
        metadata = json.loads(subprocess.check_output(
            ["cargo", "metadata", "--locked", "--no-deps", "--format-version=1"], cwd=root))
        binary = Path(metadata["target_directory"]) / "debug/dispatch-ci"
    os.execv(binary, [str(binary), *args, "--root", str(root)])
