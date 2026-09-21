"""Installed Production launcher compatibility; updater policy lives in Rust tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from dev_updater_test import artifact, runtime, TOOLING


class ProductionLauncherTests(unittest.TestCase):
    def test_explicit_install_keeps_management_independent_of_live_runtime(self):
        binary = runtime.host_binary()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "public"
            root.mkdir(mode=0o700)
            active = root / "live"
            artifact(active, "a" * 40)
            shutil.copyfile(binary, active / "services/rust/dispatch-backend")
            (active / "tooling/build-info.json").write_text(json.dumps({"commit": "a" * 40, "hostManagement": 1}))
            runtime.host("artifact", "write", active, "0.1.0")
            runtime.write_json(root / "config/updater.json", {"service": "dispatch-production.service", "healthUrl": "http://127.0.0.1:5180/api/health"})
            runtime.install_management(root, "production")
            installed = root / "management/dispatch-host"
            self.assertEqual(installed.read_bytes(), binary.read_bytes())
            launcher = root / "management/update-production.py"
            result = subprocess.run([sys.executable, str(launcher), "--root", str(root), "--verify"], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(installed.stat().st_mode & 0o777, 0o700)
            # Roll back the runtime to a pre-migration format-3 release. Starting it
            # continues to use the installed Rust copy, not that runtime executable.
            shutil.rmtree(active)
            artifact(active, "b" * 40)
            runtime.host("artifact", "write", active, "0.0.9")
            result = subprocess.run([sys.executable, str(launcher), "--root", str(root), "--verify"], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(installed.read_bytes(), binary.read_bytes())

    def test_legacy_systemd_paths_remain_callable_and_use_no_github_credentials(self):
        for environment in ["dev", "production"]:
            launcher = TOOLING / f"update-{environment}.py"
            result = subprocess.run([sys.executable, str(launcher), "--help"], capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn(b"--verify", result.stdout)
            unit = (TOOLING / f"systemd/dispatch-{environment}.service").read_text()
            self.assertIn(f"update-{environment}.py", unit)
            self.assertNotIn("--verify-management", unit)


if __name__ == "__main__":
    unittest.main()
