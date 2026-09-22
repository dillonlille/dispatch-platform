#!/usr/bin/env python3
"""Compatibility entry point for Rust CI planning and validation receipts."""
import sys
from ci_tool import launch

def main(argv=None):
    launch(*(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    main()
