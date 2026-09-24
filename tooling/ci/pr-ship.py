#!/usr/bin/env python3
"""Compatibility launcher for Rust PR shipping: checks, merge queue, merge."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ci_tool import launch


def main(argv=None):
    launch("ship", *(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    main()
