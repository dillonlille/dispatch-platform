"""Real-process checks of the installed launch path: the launcher runs only an installed
manager and never the candidate it verifies."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLING = Path(__file__).parents[2] / "tooling"
sys.path.insert(0, str(TOOLING))
import runtime_artifact as runtime


def artifact(root, commit):
    root.mkdir(mode=0o700, parents=True)
    contents = {
        "services/rust/dispatch-backend": "#!/bin/sh\ntouch " + str(root.parent / "executed"),
        "dashboard/index.html": "<h1>Dispatch</h1>",
        "tooling/build-info.json": json.dumps({"commit": commit, "hostManagement": 1}),
    }
    for name, text in contents.items():
        target = root / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_text(text)
    files = []
    for item in sorted(root.rglob("*")):
        if item.is_file():
            files.append({"path": item.relative_to(root).as_posix(),
                          "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
                          "size": item.stat().st_size})
    manifest = {"format": 3, "version": "0.1.0-dev.0", "runtime": "rust", "schema": 3, "files": files}
    manifest["digest"] = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
    (root / "release.json").write_text(json.dumps(manifest))
    return manifest


class InstalledLauncherTests(unittest.TestCase):
    def test_a_missing_manager_is_an_error_and_the_candidate_is_never_executed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "public"
            root.mkdir(mode=0o700)
            manifest = artifact(root / "live", "a" * 40)
            runtime.write_json(root / "data/platform/production-update.json",
                               {"status": "ready", "commit": "a" * 40, "digest": manifest["digest"]})
            management = runtime.private_directory(root / "management")
            for name in ["runtime_artifact.py", "update-production.py"]:
                shutil.copyfile(TOOLING / name, management / name)
            result = subprocess.run([sys.executable, str(management / "update-production.py"),
                                     "--root", str(root), "--verify"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Installed host management is missing", result.stderr)
            self.assertFalse((management / "dispatch-host").exists())
            self.assertFalse((root / "executed").exists())


if __name__ == "__main__":
    unittest.main()
