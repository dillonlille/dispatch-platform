#!/usr/bin/env python3
"""Compatibility entry point for Rust release orchestration."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_artifact import host_binary


def main(args=None):
    binary = str(host_binary())
    # Inherit progress output and signals; releases can outlive an ordinary
    # artifact adapter's subprocess timeout. Rust owns argument validation.
    os.execv(binary, [binary, "host", "release", *(sys.argv[1:] if args is None else args),
                      "--root", str(Path(__file__).resolve().parents[1])])


if __name__ == "__main__":
    main()
