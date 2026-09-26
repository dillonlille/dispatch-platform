import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "dispatch_backup", Path(__file__).resolve().parents[2] / "tooling/host/backup.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_snapshot_id_uses_the_summary_and_rejects_invalid_output(self):
        output = '\n'.join((json.dumps({"message_type": "status"}),
                            json.dumps({"snapshot_id": "a1b2c3"})))
        self.assertEqual(module.snapshot_id(output), "a1b2c3")
        for invalid in ("", '{"snapshot_id":"../secret"}', '{"snapshot_id":1}'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                module.snapshot_id(invalid)

    def test_local_repositories_and_non_https_origins_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "binary"
            password = root / "password"
            binary.write_text("")
            password.write_text("secret")
            environment = {
                "DISPATCH_BACKUP_BINARY": str(binary),
                "DISPATCH_BACKUP_STATE_ROOT": str(root),
                "DISPATCH_BACKUP_STAGING": str(root / "staging"),
                "DISPATCH_BACKUP_ORIGIN": "https://dispatch.example.test",
                "RESTIC_REPOSITORY": str(root / "repository"),
                "RESTIC_PASSWORD_FILE": str(password),
            }
            with self.assertRaises(ValueError):
                module.Settings(environment, require_root=False)
            environment["RESTIC_REPOSITORY"] = "rest:https://backup.example.test/repository"
            environment["DISPATCH_BACKUP_ORIGIN"] = "http://dispatch.example.test"
            with self.assertRaises(ValueError):
                module.Settings(environment, require_root=False)

    def test_backend_environment_does_not_receive_backup_credentials(self):
        class FakeSettings:
            binary = Path("/opt/dispatch-production/current/services/rust/dispatch-backend")
            state = Path("/var/lib/dispatch-production")
            origin = "https://dispatch.example.test"

        before = os.environ.copy()
        os.environ.update(RESTIC_PASSWORD="private", AWS_SECRET_ACCESS_KEY="private")
        try:
            environment = module.backend_environment(FakeSettings())
        finally:
            os.environ.clear()
            os.environ.update(before)
        self.assertNotIn("RESTIC_PASSWORD", environment)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)
        self.assertEqual(environment["DISPATCH_PROVIDER_MODE"], "native")


if __name__ == "__main__":
    unittest.main()
