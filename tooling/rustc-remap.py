#!/usr/bin/env python3
"""Give compiler-generated paths stable names without changing runtime file access."""
import os
from pathlib import Path
import sys


def mappings(root, env):
    home = Path(env.get("HOME") or Path.home())
    locations = [
        (home, "/dispatch-build/home"),
        (Path(env.get("CARGO_HOME") or home / ".cargo"), "/dispatch-build/cargo"),
        (Path(env.get("RUSTUP_HOME") or home / ".rustup"), "/dispatch-build/rustup"),
        (Path(root), "/dispatch-build/source"),
    ]
    paths = {}
    for location, replacement in locations:
        # Cover both the spelling Cargo uses and a symlink's physical location.
        for source in [location.absolute(), location.resolve()]:
            if source == Path(source.anchor):
                raise ValueError("Refusing to remap a filesystem root")
            paths[str(source)] = replacement
    # rustc applies the last matching prefix: specific roots must beat the home directory.
    return [f"--remap-path-prefix={source}={paths[source]}"
            for source in sorted(paths, key=lambda value: (len(value), value))]


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Cargo must supply a compiler executable")
    root = Path(__file__).resolve().parents[1]
    compiler, *arguments = sys.argv[1:]
    os.execvp(compiler, [compiler, *arguments, *mappings(root, os.environ)])


if __name__ == "__main__":
    main()
