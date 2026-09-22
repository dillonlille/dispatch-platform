#!/usr/bin/env python3
"""Compatibility launcher for Rust dev initialization."""
import os
import sys
from runtime_artifact import host_binary


def main(argv=None):
    binary = str(host_binary())
    os.execv(binary, [binary, "host", "setup", "dev", *(sys.argv[1:] if argv is None else argv)])


if __name__ == "__main__":
    main()
