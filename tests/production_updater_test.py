import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from dev_updater_test import artifact, runtime

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

    def test_service_health_and_lock_are_the_production_ones(self):
        with patch.object(runtime, "command") as command:
            self.instance.service("stop")
        command.assert_called_once_with("systemctl", "--user", "stop", "dispatch-production.service", timeout=90)
        ready = {"status": "ready", "environment": "production", "release": "digest", "runtime": "rust"}
        for answer, healthy in [(ready, True), (ready | {"environment": "preview"}, False),
                                (ready | {"runtime": "node"}, False), (ready | {"release": "other"}, False),
                                ({key: value for key, value in ready.items() if key != "runtime"}, False)]:
            with self.subTest(answer=answer), patch.object(runtime.time, "sleep"), \
                    patch.object(runtime.urllib.request, "urlopen",
                                 side_effect=lambda *_args, **_kwargs: io.BytesIO(json.dumps(answer).encode())):
                self.assertEqual(self.instance.healthy("digest", timeout=0.05), healthy)
        with patch.object(self.instance, "update") as update:
            with (self.instance.platform / "production-update.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                self.instance.run_locked()
                update.assert_not_called()
            self.instance.run_locked()
        update.assert_called_once_with()

    def test_activation_and_rollback_keep_their_order(self):
        steps = []
        with patch.object(self.instance, "service", side_effect=steps.append), \
                patch.object(self.instance, "healthy", side_effect=lambda digest: steps.append(digest) or len(steps) > 3):
            with self.assertRaisesRegex(RuntimeError, "New Production runtime"):
                self.instance.activate(self.candidate, "b" * 40)
        self.assertEqual(steps, ["stop", "start", self.new["digest"], "stop", "start", self.old["digest"]])
        self.assertEqual((self.instance.live / "services/rust/dispatch-backend").stat().st_mode & 0o777, 0o700)

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

    def test_settled_check_skips_the_api_until_the_tag_runtime_or_age_changes(self):
        current = self.release | {"tag_name": "v0.0.3"}
        with patch.object(production, "github", return_value=current) as api, \
                patch.object(production, "latest_tag", return_value="v0.0.3") as hint, \
                patch.object(self.instance, "healthy", return_value=True):
            self.instance.update()
            hint.assert_not_called()
            self.instance.update()
            self.assertEqual(api.call_count, 1)
            for tag in ("v0.0.4", None):
                hint.return_value = tag
                self.instance.update()
            self.assertEqual(api.call_count, 3)
            hint.return_value = "v0.0.3"
            check = json.loads(self.instance.check_file.read_text())
            for change in ({"checkedAt": check["checkedAt"] - production.FULL_CHECK_SECONDS},
                           {"checkedAt": check["checkedAt"] + 3600}, {"digest": "0" * 64}, {"tag": None}):
                production.write_json(self.instance.check_file, check | change)
                self.instance.update()
            self.assertEqual(api.call_count, 7)
            self.instance.check_file.write_text("damaged")
            self.instance.update()
            self.assertEqual(api.call_count, 8)

    def test_hint_never_installs_and_an_unfinished_update_is_checked_again(self):
        with patch.object(production, "github", return_value=self.release), \
                patch.object(production, "release_commit", return_value="b" * 40), \
                patch.object(production, "download_asset", side_effect=OSError("offline")), \
                patch.object(production, "latest_tag", return_value="v0.0.4") as hint:
            for _ in range(2):
                with self.assertRaises(OSError):
                    self.instance.update()
            hint.assert_not_called()
        self.assertFalse(self.instance.check_file.exists())

    def test_latest_tag_reads_only_the_expected_public_redirect(self):
        def response(code, location):
            headers = {"Location": location} if location else {}
            return production.urllib.error.HTTPError(production.RELEASES + "latest", code, "", headers, None)
        opener = production.urllib.request.build_opener
        for error, expected in [(response(302, production.RELEASES + "tag/v0.0.4"), "v0.0.4"),
                                (response(302, "https://example.invalid/releases/tag/v9.9.9"), None),
                                (response(404, production.RELEASES + "tag/v0.0.4"), None),
                                (response(302, None), None), (OSError("offline"), None)]:
            with self.subTest(error=error), patch.object(production.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = error
                self.assertEqual(production.latest_tag(), expected)
        self.assertIs(production.urllib.request.build_opener, opener)

    def test_failed_release_is_not_retried_every_timer_tick(self):
        production.write_json(self.instance.status_file, {"status": "rolled_back", "failedReleaseId": 123})
        with patch.object(production, "github", return_value=self.release), \
                patch.object(production, "download_asset") as download:
            self.instance.update()
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
