import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import unittest
from unittest.mock import patch
import dev_updater_test as fixtures
from dev_updater_test import artifact

spec = importlib.util.spec_from_file_location("rust_reset", Path(__file__).parents[1] / "tooling/migrate-rust-dev.py")
reset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset)


class FreshRustTests(unittest.TestCase):
    git = fixtures.DevUpdaterTests.git

    def setUp(self):
        fixtures.DevUpdaterTests.setUp(self)
        self.instance = reset.FreshRustUpdater(self.root)
        shutil.rmtree(self.live / ".build")
        self.old_artifact = artifact(self.live / ".build", self.old, "old", schema=2)
        self.git("reset", "--hard", self.new)
        unit = self.live / "tooling/systemd/dispatch-dev.service"
        unit.parent.mkdir(parents=True)
        unit.write_text("[Service]\nExecStart=%h/dispatch-platform/dev/live/.build/services/rust/dispatch-backend serve\n")
        self.git("add", ".")
        self.git("commit", "-m", "Rust service")
        self.new = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/remotes/origin/dev", self.new)
        self.git("reset", "--hard", self.old)
        shutil.rmtree(self.candidate)
        # Stand-in bootstrap for testing the updater's swap/rollback state machine.
        # The real executable is exercised separately by Rust/API/artifact suites.
        bootstrap = """#!/usr/bin/python3
import os
from pathlib import Path
os.umask(0o077)
root=Path(os.environ['DISPATCH_STATE_ROOT'])
(root/'data/platform').mkdir(parents=True)
(root/'dsps/new-dsp').mkdir(parents=True)
(root/'data/new-state').write_text('fresh')
"""
        self.manifest = artifact(self.candidate, self.new, bootstrap, rust=True)
        (self.root / "dsps").mkdir(mode=0o700)
        (self.root / "dsps/private-sentinel").write_text("old tenant data")
        self.instance.unit = self.root / "config/service.unit"
        self.instance.unit.write_text("old Node unit")
        (self.root / "config/initial-owner.json").write_text(json.dumps({"email": "owner@example.test", "password": "old private"}))
        (self.root / "config/platform.env").write_text("\n".join(f'{key}={json.dumps(value)}' for key, value in {
            "DISPATCH_STATE_ROOT": str(self.root), "DISPATCH_ENVIRONMENT": "preview", "DISPATCH_STANDALONE": "1", "DISPATCH_ORIGIN": "http://127.0.0.1:5180"}.items()))
        with sqlite3.connect(self.instance.platform / "accounts.sqlite") as db:
            db.execute("CREATE TABLE users(email,first_name,last_name,platform_owner,status)")
            db.execute("INSERT INTO users VALUES ('owner@example.test','Test','Owner',1,'active')")
        (self.root / "config/unrelated").write_text("preserve configuration")
        (self.root.parent / "archive").mkdir()
        (self.root.parent / "archive/sentinel").write_text("preserve archive")
        (self.root.parent / "public").mkdir()
        (self.root.parent / "public/sentinel").write_text("preserve production")
        self.actions = []
        for method in ["service", "timer"]:
            p = patch.object(self.instance, method, side_effect=lambda action, method=method: self.actions.append((method, action)))
            p.start(); self.addCleanup(p.stop)
        p = patch.object(self.instance, "reload_units"); p.start(); self.addCleanup(p.stop)
        p = patch.object(self.instance, "healthy", return_value=True); p.start(); self.addCleanup(p.stop)
        p = patch.object(self.instance, "verify_fresh"); p.start(); self.addCleanup(p.stop)
        # Only the timer status query is mocked; bootstrap executes the verified candidate.
        original = subprocess.run
        p = patch.object(reset.subprocess, "run", side_effect=lambda args, **kwargs: subprocess.CompletedProcess(args, 0) if args[0] == "systemctl" else original(args, **kwargs))
        p.start(); self.addCleanup(p.stop)

    def preserved(self):
        self.assertEqual((self.root / "config/unrelated").read_text(), "preserve configuration")
        self.assertEqual((self.root.parent / "archive/sentinel").read_text(), "preserve archive")
        self.assertEqual((self.root.parent / "public/sentinel").read_text(), "preserve production")

    def restored(self):
        self.assertEqual(self.git("rev-parse", "HEAD"), self.old)
        self.assertEqual((self.root / "data/private-sentinel").read_text(), "retained")
        self.assertEqual((self.root / "dsps/private-sentinel").read_text(), "old tenant data")
        self.assertEqual(self.instance.unit.read_text(), "old Node unit")
        self.assertEqual(json.loads((self.root / "config/initial-owner.json").read_text())["password"], "old private")
        self.assertFalse(self.instance.reset_receipt.exists())
        self.preserved()

    def test_success_verifies_new_platform_before_erasing_old_state(self):
        def verify(*args):
            self.assertTrue((self.instance.rollback / "data/private-sentinel").exists())
            self.assertEqual((self.root / "data/new-state").read_text(), "fresh")
        self.instance.verify_fresh.side_effect = verify
        self.instance.activate(self.candidate, self.new)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.new)
        self.assertFalse((self.root / "data/private-sentinel").exists())
        self.assertFalse((self.root / "dsps/private-sentinel").exists())
        self.assertFalse(self.instance.rollback.exists())
        self.assertFalse(self.instance.reset_receipt.exists())
        self.assertNotEqual(json.loads((self.root / "config/initial-owner.json").read_text())["password"], "old private")
        self.preserved()

    def test_login_failure_restores_old_state_code_and_credentials(self):
        self.instance.verify_fresh.side_effect = RuntimeError("fresh login failed")
        with self.assertRaisesRegex(RuntimeError, "fresh login"):
            self.instance.activate(self.candidate, self.new)
        self.restored()

    def test_fresh_cutover_accepts_rust_only_artifact(self):
        bootstrap = (self.candidate / "services/rust/dispatch-backend").read_text()
        shutil.rmtree(self.candidate)
        artifact(self.candidate, self.new, bootstrap, rust_only=True)
        self.instance.activate(self.candidate, self.new)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.new)
        self.assertEqual((self.root / "data/new-state").read_text(), "fresh")
        self.preserved()

    def test_health_failure_restores_previous_platform(self):
        self.instance.healthy.side_effect = [False, True]
        with self.assertRaisesRegex(RuntimeError, "Rust Dev failed health"):
            self.instance.activate(self.candidate, self.new)
        self.restored()

    def test_preparation_failure_never_stops_existing_platform(self):
        original = reset.subprocess.run
        def fail_bootstrap(args, **kwargs):
            if len(args)>1 and args[1] == "bootstrap":
                raise subprocess.CalledProcessError(1, "bootstrap")
            return original(args, **kwargs)
        with patch.object(reset.subprocess, "run", side_effect=fail_bootstrap):
            with self.assertRaises(subprocess.CalledProcessError):
                self.instance.activate(self.candidate, self.new)
        self.assertEqual(self.actions, [])
        self.restored()

    def record(self, **changes):
        result = {"format": 1, "root": str(self.root), "oldCommit": self.old, "commit": self.new,
                  "oldDigest": self.old_artifact["digest"], "timerActive": True,
                  "phase": "swapping", "complete": False, **changes}
        reset.updates.write_json(self.instance.reset_receipt, result)

    def test_interrupted_data_rename_restores_before_new_service_starts(self):
        self.instance.rollback.mkdir()
        (self.root / "data").rename(self.instance.rollback / "data")
        self.record()
        self.instance.recover_reset()
        self.restored()

    def test_complete_receipt_never_resurrects_retired_data(self):
        self.instance.rollback.mkdir()
        (self.instance.rollback / "old-data").write_text("retired")
        self.record(complete=True)
        self.instance.recover_reset()
        self.assertFalse(self.instance.rollback.exists())
        self.assertEqual(self.actions, [("timer", "start")])
        self.preserved()

    def test_symlinked_state_boundary_is_rejected_before_service_changes(self):
        (self.root / "dsps").rename(self.root / "hidden-dsps")
        (self.root / "dsps").symlink_to(self.root / "hidden-dsps")
        with self.assertRaisesRegex(RuntimeError, "Unsafe Dev state boundary"):
            self.instance.activate(self.candidate, self.new)
        self.assertEqual(self.actions, [])
        self.preserved()

    def test_regular_updater_cannot_cross_schema_or_pending_reset(self):
        with self.assertRaisesRegex(RuntimeError, "Schema"):
            reset.updates.DevUpdater(self.root).activate(self.candidate, self.new)
        self.record()
        with self.assertRaisesRegex(RuntimeError, "cutover"):
            reset.updates.DevUpdater(self.root).update()
        self.preserved()


if __name__ == "__main__":
    unittest.main()
