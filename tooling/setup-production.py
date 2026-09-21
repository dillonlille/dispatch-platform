#!/usr/bin/env python3
"""Initialize a fresh Production environment from a verified release artifact."""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlparse

from runtime_artifact import install_management, private_directory, require, unpack, verify_artifact, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--owner-email", required=True)
    parser.add_argument("--first-name", required=True)
    parser.add_argument("--last-name", required=True)
    parser.add_argument("--sandbox-executable", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.absolute()
    require(root.name == "public" and root.resolve() == root, "Real Production root required")
    origin = urlparse(args.origin)
    require(origin.scheme == "https" and origin.hostname and not origin.username
            and not origin.password and not origin.query and not origin.fragment
            and not origin.path, "Canonical HTTPS origin required")
    for value in (args.origin, args.owner_email, args.first_name, args.last_name):
        require(value.strip() and "\n" not in value and "\r" not in value, "Single-line setup values required")
    for directory in (root, root / "config", root / "data", root / "data/platform", root / "dsps"):
        private_directory(directory)
    require(not (root / "live").exists() and not (root / "config/platform.env").exists()
            and not (root / "data/platform/accounts.sqlite").exists(),
            "Production already initialized; preserve its runtime and private state")
    sandbox = args.sandbox_executable.absolute()
    info = sandbox.stat()
    require(sandbox.resolve() == sandbox and sandbox.is_file()
            and info.st_uid == 0 and info.st_mode & 0o022 == 0, "Root-owned sandbox required")
    live = root / "live"
    unpack(args.artifact, live)
    manifest = verify_artifact(live, args.commit)
    require(manifest["version"] == args.version, "Release version differs")
    env = {
        "NODE_ENV": "production", "DISPATCH_STANDALONE": "1",
        "DISPATCH_ENVIRONMENT": "production", "DISPATCH_TRUSTED_PROXY": "cloudflare",
        "DISPATCH_STATE_ROOT": str(root), "DISPATCH_ORIGIN": args.origin,
        "DISPATCH_PROVIDER_MODE": "native", "PORT": "5180",
        "DISPATCH_BWRAP_EXECUTABLE": str(sandbox),
    }
    binary = live / "services/rust/dispatch-backend"
    binary.chmod(0o700)
    password = secrets.token_urlsafe(30)
    subprocess.run([str(binary), "bootstrap", args.owner_email, args.first_name, args.last_name],
                   input=password + "\n", text=True, check=True,
                   env={**os.environ, **env}, cwd=live)
    with (root / "config/platform.env").open("x") as output:
        for key, value in env.items():
            output.write(f"{key}={json.dumps(value)}\n")
    write_json(root / "config/initial-owner.json",
               {"email": args.owner_email, "password": password, "url": args.origin})
    write_json(root / "config/updater.json", {
        "service": "dispatch-production.service", "healthUrl": "http://127.0.0.1:5180/api/health"})
    install_management(root, "production")
    print("Production initialized with separate accounts and state; services have not been started.")
    print(f"Initial login is private in {root / 'config/initial-owner.json'}")


if __name__ == "__main__":
    main()
