#!/usr/bin/env python3
"""Compatibility launcher for Rust build caching and compiler fingerprints."""
import sys
from ci_tool import launch


def main(argv=None):
    launch("build", *(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    main()
