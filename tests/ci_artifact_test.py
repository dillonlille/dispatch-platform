import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from dev_updater_test import artifact

spec = importlib.util.spec_from_file_location("ci_artifact", Path(__file__).parents[1] / "tooling/ci-artifact.py")
promote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promote)


class ArtifactPromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-promotion-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.destination = self.root / ".build"
        self.old, self.new = "a" * 40, "b" * 40
        self.context = {"commit": self.new, "base": "c" * 40, "head": "d" * 40, "tree": "e" * 40}
        self.verified = ({"id": 17, "run_attempt": 2}, {"commit": self.old})
        self.source = self.root / "source"
        self.manifest = artifact(self.source, self.old)
        self.env = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/dev", "GITHUB_SHA": self.new}

    def package(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            archive.add(self.source, arcname=".")
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("dispatch-dev.tar.gz", data.getvalue())
        self.download = archive.getvalue()
        return {"id": 42, "name": "dispatch-pr-build-17-2", "expired": False,
                "size_in_bytes": len(self.download), "digest": "sha256:" + hashlib.sha256(self.download).hexdigest()}

    def restore(self, asset=None, validations=None):
        asset = self.package() if asset is None else asset
        def download(_args, **kwargs):
            kwargs["stdout"].write(self.download)
        with patch.dict(promote.os.environ, self.env), \
                patch.object(promote.ci, "merge_context", return_value=self.context), \
                patch.object(promote.ci, "validated_receipt", side_effect=validations or [self.verified, self.verified]), \
                patch.object(promote.ci, "github", return_value={"artifacts": [asset]}), \
                patch.object(promote.subprocess, "run", side_effect=download):
            promote.restore(self.destination)

    def test_promote_preserves_tested_bytes_and_binds_inventory_to_merge(self):
        self.restore()
        result = promote.runtime.verify_artifact(self.destination, self.new)
        self.assertNotEqual(result["digest"], self.manifest["digest"])
        for name in ["services/rust/dispatch-backend", "dashboard/index.html"]:
            self.assertEqual((self.source / name).read_bytes(), (self.destination / name).read_bytes())
        self.assertTrue((self.destination / "services/rust/dispatch-backend").stat().st_mode & 0o100)

    def test_missing_expired_wrong_attempt_or_damaged_artifacts_cannot_promote(self):
        for change in [{"expired": True}, {"name": "dispatch-pr-build-17-1"},
                       {"digest": "sha256:" + "0" * 64}, {"size_in_bytes": 0}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.restore({**self.package(), **change})
            self.assertFalse(self.destination.exists())

    def test_source_metadata_inventory_and_run_races_are_checked(self):
        self.verified[1]["commit"] = "f" * 40
        with self.assertRaises(RuntimeError):
            self.restore()
        self.verified[1]["commit"] = self.old
        with self.assertRaises(RuntimeError):
            self.restore(validations=[self.verified, None])
        (self.source / "dashboard/index.html").write_text("tampered")
        with self.assertRaises(RuntimeError):
            self.restore()
        self.assertFalse(self.destination.exists())

    def test_release_merge_promotes_with_a_main_bound_validation(self):
        self.env["GITHUB_REF"] = "refs/heads/main"
        with patch.dict(promote.os.environ, self.env), \
                patch.object(promote.ci, "validated_receipt", return_value=self.verified) as validated:
            promote.require_validation(self.context)
            validated.assert_called_once_with(self.context, "main")
        self.restore()
        promote.runtime.verify_artifact(self.destination, self.new)

    def test_untrusted_or_unvalidated_runs_and_existing_output_are_rejected(self):
        for override in [{"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_REF": "refs/heads/release/v1.0.0"},
                         {"GITHUB_SHA": "f" * 40}]:
            original = self.env.copy()
            self.env.update(override)
            with self.assertRaises(RuntimeError):
                self.restore()
            self.env = original
        with self.assertRaises(RuntimeError):
            self.restore(validations=[None])
        self.destination.mkdir()
        (self.destination / "sentinel").write_text("preserve")
        with self.assertRaises(RuntimeError):
            self.restore()
        self.assertEqual((self.destination / "sentinel").read_text(), "preserve")

    def test_promoted_binary_only_warms_a_matching_compiler_and_source_cache(self):
        with patch.object(promote, "__file__", str(self.root / "tooling/ci-artifact.py")), \
                patch.object(promote.rust, "cache_eligible", return_value=True), \
                patch.object(promote.rust, "cache_key", return_value="e" * 64):
            promote.warm_rust_cache(self.source, {"rustKey": "f" * 64})
            self.assertFalse((self.root / ".ci-rust-cache").exists())
            promote.warm_rust_cache(self.source, {"rustKey": "e" * 64})
            entry = self.root / ".ci-rust-cache" / ("e" * 64)
            self.assertEqual(promote.rust.cached_binary(entry).read_bytes(),
                             (self.source / "services/rust/dispatch-backend").read_bytes())

    def test_revoked_validation_fails_instead_of_falling_back_to_skipped_tests(self):
        output = self.root / "outputs"
        with patch.dict(promote.os.environ, {"GITHUB_OUTPUT": str(output)}), \
                patch.object(promote, "restore", side_effect=promote.ValidationChanged("rerun failed")), \
                patch("sys.argv", ["ci-artifact.py"]), self.assertRaises(promote.ValidationChanged):
            promote.main()
        self.assertFalse(output.exists())

    def test_unavailable_reuse_explicitly_requests_the_normal_build(self):
        output = self.root / "outputs"
        with patch.dict(promote.os.environ, {"GITHUB_OUTPUT": str(output)}), \
                patch.object(promote, "restore", side_effect=RuntimeError("expired")), \
                patch.object(promote, "require_validation", return_value=self.verified), \
                patch("sys.argv", ["ci-artifact.py"]):
            promote.main()
        self.assertEqual(output.read_text(), "reused=false\n")


if __name__ == "__main__":
    unittest.main()
