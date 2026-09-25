"""The launchers' way to the Rust host manager, from a checkout or an installed management
directory. Artifact policy and the updaters live in backend/host."""
import functools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPOSITORY = "dispatch-systems/dispatch-platform"
STABLE = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"

def require(value, message):
    if not value:
        raise RuntimeError(message)


def command(*args, cwd=None, timeout=120, binary=False):
    result = subprocess.run(args, cwd=cwd, text=not binary, capture_output=True, timeout=timeout)
    if result.returncode:
        problem = result.stderr if isinstance(result.stderr, str) else result.stderr.decode(errors="replace")
        raise RuntimeError(f"{' '.join(args[:3])} failed: {problem.strip()[-600:]}")
    return result.stdout if binary else result.stdout.strip()


def github(endpoint, *args, binary=False, timeout=120):
    """Authenticated repository API through the GitHub CLI."""
    data = command("gh", "api", f"repos/{REPOSITORY}/{endpoint}", *args, binary=binary, timeout=timeout)
    return data if binary else json.loads(data)


def private_directory(directory):
    directory = Path(directory)
    require(not directory.is_symlink(), "Private directory cannot be a symlink")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "Private directory permissions required")
    return directory


def write_json(filename, value):
    private_directory(filename.parent)
    fd, temp = tempfile.mkstemp(prefix=".update-", dir=filename.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, filename)
        fd = os.open(filename.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def prebuilt_host(root):
    """The host the tools job of this ref or of main built from identical inputs, restored here.

    Only the workspace's own `.ci-tools` directory is trusted, and only on CI. This file is also
    installed alone under `management`, so the rule is kept here rather than imported.
    """
    tools = os.environ.get("DISPATCH_CI_TOOLS")
    if os.environ.get("CI") != "true" or not tools or Path(tools) != root / ".ci-tools":
        return None
    binary = root / ".ci-tools/tools/dispatch-host"
    if binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK):
        return None
    return binary


@functools.cache
def host_binary():
    tooling = Path(__file__).resolve().parent
    root = tooling.parent
    if (root / "backend/host/Cargo.toml").is_file():
        # Build from this checkout, never search the candidate being verified.
        restored = prebuilt_host(root)
        if restored is not None:
            return restored
        # Selecting the whole workspace resolves dependency features as the workspace build
        # does, so right after one this reuses its output instead of compiling them again.
        subprocess.check_call(["cargo", "build", "--locked", "--release", "--workspace", "--bin", "dispatch-host"],
                              cwd=root, stdout=sys.stderr)
        metadata = json.loads(command("cargo", "metadata", "--locked", "--no-deps", "--format-version=1", cwd=root))
        return Path(metadata["target_directory"]) / "release/dispatch-host"
    require(tooling.name == "management", "Run host tooling from a checkout or installed management directory")
    binary = tooling / "dispatch-host"
    require(binary.exists(), "Installed host management is missing; install it from a checkout with --install-management")
    info = binary.lstat()
    require(binary.is_file() and not binary.is_symlink() and info.st_nlink == 1
            and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "Private installed host executable required")
    return binary


def host(*args, value=None):
    process = subprocess.Popen([str(host_binary()), "host", *map(str, args)],
                               stdin=subprocess.PIPE if value is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, stderr = process.communicate(None if value is None else json.dumps(value), timeout=600)
    except BaseException:
        process.kill()
        process.wait()
        raise
    require(process.returncode == 0, stderr.strip() or "Host management failed")
    # What the host reports alongside a success, such as an install, reaches the journal.
    sys.stderr.write(stderr)
    return json.loads(stdout)


def verify_artifact(directory, commit=None):
    return host("artifact", "verify", directory, *([commit] if commit else []))


def unpack(archive, destination):
    return host("artifact", "unpack", archive, destination)


def install_management(live, environment="dev", tooling=None):
    """Compatibility adapter; Rust installs the binary and embedded launchers together."""
    host(environment, "--root", Path(live), "--install-management")


if __name__ == "__main__":
    try:
        print(json.dumps(host(*sys.argv[1:])))
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
