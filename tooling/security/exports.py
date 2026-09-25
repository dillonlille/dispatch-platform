#!/usr/bin/env python3
"""Audit local design exports without reading runtime records or printing matched values."""
import argparse
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import tempfile
import zipfile

import scan

AREAS = ("mockups", "outputs", "design")
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp"}
ARCHIVES = scan.ARCHIVES | {".bz2", ".xz", ".zst", ".rar"}
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILES = 2000
MAX_DEPTH = 3


def load_policy(review):
    if review.is_symlink() or not stat.S_ISREG(review.stat().st_mode):
        raise ValueError("Review manifest must be a regular file")
    if review.stat().st_mode & 0o077:
        raise ValueError("Review manifest must be private (mode 0600)")
    local = json.loads(review.read_text())
    assets = local["assets"]
    identities = local.get("identitySha256", [])
    if not isinstance(assets, dict) or not isinstance(identities, list):
        raise ValueError("Invalid review manifest")
    if not all(isinstance(v, str) and re.fullmatch(r"[a-f0-9]{64}", v)
               for v in [*assets.values(), *identities]):
        raise ValueError("Review manifest must contain SHA-256 hashes")
    policy = json.loads((scan.ROOT / "tooling/security/privacy-policy.json").read_text())
    return {"identitySha256": sorted(set(policy["identitySha256"] + identities)),
            "exceptions": [], "assets": {"exports/" + k: v for k, v in assets.items()}}


class ExportAudit:
    def __init__(self, tree, policy, tesseract="tesseract"):
        self.tree, self.policy, self.tesseract = tree, policy, tesseract
        self.findings, self.names = [], {}
        self.total = 0

    def add(self, name, rule, line=1):
        self.findings.append((name, line, rule))

    def text(self, name, data):
        logical = "exports/" + name.replace("!", "/")
        policy = {**self.policy, "assets": {logical: self.policy["assets"].get("exports/" + name)}}
        for _, line, rule in scan.inspect_file(logical, data, policy):
            if rule != "archive-needs-private-storage":
                self.add(name, rule, line)

    def image(self, name, path):
        try:
            result = subprocess.run([self.tesseract, str(path), "stdout", "--psm", "11"],
                                    capture_output=True, timeout=60,
                                    env={**os.environ, "OMP_THREAD_LIMIT": "1"})
            if result.returncode:
                raise ValueError("OCR failed")
            # OCR text is scanned in memory and never written into a report or snapshot.
            text = " ".join(result.stdout.decode("utf-8", errors="strict").split())
            for _, line, rule in scan.inspect_file("ocr.txt", text.encode(), self.policy):
                self.add(name, "ocr:" + rule, line)
        except (OSError, ValueError, subprocess.SubprocessError):
            self.add(name, "ocr-failed")

    def member(self, parent, name, data, depth):
        path = PurePosixPath(name)
        if not name or path.is_absolute() or ".." in path.parts or "\\" in name or "!" in name:
            self.add(parent, "unsafe-archive-member")
            return
        self.content(parent + "!" + name, data, depth + 1)

    def archive(self, name, data, depth):
        if self.policy["assets"].get("exports/" + name) != scan.digest(data):
            self.add(name, "archive-needs-synthetic-data-review")
        if depth >= MAX_DEPTH:
            self.add(name, "archive-depth-limit")
            return
        try:
            if zipfile.is_zipfile(io.BytesIO(data)):
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    if len(archive.infolist()) > MAX_FILES:
                        raise ValueError("Too many archive entries")
                    for member in archive.infolist():
                        if member.is_dir():
                            continue
                        mode = member.external_attr >> 16
                        if member.flag_bits & 1 or stat.S_ISLNK(mode):
                            self.add(name, "encrypted-or-linked-archive-member")
                        elif member.file_size > MAX_FILE:
                            self.add(name, "archive-member-size-limit")
                            return
                        else:
                            with archive.open(member) as stream:
                                self.member(name, member.filename, stream.read(MAX_FILE + 1), depth)
            else:
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                    for count, member in enumerate(archive, 1):
                        if count > MAX_FILES:
                            raise ValueError("Too many archive entries")
                        if member.isdir():
                            continue
                        if not member.isfile():
                            self.add(name, "linked-or-special-archive-member")
                        elif member.size > MAX_FILE:
                            self.add(name, "archive-member-size-limit")
                            return
                        else:
                            self.member(name, member.name, archive.extractfile(member).read(MAX_FILE + 1), depth)
        except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, tarfile.TarError):
            self.add(name, "archive-unreadable-or-limit-exceeded")

    def content(self, name, data, depth=0):
        self.total += len(data)
        if len(data) > MAX_FILE or self.total > MAX_TOTAL or len(self.names) >= MAX_FILES:
            raise ValueError("Export scan size or file-count limit exceeded")
        suffix = Path(name).suffix.lower()
        key = scan.digest(name.encode()) + suffix
        if key in self.names:
            self.add(name, "duplicate-archive-member")
            return
        self.names[key] = name
        path = self.tree / key
        path.write_bytes(data)
        self.text(name, data)
        for _, line, rule in scan.inspect_file("path.txt", name.encode(), self.policy):
            self.add(name, "filename:" + rule, line)
        if suffix in IMAGES:
            # Even unusual image encodings require an exact, manually reviewed hash.
            if self.policy["assets"].get("exports/" + name) != scan.digest(data):
                self.add(name, "image-needs-synthetic-data-review")
            self.image(name, path)
        if suffix in ARCHIVES or data.startswith((b"PK\x03\x04", b"\x1f\x8b")):
            self.archive(name, data, depth)

    def walk(self, workspace):
        seen = 0
        for area in AREAS:
            root = workspace / area
            if not root.exists() and not root.is_symlink():
                continue
            if root.is_symlink() or not root.is_dir():
                self.add(area, "export-link-or-special-file")
                continue
            seen += 1
            for directory, folders, files in os.walk(root, followlinks=False):
                for entry in [*folders, *files]:
                    path = Path(directory) / entry
                    mode = path.lstat().st_mode
                    name = path.relative_to(workspace).as_posix()
                    if stat.S_ISDIR(mode):
                        continue
                    if not stat.S_ISREG(mode):
                        self.add(name, "export-link-or-special-file")
                        continue
                    with path.open("rb") as stream:
                        self.content(name, stream.read(MAX_FILE + 1))
        if not seen:
            raise ValueError("No export directories found")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--review-file", required=True, type=Path)
    parser.add_argument("--tesseract", default="tesseract")
    args = parser.parse_args()
    policy = load_policy(args.review_file)
    with tempfile.TemporaryDirectory(prefix="dispatch-exports-") as directory:
        temporary = Path(directory)
        tree = temporary / "snapshot"
        tree.mkdir()
        audit = ExportAudit(tree, policy, args.tesseract)
        audit.walk(args.workspace.resolve(strict=True))
        executable = scan.gitleaks(scan.ROOT, temporary)
        for name, line, rule in scan.secret_findings(executable, tree, temporary):
            audit.add(audit.names[name], rule, line)
        for name, line, rule in sorted(set(audit.findings)):
            print(f"{name}:{line}: {rule}")
        if audit.findings:
            raise SystemExit("Export privacy check failed; matching values are withheld.")
        print(f"Privacy, OCR and secret checks passed for {len(audit.names)} export files and archive members.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Export check could not complete ({type(error).__name__}); no result accepted.") from None
