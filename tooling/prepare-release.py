#!/usr/bin/env python3
"""Download a fully checked main artifact for testing and immutable publication."""

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_artifact import (REPOSITORY, STABLE, download_run_artifact, github, latest_run, passed,
                              private_directory, require, write_json)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", args.commit), "Full source commit required")
    require(re.fullmatch(STABLE, args.version), "Stable release version required")
    comparison = github(f"compare/{args.commit}...main")
    require(comparison["status"] in ("ahead", "identical"), "Source must be merged into main")
    runs = github(f"actions/workflows/checks.yml/runs?branch=main&event=push&head_sha={args.commit}&per_page=30")["workflow_runs"]
    run = latest_run(runs, args.commit, "push", "main")
    require(run, "No main validation run found")
    require(passed(run), "Main checks have not passed")
    artifacts = github(f"actions/runs/{run['id']}/artifacts")["artifacts"]
    artifacts = [a for a in artifacts if a["name"] == f"dispatch-main-{args.commit}" and not a["expired"]]
    require(len(artifacts) == 1, "Verified main artifact unavailable")
    artifact = artifacts[0]
    output = args.output.absolute()
    require(not output.exists(), "Release output already exists; never overwrite prepared assets")
    private_directory(output)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=output) as temporary:
        archive = output / f"dispatch-platform-{args.version}.tar.gz"
        candidate, manifest = download_run_artifact(artifact, temporary, args.commit, package=archive)
        require(manifest["version"] == args.version, "Compiled artifact has another version")
        shutil.copyfile(candidate / "release.json", output / "release.json")
        write_json(output / "provenance.json", {
            "repository": REPOSITORY, "commit": args.commit, "version": args.version,
            "workflowRun": run["id"], "workflowAttempt": run["run_attempt"],
            "artifactId": artifact["id"], "artifactDigest": artifact["digest"],
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
