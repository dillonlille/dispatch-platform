#!/usr/bin/env python3
"""Compatibility entry point for Rust job and artifact gates."""
import argparse
import os
from ci_tool import launch
from runtime_artifact import host_binary

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact")
    args = parser.parse_args(argv)
    if args.artifact:
        binary = str(host_binary())
        os.execv(binary, [binary, "host", "ci", "verify", args.artifact])
    else:
        launch("gate")


if __name__ == "__main__":
    main()
