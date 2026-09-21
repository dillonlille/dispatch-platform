"""Real-process compatibility tests for the installed Python-to-Rust handoff.

The Rust suite owns updater behavior; these keep the shipped Python launch paths,
legacy updater and format-3 fixture writer as independent compatibility oracles.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLING = Path(__file__).parents[2] / "tooling"
sys.path.insert(0, str(TOOLING))
import runtime_artifact as runtime

def artifact(root, commit, marker="candidate"):
    root.mkdir(mode=0o700, parents=True)
    contents = {
        "services/rust/dispatch-backend": marker, "dashboard/index.html": "<h1>Dispatch</h1>",
        "tooling/build-info.json": json.dumps({"commit": commit}),
    }
    for name, contents in contents.items():
        target = root / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_text(contents)
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


class DevHandoffTests(unittest.TestCase):
    def test_legacy_activation_installs_rust_then_rust_recovers_pre_migration_runtime(self):
        binary = runtime.host_binary()
        script = Path(__file__).parents[1] / "support/legacy-updater/handoff.py.fixture"
        result = subprocess.run([sys.executable, str(script), str(TOOLING), str(binary)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("legacy activation and Rust rollback passed", result.stdout)

    def test_bootstrap_refuses_tampering_or_incomplete_activation_without_executing_candidate(self):
        for state in ["tampered", "waiting_for_checks", "wrong_digest", "no_capability"]:
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "public"
                root.mkdir(mode=0o700)
                active = root / "live"
                manifest = artifact(active, "a" * 40)
                metadata = active / "tooling/build-info.json"
                metadata.write_text(json.dumps({"commit": "a" * 40, "hostManagement": 0 if state == "no_capability" else 1}))
                manifest = runtime.host("artifact", "write", active, "0.1.0")
                if state == "tampered":
                    (active / "services/rust/dispatch-backend").write_text("#!/bin/sh\ntouch " + str(root / "executed"))
                runtime.write_json(root / "data/platform/production-update.json", {
                    "status": "waiting_for_checks" if state == "waiting_for_checks" else "ready",
                    "commit": "a" * 40, "digest": "0" * 64 if state == "wrong_digest" else manifest["digest"]})
                management = runtime.private_directory(root / "management")
                for name in ["runtime_artifact.py", "update-production.py"]:
                    shutil.copyfile(TOOLING / name, management / name)
                result = subprocess.run([sys.executable, str(management / "update-production.py"), "--root", str(root), "--verify"], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((management / "dispatch-host").exists())
                self.assertFalse((root / "executed").exists())


if __name__ == "__main__":
    unittest.main()
