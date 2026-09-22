#!/usr/bin/env python3
"""Compatibility entry point for verified Rust CI artifact promotion."""
import argparse
import os
from pathlib import Path
from runtime_artifact import host_binary

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".build")
    args = parser.parse_args(argv)
    binary = str(host_binary())
    os.execv(binary, [binary, "host", "ci", "restore", "--root", str(Path(__file__).resolve().parent.parent),
                      "--output", args.output])


if __name__ == "__main__":
    main()
