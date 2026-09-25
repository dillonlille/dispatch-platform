#!/usr/bin/env python3
"""Refuse local compiler paths in a binary; never print the matching bytes."""
import os
from pathlib import Path
import re
import sys


def has_build_paths(data, root, env):
    # Match standard Linux login names (up to 32 bytes). Otherwise adjacent
    # literals such as /home + /root + error codes + /usr look like a home path.
    # Exact roots below also cover custom locations and longer directory names.
    if re.search(rb"(?<!/dispatch-build)/(?:home)/[^/\x00\s]{1,32}/|/(?:Users)/[^/\x00\r\n]+/|/(?:root)/|[A-Za-z]:[/\\]+Users[/\\]+", data):
        return True
    home = Path(env.get("HOME") or Path.home())
    paths = [Path(root), home, Path(env.get("CARGO_HOME") or home / ".cargo"),
             Path(env.get("RUSTUP_HOME") or home / ".rustup")]
    return any(str(p).encode() in data for path in paths
               for p in [path.absolute(), path.resolve()] if p != Path(p.anchor))


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Provide at least one built executable")
    root = Path(__file__).resolve().parents[2]
    for name in sys.argv[1:]:
        path = Path(name)
        if path.is_symlink() or not path.is_file():
            raise SystemExit("Build privacy check requires a regular executable")
        if has_build_paths(path.read_bytes(), root, os.environ):
            raise SystemExit("Build privacy check failed: local compiler path found; matching bytes withheld.")
    print(f"Build privacy check passed for {len(sys.argv) - 1} executable(s).")


if __name__ == "__main__":
    main()
