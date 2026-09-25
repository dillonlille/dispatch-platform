import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tooling/security"))
import exports


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, data in files:
            archive.writestr(name, data)
    return output.getvalue()


class ExportPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.tree = self.root / "snapshot"
        self.tree.mkdir()
        self.policy = {"identitySha256": [exports.scan.digest(b"private fixture identity")],
                       "exceptions": [], "assets": {}}
        self.audit = exports.ExportAudit(self.tree, self.policy)

    def review(self, name, data):
        self.policy["assets"]["exports/" + name] = exports.scan.digest(data)

    def test_reviewed_image_still_runs_ocr_and_withholds_private_text(self):
        name, data = "mockups/screen.png", b"\x89PNG\0synthetic image"
        self.review(name, data)
        result = subprocess.CompletedProcess([], 0, b"Private\nFixture Identity", b"")
        with patch.object(exports.subprocess, "run", return_value=result):
            self.audit.content(name, data)
        self.assertIn((name, 1, "ocr:known-private-identity"), self.audit.findings)
        self.assertNotIn("Private", repr(self.audit.findings))
        self.assertFalse(any(b"Fixture Identity" in p.read_bytes() for p in self.tree.iterdir()))

    def test_changed_images_need_new_review_and_ocr_failures_fail_closed(self):
        name, data = "mockups/screen.png", b"\x89PNG\0synthetic image"
        self.review(name, data)
        with patch.object(exports.subprocess, "run", side_effect=FileNotFoundError):
            self.audit.content(name, data + b"changed")
        rules = {r[2] for r in self.audit.findings}
        self.assertIn("image-needs-synthetic-data-review", rules)
        self.assertIn("ocr-failed", rules)

    def test_archive_approval_does_not_skip_private_members_or_nested_images(self):
        image = b"\x89PNG\0synthetic image"
        nested = zip_bytes([("screen.png", image), (".env", b"private fixture")])
        data = zip_bytes([("nested.zip", nested)])
        self.review("mockups/export.zip", data)
        self.review("mockups/export.zip!nested.zip", nested)
        result = subprocess.CompletedProcess([], 0, b"Synthetic fixture", b"")
        with patch.object(exports.subprocess, "run", return_value=result) as ocr:
            self.audit.content("mockups/export.zip", data)
        self.assertEqual(ocr.call_count, 1)
        self.assertIn(("mockups/export.zip!nested.zip!.env", 1, "private-state-file"), self.audit.findings)
        self.assertIn(("mockups/export.zip!nested.zip!screen.png", 1,
                       "image-needs-synthetic-data-review"), self.audit.findings)
        self.assertEqual(len(self.audit.names), 4)
        self.assertTrue(any(p.read_bytes() == b"private fixture" for p in self.tree.iterdir()))

    def test_zip_traversal_and_links_are_not_extracted(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("../outside", b"private")
            link = zipfile.ZipInfo("link")
            link.create_system = 3
            link.external_attr = (0o120777 << 16)
            archive.writestr(link, "../outside")
        self.audit.content("mockups/export.zip", output.getvalue())
        rules = {r[2] for r in self.audit.findings}
        self.assertIn("unsafe-archive-member", rules)
        self.assertIn("encrypted-or-linked-archive-member", rules)
        self.assertEqual(len(self.audit.names), 1)
        self.assertFalse((self.root / "outside").exists())

    def test_tar_members_are_scanned_but_links_are_refused(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            member = tarfile.TarInfo("screen.html")
            data = b"Private Fixture Identity"
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
            link = tarfile.TarInfo("link")
            link.type = tarfile.SYMTYPE
            link.linkname = "screen.html"
            archive.addfile(link)
        self.audit.content("outputs/screens.tar.gz", output.getvalue())
        self.assertIn(("outputs/screens.tar.gz!screen.html", 1,
                       "known-private-identity"), self.audit.findings)
        self.assertIn(("outputs/screens.tar.gz", 1,
                       "linked-or-special-archive-member"), self.audit.findings)

    def test_limits_and_unreadable_archives_cannot_pass(self):
        with patch.object(exports, "MAX_TOTAL", 3):
            with self.assertRaises(ValueError):
                self.audit.content("outputs/large.txt", b"1234")
        self.audit.content("outputs/broken.zip", b"not an archive")
        self.assertIn(("outputs/broken.zip", 1,
                       "archive-unreadable-or-limit-exceeded"), self.audit.findings)
        data = zip_bytes([("inner.txt", b"synthetic")])
        self.audit.content("outputs/deep.zip", data, exports.MAX_DEPTH)
        self.assertIn(("outputs/deep.zip", 1, "archive-depth-limit"), self.audit.findings)

    def test_empty_archive_entries_count_toward_the_limit(self):
        data = zip_bytes([("one/", b""), ("two/", b""), ("three/", b"")])
        with patch.object(exports, "MAX_FILES", 2):
            self.audit.content("outputs/entries.zip", data)
        self.assertIn(("outputs/entries.zip", 1,
                       "archive-unreadable-or-limit-exceeded"), self.audit.findings)

    def test_walk_never_reads_links_or_runtime_directories(self):
        (self.root / "mockups").mkdir()
        (self.root / "data").mkdir()
        (self.root / "data/private.txt").write_text("Private Fixture Identity")
        (self.root / "mockups/file").symlink_to(self.root / "data/private.txt")
        (self.root / "mockups/directory").symlink_to(self.root / "data", target_is_directory=True)
        (self.root / "mockups/safe.html").write_text("Synthetic fixture")
        self.audit.walk(self.root)
        self.assertEqual(list(self.audit.names.values()), ["mockups/safe.html"])
        self.assertEqual(len(self.audit.findings), 2)
        self.assertTrue(all(r[2] == "export-link-or-special-file" for r in self.audit.findings))

    def test_private_review_manifest_cannot_disable_source_rules(self):
        p = self.root / "review.json"
        p.write_text(json.dumps({"assets": {}, "identitySha256": [],
                                 "exceptions": [{"rule": "personal-home-path"}]}))
        p.chmod(0o600)
        self.assertEqual(exports.load_policy(p)["exceptions"], [])
        p.chmod(0o644)
        with self.assertRaises(ValueError):
            exports.load_policy(p)

    def test_secret_scanner_reports_only_location_and_rule_and_propagates_errors(self):
        report = self.root / "secrets.json"
        report.write_text(json.dumps([{"File": str(self.tree / "screen.html"), "StartLine": 2,
                                       "RuleID": "synthetic-secret", "Secret": "never print this"}]))
        result = subprocess.CompletedProcess([], 1, b"", b"never print this")
        with patch.object(exports.scan.subprocess, "run", return_value=result):
            findings = exports.scan.secret_findings("scanner", self.tree, self.root)
        self.assertEqual(findings, [("screen.html", 2, "secret:synthetic-secret")])
        report.write_text("[]")
        with patch.object(exports.scan.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError):
                exports.scan.secret_findings("scanner", self.tree, self.root)
        with patch.object(exports.scan.subprocess, "run", side_effect=subprocess.TimeoutExpired("scanner", 120)):
            with self.assertRaises(subprocess.TimeoutExpired):
                exports.scan.secret_findings("scanner", self.tree, self.root)


if __name__ == "__main__":
    unittest.main()
