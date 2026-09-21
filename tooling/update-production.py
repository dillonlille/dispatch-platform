#!/usr/bin/env python3
"""Compatibility entry point for installed production units; Rust owns update policy."""
import argparse
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_artifact import host, install_management, verify_artifact, private_directory, command, require, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--verify-management", action="store_true")
    mode.add_argument("--install-management", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.install_management:
        install_management(args.root, "production")
    else:
        operation = ["--verify"] if args.verify else ["--verify-management"] if args.verify_management else []
        host("production", "--root", args.root, *operation)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
