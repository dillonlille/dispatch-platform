#!/usr/bin/env python3
"""Install stable GitHub releases without a source checkout or GitHub credentials."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_artifact import (MAX_BYTES, REPOSITORY, STABLE, RuntimeUpdater, private_directory,
                              require, unpack, verify_artifact, write_json)

API = f"https://api.github.com/repos/{REPOSITORY}/"
RELEASES = f"https://github.com/{REPOSITORY}/releases/"
# Anonymous API calls are limited to 60 an hour and unchanged responses still
# count, so frequent timer ticks only read the public redirect between full checks.
FULL_CHECK_SECONDS = 600


def github(endpoint):
    """Anonymous by design: Production holds no GitHub credentials or CLI."""
    request = urllib.request.Request(API + endpoint, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "dispatch-production-updater",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def latest_tag():
    """A hint only: it can skip a completed check, never select or trust a release."""
    request = urllib.request.Request(RELEASES + "latest", method="HEAD",
                                     headers={"User-Agent": "dispatch-production-updater"})
    try:
        urllib.request.build_opener(NoRedirect).open(request, timeout=15).close()
    except urllib.error.HTTPError as response:
        response.close()
        location = response.headers.get("Location") or ""
        if response.code == 302 and location.startswith(RELEASES + "tag/"):
            return location[len(RELEASES + "tag/"):]
    except OSError:
        pass
    return None


def version(value):
    require(isinstance(value, str) and re.fullmatch(STABLE, value), "Stable semantic version required")
    return tuple(map(int, value.split(".")))


def release_version(release):
    require(release.get("draft") is False and release.get("prerelease") is False
            and release.get("published_at"), "Published stable release required")
    tag = release.get("tag_name", "")
    require(tag.startswith("v"), "Version tag required")
    version(tag[1:])
    return tag[1:]


def release_commit(tag):
    obj = github(f"git/ref/tags/{tag}")["object"]
    for _ in range(5):
        if obj["type"] == "commit":
            break
        require(obj["type"] == "tag" and re.fullmatch(r"[a-f0-9]{40}", obj["sha"]), "Invalid tag")
        obj = github(f"git/tags/{obj['sha']}")["object"]
    require(obj["type"] == "commit" and re.fullmatch(r"[a-f0-9]{40}", obj["sha"]), "Invalid tag commit")
    commit = obj["sha"]
    comparison = github(f"compare/{commit}...main")
    require(comparison["status"] in ("ahead", "identical"), "Release is not part of main")
    return commit


def download_asset(release, name, target):
    assets = [a for a in release["assets"] if a["name"] == name and a["state"] == "uploaded"]
    require(len(assets) == 1, "Release asset missing or duplicated")
    asset = assets[0]
    require(0 < asset["size"] <= MAX_BYTES, "Invalid release asset size")
    expected_url = f"https://github.com/{REPOSITORY}/releases/download/{release['tag_name']}/{name}"
    require(asset["browser_download_url"] == expected_url, "Unexpected release asset URL")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest", "")), "GitHub asset digest required")
    request = urllib.request.Request(expected_url, headers={"User-Agent": "dispatch-production-updater"})
    digest, total = hashlib.sha256(), 0
    with urllib.request.urlopen(request, timeout=60) as source, target.open("xb") as output:
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
            require(total <= asset["size"], "Download exceeds declared size")
            digest.update(chunk)
            output.write(chunk)
    require(total == asset["size"] and "sha256:" + digest.hexdigest() == asset["digest"],
            "GitHub asset digest mismatch")


class ProductionUpdater(RuntimeUpdater):
    SERVICE = "dispatch-production.service"
    HEALTH = {"environment": "production", "runtime": "rust"}
    LOCK = "production-update.lock"

    def __init__(self, root):
        self.root = Path(root).absolute()
        require(self.root.name == "public" and self.root.resolve() == self.root,
                "Real public environment directory required")
        private_directory(self.root)
        self.live = self.root / "live"
        require(not self.live.is_symlink(), "Runtime symlink denied")
        self.runtime = private_directory(self.root / ".runtime")
        self.platform = private_directory(self.root / "data/platform")
        self.previous = self.runtime / "previous"
        self.receipt = self.platform / "production-activation.json"
        self.status_file = self.platform / "production-update.json"
        self.check_file = self.platform / "production-release-check.json"
        self.load_config(self.root / "config/updater.json", "Production service required",
                         "Loopback health endpoint required")

    def status(self, state, manifest, **extra):
        write_json(self.status_file, {"status": state, "version": manifest["version"],
                                     "digest": manifest["digest"], **extra,
                                     "updatedAt": datetime.now(timezone.utc).isoformat()})

    def recover(self):
        if not self.receipt.exists():
            return
        receipt = json.loads(self.receipt.read_text())
        require(re.fullmatch(r"[a-f0-9]{64}", receipt["oldDigest"]), "Invalid activation receipt")

        def previous_runtime(runtime):
            old = verify_artifact(runtime)
            require(old["digest"] == receipt["oldDigest"],
                    "Rollback inventory differs" if runtime == self.previous else "Previous runtime unavailable")
            return old

        old = self.roll_back(self.live, previous_runtime, receipt["oldDigest"], "Unsafe runtime path",
                             "Previous Production runtime failed health check",
                             restored=lambda _old: (self.live / "services/rust/dispatch-backend").chmod(0o700))
        self.status("rolled_back", old, failedDigest=receipt["newDigest"])
        self.receipt.unlink()

    def activate(self, candidate, commit):
        manifest = verify_artifact(candidate, commit)
        old = verify_artifact(self.live)
        require(version(manifest["version"]) > version(old["version"]), "Release downgrade/replacement denied")
        require(manifest["schema"] == old["schema"], "Schema change requires an explicit migration plan")
        (candidate / "services/rust/dispatch-backend").chmod(0o700)
        self.switch(candidate, self.live, {"oldDigest": old["digest"], "newDigest": manifest["digest"]},
                    manifest["digest"], "New Production runtime failed health check",
                    ready=lambda: self.status("ready", manifest, commit=commit))

    def settled(self, current):
        """Whether a recent full check already finished for the release GitHub still reports."""
        try:
            check = json.loads(self.check_file.read_text())
            age = time.time() - check["checkedAt"]
            return (0 <= age < FULL_CHECK_SECONDS and check["digest"] == current["digest"]
                    and isinstance(check["tag"], str) and latest_tag() == check["tag"])
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def settle(self, release, current):
        write_json(self.check_file, {"tag": release["tag_name"], "digest": current["digest"],
                                    "checkedAt": time.time()})

    def update(self):
        self.recover()
        current = verify_artifact(self.live)
        if self.settled(current):
            return
        release = github("releases/latest")
        selected = release_version(release)
        # Old-format historical releases and intentionally older "latest" markers
        # cannot downgrade a healthy installation.
        if version(selected) < version(current["version"]):
            self.settle(release, current)
            return
        if selected == current["version"]:
            require(self.healthy(current["digest"], timeout=5), "Installed Production runtime is not healthy")
            previous_status = json.loads(self.status_file.read_text()) if self.status_file.exists() else {}
            if previous_status.get("status") != "ready" or previous_status.get("digest") != current["digest"]:
                commit = json.loads((self.live / "tooling/build-info.json").read_text())["commit"]
                self.status("ready", current, commit=commit)
            self.settle(release, current)
            return
        if self.status_file.exists():
            status = json.loads(self.status_file.read_text())
            if status.get("failedReleaseId") == release["id"]:
                self.settle(release, current)
                return
        commit = release_commit(release["tag_name"])
        with tempfile.TemporaryDirectory(prefix="update-", dir=self.runtime) as temporary:
            temporary = Path(temporary)
            archive = temporary / "runtime.tar.gz"
            download_asset(release, f"dispatch-platform-{selected}.tar.gz", archive)
            download_asset(release, "release.json", temporary / "release.json")
            candidate = temporary / "candidate"
            unpack(archive, candidate)
            manifest = verify_artifact(candidate, commit)
            require(manifest["version"] == selected, "Artifact version does not match release")
            require(json.loads((temporary / "release.json").read_text()) == manifest,
                    "Published release inventory differs")
            # Recheck the publication after downloading; a newer release will be
            # selected on the next timer tick instead of installing stale code.
            if github("releases/latest")["id"] != release["id"]:
                return
            try:
                self.activate(candidate, commit)
            except BaseException:
                if not self.receipt.exists():
                    self.status("rolled_back", verify_artifact(self.live),
                                failedReleaseId=release["id"], failedDigest=manifest["digest"])
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    updater = ProductionUpdater(args.root)
    if args.verify:
        manifest = verify_artifact(updater.live)
        version(manifest["version"])
        (updater.live / "services/rust/dispatch-backend").chmod(0o700)
        return
    updater.run_locked()


if __name__ == "__main__":
    main()
