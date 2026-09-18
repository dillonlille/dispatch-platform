#!/usr/bin/env python3
"""Download a fully checked main artifact for testing and immutable publication."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

from runtime_artifact import (MAX_BYTES, REPOSITORY, command, private_directory,
                              require, unpack, verify_artifact, write_json)


def github(endpoint):
    return json.loads(command("gh", "api", f"repos/{REPOSITORY}/{endpoint}"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", args.commit), "Full source commit required")
    require(re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", args.version),
            "Stable release version required")
    comparison = github(f"compare/{args.commit}...main")
    require(comparison["status"] in ("ahead", "identical"), "Source must be merged into main")
    runs = github(f"actions/workflows/checks.yml/runs?branch=main&event=push&head_sha={args.commit}&per_page=30")["workflow_runs"]
    runs = [r for r in runs if r["head_sha"] == args.commit and r["head_branch"] == "main"
            and r["event"] == "push" and r["head_repository"]["full_name"] == REPOSITORY]
    require(runs, "No main validation run found")
    run = max(runs, key=lambda r: r["id"])
    require(run["status"] == "completed" and run["conclusion"] == "success", "Main checks have not passed")
    artifacts = github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
    artifacts = [a for a in artifacts if a["name"] == f"dispatch-main-{args.commit}" and not a["expired"]]
    require(len(artifacts) == 1 and artifacts[0]["size_in_bytes"] <= MAX_BYTES, "Verified main artifact unavailable")
    artifact = artifacts[0]
    output = args.output.absolute()
    require(not output.exists(), "Release output already exists; never overwrite prepared assets")
    private_directory(output)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=output) as temporary:
        temporary = Path(temporary)
        download = temporary / "artifact.zip"
        with download.open("xb") as file:
            subprocess.run(["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"],
                           stdout=file, stderr=subprocess.PIPE, check=True, timeout=180)
        digest = "sha256:" + hashlib.sha256(download.read_bytes()).hexdigest()
        require(artifact.get("digest") == digest, "GitHub artifact digest mismatch")
        archive = output / f"dispatch-platform-{args.version}.tar.gz"
        with zipfile.ZipFile(download) as bundle:
            # Both trusted branches retain the historical inner package name so
            # the already installed Dev updater continues to work unchanged.
            require(bundle.namelist() == ["dispatch-dev.tar.gz"], "Unexpected artifact package")
            require(bundle.getinfo("dispatch-dev.tar.gz").file_size <= MAX_BYTES, "Package is too large")
            with bundle.open("dispatch-dev.tar.gz") as source, archive.open("xb") as target:
                shutil.copyfileobj(source, target)
        candidate = temporary / "candidate"
        unpack(archive, candidate)
        manifest = verify_artifact(candidate, args.commit)
        require(manifest["version"] == args.version, "Compiled artifact has another version")
        shutil.copyfile(candidate / "release.json", output / "release.json")
        write_json(output / "provenance.json", {
            "repository": REPOSITORY, "commit": args.commit, "version": args.version,
            "workflowRun": run["id"], "workflowAttempt": run["run_attempt"],
            "artifactId": artifact["id"], "artifactDigest": digest,
            "runtimeDigest": manifest["digest"],
            "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        })
    names = (archive.name, "release.json", "provenance.json")
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256((output / name).read_bytes()).hexdigest()}  {name}\n" for name in names))
    print(f"Prepared {args.version} from checked main commit {args.commit}: {manifest['digest']}")
    print("Test this exact artifact before creating a draft, verifying uploaded assets and publishing.")


if __name__ == "__main__":
    main()
