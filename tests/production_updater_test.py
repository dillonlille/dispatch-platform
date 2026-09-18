import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from dev_updater_test import artifact

spec = importlib.util.spec_from_file_location("production", Path(__file__).parents[1] / "tooling/update-production.py")
production = importlib.util.module_from_spec(spec)
spec.loader.exec_module(production)


def stable_artifact(root, commit, version):
    manifest = artifact(root, commit)
    manifest.pop("digest")
    manifest["version"] = version
    manifest["digest"] = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
    (root / "release.json").write_text(json.dumps(manifest))
    return manifest


class ProductionUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-production-updater-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "public"
        self.root.mkdir(mode=0o700)
        (self.root / "config").mkdir(mode=0o700)
        (self.root / "config/updater.json").write_text(json.dumps({
            "service": "dispatch-production.service", "healthUrl": "http://127.0.0.1:5180/api/health"}))
        self.instance = production.ProductionUpdater(self.root)
        self.old = stable_artifact(self.instance.live, "a" * 40, "0.0.3")
        self.candidate = self.instance.runtime / "candidate"
        self.new = stable_artifact(self.candidate, "b" * 40, "0.0.4")
        (self.root / "data/private-state").write_text("preserved")
        self.release = {"id": 123, "tag_name": "v0.0.4", "draft": False, "prerelease": False,
                        "published_at": "2026-09-18T00:00:00Z", "assets": []}

    def test_upgrade_retains_state_and_previous_runtime(self):
        with patch.object(self.instance, "service") as service, \
                patch.object(self.instance, "healthy", return_value=True):
            self.instance.activate(self.candidate, "b" * 40)
        self.assertEqual([c.args[0] for c in service.call_args_list], ["stop", "start"])
        self.assertEqual(production.verify_artifact(self.instance.live), self.new)
        self.assertEqual(production.verify_artifact(self.instance.previous), self.old)
        self.assertEqual((self.root / "data/private-state").read_text(), "preserved")
        self.assertFalse(self.instance.receipt.exists())

    def test_failed_start_rolls_back_without_replacing_private_state(self):
        with patch.object(self.instance, "service"), \
                patch.object(self.instance, "healthy", side_effect=[False, True]):
            with self.assertRaisesRegex(RuntimeError, "New Production runtime"):
                self.instance.activate(self.candidate, "b" * 40)
        self.assertEqual(production.verify_artifact(self.instance.live), self.old)
        self.assertEqual((self.root / "data/private-state").read_text(), "preserved")
        self.assertEqual(json.loads(self.instance.status_file.read_text())["status"], "rolled_back")

    def test_interrupted_activation_recovers_before_checking_releases(self):
        production.write_json(self.instance.receipt, {
            "oldDigest": self.old["digest"], "newDigest": self.new["digest"]})
        self.instance.live.rename(self.instance.previous)
        with patch.object(self.instance, "service"), patch.object(self.instance, "healthy", return_value=True):
            self.instance.recover()
        self.assertEqual(production.verify_artifact(self.instance.live), self.old)
        self.assertFalse(self.instance.receipt.exists())

    def test_drafts_prereleases_and_non_versions_never_stop_service(self):
        for change in ({"draft": True}, {"prerelease": True}, {"published_at": None},
                       {"tag_name": "v0.0.4-rc.1"}, {"tag_name": "v00.0.4"}):
            with self.subTest(change=change), patch.object(production, "github", return_value=self.release | change), \
                    patch.object(self.instance, "service") as service:
                with self.assertRaises(RuntimeError):
                    self.instance.update()
                service.assert_not_called()

    def test_older_and_current_releases_do_not_download_or_restart(self):
        for tag in ("v0.0.2", "v0.0.3"):
            with patch.object(production, "github", return_value=self.release | {"tag_name": tag}), \
                    patch.object(production, "download_asset") as download, \
                    patch.object(self.instance, "healthy", return_value=True), \
                    patch.object(self.instance, "service") as service:
                self.instance.update()
                download.assert_not_called()
                service.assert_not_called()

    def test_first_published_install_records_health_and_source_for_dashboard(self):
        with patch.object(production, "github", return_value=self.release | {"tag_name": "v0.0.3"}), \
                patch.object(self.instance, "healthy", return_value=True):
            self.instance.update()
        status = json.loads(self.instance.status_file.read_text())
        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["commit"], "a" * 40)
        self.assertEqual(status["digest"], self.old["digest"])

    def test_same_version_cannot_replace_installed_runtime(self):
        self.new = self.old
        with patch.object(self.instance, "service") as service:
            with self.assertRaisesRegex(RuntimeError, "downgrade/replacement"):
                self.instance.activate(self.instance.live, "a" * 40)
            service.assert_not_called()

    def test_tag_outside_main_is_rejected(self):
        with patch.object(production, "github", side_effect=[
            {"object": {"type": "commit", "sha": "b" * 40}}, {"status": "diverged"},
        ]):
            with self.assertRaisesRegex(RuntimeError, "not part of main"):
                production.release_commit("v0.0.4")

    def test_asset_digest_and_size_are_enforced(self):
        data = b"release artifact"
        name = "release.json"
        asset = {"name": name, "state": "uploaded", "size": len(data),
                 "browser_download_url": f"https://github.com/{production.REPOSITORY}/releases/download/v0.0.4/{name}",
                 "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
        with patch.object(production.urllib.request, "urlopen", return_value=io.BytesIO(data)):
            production.download_asset(self.release | {"assets": [asset]}, name, self.root / "valid")
        with patch.object(production.urllib.request, "urlopen", return_value=io.BytesIO(b"X" * len(data))):
            with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
                production.download_asset(self.release | {"assets": [asset]}, name, self.root / "invalid")

    def test_published_inventory_and_source_must_match(self):
        def download(release, name, target):
            if name.endswith(".tar.gz"):
                with tarfile.open(target, "w:gz") as bundle:
                    bundle.add(self.candidate, arcname=".")
            else:
                target.write_text(json.dumps(self.old))
        with patch.object(production, "github", return_value=self.release), \
                patch.object(production, "release_commit", return_value="b" * 40), \
                patch.object(production, "download_asset", side_effect=download), \
                patch.object(self.instance, "service") as service:
            with self.assertRaisesRegex(RuntimeError, "inventory differs"):
                self.instance.update()
            service.assert_not_called()

    def test_failed_release_is_not_retried_every_timer_tick(self):
        production.write_json(self.instance.status_file, {"status": "rolled_back", "failedReleaseId": 123})
        with patch.object(production, "github", return_value=self.release), \
                patch.object(production, "download_asset") as download:
            self.instance.update()
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
