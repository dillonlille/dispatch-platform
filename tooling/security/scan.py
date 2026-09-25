#!/usr/bin/env python3
"""Check publishable source for private data; print locations, never matching values."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
EMAIL = re.compile(r"(?<![\w.+-])[\w.+%-]+@([\w.-]+\.[A-Za-z]{2,})")
HOME = re.compile(r"(?<![\w./:])(?:/(?:home|Users|root)/|[A-Za-z]:\\+Users\\+)")
IP = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
WORDS = re.compile(r"[a-z0-9]+")
PRIVATE = re.compile(r"(?:^|/)(?:\.(?:env|dev\.vars)(?:\..+)?|[^/]+\.(?:key|pem|p12|pfx|enc|har|sqlite\w*|db)(?:-\w+)?)$", re.I)
ASSETS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".glb", ".woff", ".woff2", ".svg"}
ARCHIVES = {".zip", ".gz", ".tgz", ".tar", ".7z"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def inspect_file(name, data, policy):
    findings = []
    def add(line, rule, text=""):
        signature = digest(text.strip().encode())
        if any(e["path"] == name and e["rule"] == rule and e["lineSha256"] == signature
               for e in policy["exceptions"]):
            return
        findings.append((name, line, rule))
    path = Path(name)
    if (PRIVATE.search(name) and path.name != ".env.example") or path.parts[0] in {"config", "data", "dsps", ".privacy", "mockups", "outputs"}:
        add(1, "private-state-file")
    if path.suffix in ARCHIVES:
        add(1, "archive-needs-private-storage")
    if path.suffix in ASSETS or b"\0" in data:
        if policy["assets"].get(name) != digest(data):
            add(1, "asset-needs-synthetic-data-review")
        if b"\0" in data:
            return findings
    identities = set(policy["identitySha256"])
    for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
        if HOME.search(line):
            add(number, "personal-home-path", line)
        for match in EMAIL.finditer(line):
            domain = match[1].lower()
            if domain.endswith((".test", ".example", ".invalid", ".localhost")) or domain in {"example.com", "example.org", "example.net"}:
                continue
            # An SSH transport authority is not a mailbox.
            if match.group().startswith("git@") and domain == "github.com" and line[match.end():].startswith(":"):
                continue
            add(number, "non-example-email", line)
        for match in IP.finditer(line):
            try:
                address = ipaddress.ip_address(match.group())
            except ValueError:
                continue
            if address.is_loopback or address.is_unspecified or any(address in ipaddress.ip_network(block)
                    for block in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")):
                continue
            add(number, "fixed-network-address", line)
        words = WORDS.findall(line.lower())
        if any(digest(" ".join(words[i:i + size]).encode()) in identities
               for size in (1, 2, 3) for i in range(len(words) - size + 1)):
            add(number, "known-private-identity", line)
    return sorted(set(findings))


def sources(root):
    raw = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root)
    return sorted(set(name for name in raw.decode().split("\0") if name))


def snapshot(root, destination, policy):
    findings = []
    count = 0
    for name in sources(root):
        source = root / name
        # A tracked deletion has no bytes to publish. Never dereference a source link.
        if not source.exists() and not source.is_symlink():
            continue
        if not stat.S_ISREG(source.lstat().st_mode) or any(p.is_symlink() for p in source.parents if p != root):
            findings.append((name, 1, "source-link-or-special-file"))
            continue
        data = source.read_bytes()
        findings.extend(inspect_file(name, data, policy))
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        count += 1
    return count, findings


def gitleaks(root, temporary):
    pin = json.loads((ROOT / "tooling/security/gitleaks.json").read_text())
    machine = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    target = f"{platform.system().lower()}_{machine}"
    expected = pin["archives"].get(target)
    if not expected:
        raise ValueError("Secret scanner needs a pinned archive for this platform")
    archive = root / ".ci-tools/privacy" / f"gitleaks_{pin['version']}_{target}.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        url = f"https://github.com/gitleaks/gitleaks/releases/download/v{pin['version']}/{archive.name}"
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(32 * 1024 * 1024 + 1)
        if digest(data) != expected:
            raise ValueError("Secret scanner archive checksum mismatch")
        staged = temporary / "download.tar.gz"
        staged.write_bytes(data)
        shutil.copyfile(staged, archive)
    if digest(archive.read_bytes()) != expected:
        raise ValueError("Cached secret scanner archive checksum mismatch")
    with tarfile.open(archive) as package:
        member = package.getmember("gitleaks")
        if not member.isfile():
            raise ValueError("Secret scanner archive has no regular executable")
        executable = temporary / "gitleaks"
        executable.write_bytes(package.extractfile(member).read())
    executable.chmod(0o700)
    return executable


def secret_findings(executable, tree, temporary):
    report = temporary / "secrets.json"
    result = subprocess.run([str(executable), "dir", str(tree), "--no-banner", "--redact=100",
                             "--ignore-gitleaks-allow", f"--gitleaks-ignore-path={temporary}",
                             f"--config={ROOT / 'tooling/security/gitleaks.toml'}",
                             "--report-format=json", f"--report-path={report}"],
                            capture_output=True, timeout=120,
                            env={k: v for k, v in os.environ.items() if not k.startswith("GITLEAKS_")})
    if result.returncode not in (0, 1):
        raise ValueError("Secret scanner failed; no result accepted")
    secrets = json.loads(report.read_text()) if report.exists() else []
    if result.returncode == 1 and not secrets:
        raise ValueError("Secret scanner failed without a findings report")
    findings = []
    for secret in secrets:
        name = Path(secret["File"])
        if name.is_absolute():
            name = name.relative_to(tree)
        findings.append((str(name), secret["StartLine"], "secret:" + secret["RuleID"]))
    return findings


def main():
    os.umask(0o077)
    policy = json.loads((ROOT / "tooling/security/privacy-policy.json").read_text())
    with tempfile.TemporaryDirectory(prefix="dispatch-privacy-") as directory:
        temporary = Path(directory)
        tree = temporary / "source"
        tree.mkdir()
        count, findings = snapshot(ROOT, tree, policy)
        executable = gitleaks(ROOT, temporary)
        findings.extend(secret_findings(executable, tree, temporary))
        for name, line, rule in sorted(set(findings)):
            print(f"{name}:{line}: {rule}")
        if findings:
            raise SystemExit("Privacy check failed; matching values are withheld.")
        print(f"Privacy and secret checks passed for {count} publishable files.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Privacy check could not complete ({type(error).__name__}); no result accepted.") from None
