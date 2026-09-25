import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("privacy", ROOT / "tooling/security/scan.py")
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


def policy():
    return {"identitySha256": [scan.digest(b"private fixture identity")], "exceptions": [], "assets": {}}


class PrivacyTests(unittest.TestCase):
    def test_sensitive_content_reports_locations_without_values(self):
        private_email = "actual" + "@" + "mailbox.net"
        home = "/" + "home/operator/private"
        address = "10." + "21.22.23"
        content = "\n".join([private_email, home, address, "Private Fixture Identity"])
        findings = scan.inspect_file("source.ts", content.encode(), policy())
        self.assertEqual({f[2] for f in findings}, {
            "non-example-email", "personal-home-path", "fixed-network-address", "known-private-identity"})
        self.assertEqual({f[1] for f in findings}, {1, 2, 3, 4})
        for value in [private_email, home, address, "Private Fixture Identity"]:
            self.assertNotIn(value, repr(findings))

    def test_synthetic_values_and_linux_interfaces_are_allowed(self):
        content = b"owner@example.test http://127.0.0.1 /proc/meminfo /usr/bin/bwrap ../home/index.js 192.0.2.5"
        self.assertEqual(scan.inspect_file("source.ts", content, policy()), [])

    def test_windows_home_paths_are_caught_in_plain_and_escaped_source(self):
        for slash in [chr(92), chr(92) * 2]:
            content = ('C:' + slash + 'Users' + slash + 'operator' + slash + 'private').encode()
            self.assertEqual(scan.inspect_file("source.ts", content, policy()),
                             [("source.ts", 1, "personal-home-path")])

    def test_exceptions_apply_only_to_the_reviewed_line_file_and_rule(self):
        p = policy()
        line = "Private Fixture Identity"
        p["exceptions"] = [{"path": "compat.rs", "rule": "known-private-identity",
                            "lineSha256": scan.digest(line.encode()), "reason": "Compatibility fixture"}]
        self.assertEqual(scan.inspect_file("compat.rs", line.encode(), p), [])
        self.assertTrue(scan.inspect_file("other.rs", line.encode(), p))
        self.assertTrue(scan.inspect_file("compat.rs", (line + " modified").encode(), p))

    def test_assets_need_exact_reviewed_content_and_state_files_remain_private(self):
        p = policy()
        data = b"\0synthetic asset"
        p["assets"]["dashboard/art.png"] = hashlib.sha256(data).hexdigest()
        self.assertEqual(scan.inspect_file("dashboard/art.png", data, p), [])
        self.assertTrue(scan.inspect_file("dashboard/art.png", data + b"changed", p))
        self.assertTrue(scan.inspect_file("screenshot.png", data, p))
        for name in ["config/platform.env", "data/accounts.sqlite", "dsps/example/profile.json", "vault.key", "capture.har", ".env.production", ".dev.vars", ".dev.vars.production", "export.zip"]:
            self.assertTrue(scan.inspect_file(name, b"private", p), name)
        self.assertEqual(scan.inspect_file(".env.example", b"SETTING=example", p), [])

    def test_snapshot_ignores_runtime_state_but_catches_forced_tracked_state_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            root.mkdir()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".gitignore").write_text(".env\n")
            (root / ".env").write_text("private")
            (root / "source.ts").write_text("safe source")
            external = Path(directory) / "outside"
            external.write_text("private external bytes")
            (root / "linked").symlink_to(external)
            subprocess.run(["git", "-C", str(root), "add", "-f", ".env"], check=True)
            target = Path(directory) / "snapshot"
            target.mkdir()
            count, findings = scan.snapshot(root, target, policy())
            self.assertEqual(count, 3)
            self.assertIn((".env", 1, "private-state-file"), findings)
            self.assertIn(("linked", 1, "source-link-or-special-file"), findings)
            self.assertFalse((target / "linked").exists())
            self.assertEqual((target / "source.ts").read_text(), "safe source")
            subprocess.run(["git", "-C", str(root), "rm", "--cached", "-q", ".env"], check=True)
            self.assertNotIn(".env", scan.sources(root))


if __name__ == "__main__":
    unittest.main()
