#!/usr/bin/env python3
"""Explicit first setup of the independent Dev platform. Creates no Production state."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlparse

spec = importlib.util.spec_from_file_location("update_dev", Path(__file__).with_name("update-dev.py"))
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--owner-email", required=True)
    parser.add_argument("--first-name", required=True)
    parser.add_argument("--last-name", required=True)
    parser.add_argument("--provider", choices=["native", "fixture"], default="native")
    parser.add_argument("--sandbox-executable", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.absolute()
    updates.require(root.name == "dev" and root.resolve() == root, "Real Dev root required")
    origin = urlparse(args.origin)
    updates.require(origin.scheme == "https" and origin.hostname and not origin.username
                    and not origin.password and not origin.query and not origin.fragment
                    and origin.path == "", "Canonical HTTPS origin required")
    for value in [args.origin, args.owner_email, args.first_name, args.last_name]:
        updates.require("\n" not in value and "\r" not in value, "Single-line setup values required")
    updates.require("@" in args.owner_email and 0 < len(args.first_name.strip()) <= 100
                    and 0 < len(args.last_name.strip()) <= 100, "Owner first and last names required")
    for directory in [root, root / "config", root / "data", root / "data/platform", root / "dsps"]:
        updates.private_directory(directory)
    live = root
    updates.require(live.resolve() == live and (live / ".git").is_dir(), "Persistent Dev checkout required")
    updates.require(updates.command("git", "branch", "--show-current", cwd=live) == "dev",
                    "Setup requires the dev branch")
    updates.require(not updates.command("git", "status", "--porcelain", cwd=live), "Clean checkout required")
    updates.command("git", "fetch", "origin", "dev", cwd=live)
    commit = updates.command("git", "rev-parse", "HEAD", cwd=live)
    updates.require(commit == updates.command("git", "rev-parse", "origin/dev", cwd=live),
                    "Setup requires merged dev HEAD")
    manifest = updates.verify_artifact(live / ".build", commit)
    updates.require(manifest["format"] == 3, "Rust core artifact required")
    accounts = root / "data/platform/accounts.sqlite"
    updates.require(not accounts.exists() and not (root / "config/platform.env").exists(),
                    "Dev already configured; preserve existing accounts and configuration")
    env = {
        "NODE_ENV": "production",
        "DISPATCH_STANDALONE": "1",
        "DISPATCH_ENVIRONMENT": "preview",
        "DISPATCH_TRUSTED_PROXY": "cloudflare",
        "DISPATCH_STATE_ROOT": str(root),
        "DISPATCH_ORIGIN": args.origin,
        "DISPATCH_PROVIDER_MODE": args.provider,
        "PORT": "5180",
    }
    if args.sandbox_executable:
        executable = args.sandbox_executable.resolve()
        info = executable.stat()
        updates.require(executable.is_file() and info.st_uid == 0 and info.st_mode & 0o022 == 0,
                        "Root-owned sandbox executable required")
        env["DISPATCH_BWRAP_EXECUTABLE"] = str(executable)
    password = secrets.token_urlsafe(30)
    binary = live / ".build/services/rust/dispatch-backend"
    binary.chmod(0o700)
    subprocess.run([str(binary), "bootstrap",
                    args.owner_email, args.first_name, args.last_name],
                   input=password + "\n", text=True, check=True,
                   env={**os.environ, **env}, cwd=live / ".build")
    # systemd EnvironmentFile is not a shell; JSON quoting handles spaces/backslashes.
    filename = root / "config/platform.env"
    with filename.open("x") as output:
        for key, value in env.items():
            output.write(f"{key}={json.dumps(value)}\n")
    filename.chmod(0o600)
    updates.write_json(root / "config/initial-owner.json",
                       {"email": args.owner_email, "password": password, "url": args.origin})
    updates.write_json(root / "config/updater.json",
                       {"service": "dispatch-dev.service", "healthUrl": "http://127.0.0.1:5180/api/health"})
    updates.DevUpdater(root).status("ready", commit)
    updates.install_management(live)
    print(f"Dev initialized. Initial login is private in {root / 'config/initial-owner.json'}")
    print("Install the reviewed tooling/systemd units separately to start Dev and its updater.")


if __name__ == "__main__":
    main()
