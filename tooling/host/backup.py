#!/usr/bin/env python3
"""Create an application-consistent off-host backup and prove that it restores."""

import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse


REMOTE_REPOSITORIES = ("azure:", "b2:", "gs:", "rclone:", "rest:", "s3:", "sftp:", "swift:")


def absolute_path(environment, name):
    value = Path(environment.get(name, ""))
    if not value.is_absolute():
        raise ValueError(f"{name} must be absolute")
    return value


class Settings:
    def __init__(self, environment=None, require_root=True):
        environment = os.environ if environment is None else environment
        if require_root and os.geteuid() != 0:
            raise PermissionError("backup must run as root")
        self.binary = absolute_path(environment, "DISPATCH_BACKUP_BINARY")
        self.state = absolute_path(environment, "DISPATCH_BACKUP_STATE_ROOT")
        self.staging = absolute_path(environment, "DISPATCH_BACKUP_STAGING")
        self.origin = environment.get("DISPATCH_BACKUP_ORIGIN", "")
        self.repository = environment.get("RESTIC_REPOSITORY", "")
        self.password_file = absolute_path(environment, "RESTIC_PASSWORD_FILE")
        self.restic = Path("/usr/bin/restic")
        self.runuser = Path("/usr/sbin/runuser")
        origin = urllib.parse.urlsplit(self.origin)
        if not (origin.scheme == "https" and origin.netloc and origin.path in ("", "/")
                and not origin.username and not origin.password and not origin.query
                and not origin.fragment):
            raise ValueError("DISPATCH_BACKUP_ORIGIN must be a canonical HTTPS origin")
        if not self.repository.startswith(REMOTE_REPOSITORIES):
            raise ValueError("RESTIC_REPOSITORY must be off-host")
        for path in (self.binary, self.password_file, self.restic, self.runuser):
            secure_root_file(path)
        if not self.state.is_dir() or self.state.is_symlink():
            raise ValueError("backup state root must be a directory")
        self.staging.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.staging.stat()
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISDIR(info.st_mode):
            raise PermissionError("backup staging must be root-owned mode 0700")
        runtime = pwd.getpwnam("dispatch-runtime")
        self.runtime_uid = runtime.pw_uid
        self.runtime_gid = runtime.pw_gid
        if self.runtime_uid == 0:
            raise PermissionError("dispatch-runtime must be unprivileged")


def secure_root_file(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise PermissionError(
            f"{path.name} must be root-owned and not group- or world-writable"
        )


def backend_environment(settings):
    # The backup helper never passes repository credentials to the application binary.
    artifact = settings.binary.parents[2]
    return {
        "PATH": "/usr/bin:/bin",
        "NODE_ENV": "production",
        "DISPATCH_ENVIRONMENT": "production",
        "DISPATCH_STANDALONE": "1",
        "DISPATCH_PROVIDER_MODE": "native",
        "DISPATCH_PRODUCTION_MAIL_MODE": "disabled",
        "DISPATCH_STATE_ROOT": str(settings.state),
        "DISPATCH_ARTIFACT_ROOT": str(artifact),
        "DISPATCH_ORIGIN": settings.origin,
    }


def restic_environment(settings):
    environment = os.environ.copy()
    cache = settings.staging / "restic-cache"
    cache.mkdir(mode=0o700, exist_ok=True)
    environment["RESTIC_CACHE_DIR"] = str(cache)
    environment["HOME"] = str(settings.staging)
    return environment


def run(command, *, environment=None, capture=False, cwd=None):
    return subprocess.run(
        [str(part) for part in command],
        env=environment,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        cwd=cwd,
    )


def run_backend(settings, arguments):
    run([settings.runuser, "--user", "dispatch-runtime", "--", settings.binary, *arguments],
        environment=backend_environment(settings))


def snapshot_id(output):
    for line in reversed(output.splitlines()):
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        value = item.get("snapshot_id") if isinstance(item, dict) else None
        if isinstance(value, str) and value and all(character in "0123456789abcdef" for character in value):
            return value
    raise ValueError("restic did not return a snapshot identifier")


def backup(settings):
    working = Path(tempfile.mkdtemp(prefix="run-", dir=settings.staging))
    source = working / "snapshot"
    restored = working / "restored"
    target = working / "validated"
    try:
        restic_env = restic_environment(settings)
        os.chown(working, settings.runtime_uid, settings.runtime_gid)
        os.chmod(working, 0o700)
        run_backend(settings, ["backup", source])
        result = run(
            [settings.restic, "backup", "--json", "--host", "dispatch-production",
             "--tag", "dispatch-production", source],
            environment=restic_env, capture=True,
        )
        identifier = snapshot_id(result.stdout)
        restored.mkdir(mode=0o700)
        os.chown(restored, settings.runtime_uid, settings.runtime_gid)
        run([settings.restic, "restore", identifier, "--target", restored, "--verify"],
            environment=restic_env)
        manifests = list(restored.rglob("backup.json"))
        if len(manifests) != 1:
            raise ValueError("restored snapshot did not contain one backup manifest")
        restored_source = manifests[0].parent
        parent = restored_source.parent
        while parent == restored or restored in parent.parents:
            os.chown(parent, settings.runtime_uid, settings.runtime_gid)
            os.chmod(parent, 0o700)
            if parent == restored:
                break
            parent = parent.parent
        run_backend(settings, ["restore", restored_source, target])
        run([settings.restic, "check"], environment=restic_env)
    finally:
        shutil.rmtree(working)


def main():
    step = "configuration"
    try:
        settings = Settings()
        step = "backup_and_restore_drill"
        backup(settings)
        print(json.dumps({"event": "production.backup_verified"}, separators=(",", ":")))
    except (OSError, ValueError, subprocess.SubprocessError):
        # Repository locations, credentials, paths and command output stay out of the journal.
        print(json.dumps({"event": "production.backup_failed", "fields": {"step": step}},
                         separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
