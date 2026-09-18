#!/usr/bin/env python3
"""Install the pinned browser alone, without registering desktop apps or services."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.request


RELEASE = json.loads(Path(__file__).with_name("browseros-release.json").read_text())
DESTINATION = Path("/opt/dispatch-browseros") / RELEASE["version"]


def verify(archive):
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != RELEASE["sha256"] or archive.stat().st_size != RELEASE["size"]:
        raise ValueError("BrowserOS archive checksum or size mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded, verified archive")
    args = parser.parse_args()
    if os.geteuid() != 0 or platform.system() != "Linux" or platform.machine() != "x86_64":
        parser.error("Run as root on Linux x86_64")
    parent = DESTINATION.parent
    parent.mkdir(mode=0o755, exist_ok=True)
    for directory in (parent, *parent.parents):
        info = directory.lstat()
        if directory.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError(f"Installation parent {directory} must be root-owned and not writable by others")
    if DESTINATION.exists() or DESTINATION.is_symlink():
        raise ValueError(f"Refusing to overwrite {DESTINATION}")
    with tempfile.TemporaryDirectory(prefix=".install-", dir=parent) as directory:
        stage = Path(directory)
        archive = stage / "browseros.deb"
        if args.archive:
            # Copy before verification so a caller cannot swap the verified source.
            shutil.copyfile(args.archive, archive)
        else:
            with urllib.request.urlopen(RELEASE["url"], timeout=60) as response, archive.open("wb") as output:
                shutil.copyfileobj(response, output)
        verify(archive)
        package = stage / "package"
        subprocess.run(["dpkg-deb", "--extract", str(archive), str(package)], check=True)
        browser = package / "usr/lib/browseros"
        # The browser-control protocol is built into the browser executable.
        # No bundled Bun/AI server, desktop extension, or WebDriver is needed.
        for name in ("BrowserOSServer", "BrowserClawServer", "browseros_extensions", "chromedriver"):
            path = browser / name
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
        documentation = package / "usr/share/doc/browseros"
        if documentation.exists():
            shutil.copytree(documentation, browser / "package-documentation", symlinks=True)
        inventory = []
        for path in sorted(browser.rglob("*")):
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError(f"Unexpected browser package entry: {path.name}")
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
            if path.is_file():
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                inventory.append({"path": str(path.relative_to(browser)), "sha256": digest})
        (browser / "dispatch-install.json").write_text(json.dumps({**RELEASE, "files": inventory}, indent=2) + "\n")
        browser.chmod(0o755)
        browser.rename(DESTINATION)
    print(DESTINATION / "browseros")


if __name__ == "__main__":
    main()
