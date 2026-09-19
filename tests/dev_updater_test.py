import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("update_dev", Path(__file__).parents[1] / "tooling/update-dev.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
import runtime_artifact as runtime

TOOLING = Path(__file__).parents[1] / "tooling"


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


class DevUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-dev-updater-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "dev"
        self.root.mkdir(mode=0o700)
        self.live = self.root
        for name in ["config", "data", "data/platform"]:
            (self.root / name).mkdir(mode=0o700)
        self.git("init", "-b", "dev")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("remote", "add", "origin", f"https://github.com/{updater.REPOSITORY}.git")
        (self.live / ".gitignore").write_text(".build/\n.runtime/\n")
        (self.live / "source.txt").write_text("old")
        self.git("add", ".")
        self.git("commit", "-m", "old")
        self.old = self.git("rev-parse", "HEAD")
        (self.live / "source.txt").write_text("new")
        self.git("commit", "-am", "new")
        self.new = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/remotes/origin/dev", self.new)
        self.git("reset", "--hard", self.old)
        (self.root / "config/updater.json").write_text(json.dumps({
            "service": "dispatch-dev.service", "healthUrl": "http://127.0.0.1:5180/api/health"}))
        self.instance = updater.DevUpdater(self.root)
        self.old_artifact = artifact(self.live / ".build", self.old, "old")
        self.candidate = self.instance.runtime / "candidate"
        self.manifest = artifact(self.candidate, self.new)
        (self.root / "data/private-sentinel").write_text("retained")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.live, text=True, stderr=subprocess.DEVNULL).strip()

    def test_activate_updates_code_and_checkout_preserving_state(self):
        actions = []
        with patch.object(self.instance, "service", side_effect=actions.append), \
                patch.object(self.instance, "healthy", return_value=True):
            self.instance.activate(self.candidate, self.new)
        self.assertEqual(actions, ["stop", "start"])
        self.assertEqual(self.git("rev-parse", "HEAD"), self.new)
        self.assertEqual(runtime.verify_artifact(self.live / ".build", self.new)["digest"], self.manifest["digest"])
        self.assertEqual((self.root / "data/private-sentinel").read_text(), "retained")
        self.assertFalse(self.instance.receipt.exists())

    def test_failed_health_restores_previous_runtime_and_checkout(self):
        with patch.object(self.instance, "service"), \
                patch.object(self.instance, "healthy", side_effect=[False, True]):
            with self.assertRaisesRegex(RuntimeError, "New Dev build"):
                self.instance.activate(self.candidate, self.new)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.old)
        self.assertEqual(runtime.verify_artifact(self.live / ".build", self.old)["digest"], self.old_artifact["digest"])
        self.assertEqual(json.loads(self.instance.status_file.read_text())["status"], "rolled_back")
        self.assertEqual((self.root / "data/private-sentinel").read_text(), "retained")

    def test_interrupt_after_rename_recovers_on_next_run(self):
        runtime.write_json(self.instance.receipt, {"commit": self.new, "oldCommit": self.old,
                           "oldDigest": self.old_artifact["digest"], "previous": "previous"})
        (self.live / ".build").rename(self.instance.runtime / "previous")
        with patch.object(self.instance, "service"), patch.object(self.instance, "healthy", return_value=True):
            self.instance.recover()
        runtime.verify_artifact(self.live / ".build", self.old)
        self.assertFalse(self.instance.receipt.exists())

    def test_dirty_checkout_is_never_overwritten(self):
        (self.live / "source.txt").write_text("unfinished")
        with patch.object(self.instance, "service") as service:
            with self.assertRaisesRegex(RuntimeError, "unfinished"):
                self.instance.activate(self.candidate, self.new)
            service.assert_not_called()
        self.assertEqual((self.live / "source.txt").read_text(), "unfinished")

    def test_failed_or_pending_checks_do_not_install(self):
        original = self.instance.git
        def git(*args):
            return "" if args[0] == "fetch" else original(*args)
        for status, conclusion in [("completed", "failure"), ("in_progress", None)]:
            with self.subTest(status=status), patch.object(self.instance, "git", side_effect=git), \
                    patch.object(self.instance, "activate") as activate, \
                    patch.object(updater, "github", return_value={"workflow_runs": [{
                        "id": 1, "head_sha": self.new, "head_branch": "dev", "event": "push",
                        "head_repository": {"full_name": updater.REPOSITORY},
                        "status": status, "conclusion": conclusion}]}):
                self.instance.update()
                activate.assert_not_called()
                self.assertEqual(self.git("rev-parse", "HEAD"), self.old)

    def test_inventory_rejects_changed_files_and_wrong_source(self):
        with self.assertRaisesRegex(RuntimeError, "another commit"):
            runtime.verify_artifact(self.candidate, self.old)
        (self.candidate / "services/rust/dispatch-backend").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            runtime.verify_artifact(self.candidate, self.new)

    def test_archive_rejects_traversal_links_and_duplicate_files(self):
        for number, mode in enumerate(["traversal", "link", "duplicate"]):
            with self.subTest(mode=mode):
                package = self.root / f"{number}.tar.gz"
                with tarfile.open(package, "w:gz") as bundle:
                    entry = tarfile.TarInfo("../outside" if mode == "traversal" else "dashboard/main.js")
                    if mode == "link":
                        entry.type, entry.linkname = tarfile.SYMTYPE, "/etc/passwd"
                    else:
                        entry.size = 4
                    bundle.addfile(entry, None if mode == "link" else io.BytesIO(b"test"))
                    if mode == "duplicate":
                        bundle.addfile(entry, io.BytesIO(b"test"))
                with self.assertRaises(RuntimeError):
                    runtime.unpack(package, self.root / f"unpacked-{number}")
        self.assertFalse((self.root / "outside").exists())

    def test_activate_restores_executable_bit_from_untrusted_archive_modes(self):
        (self.candidate / "services/rust/dispatch-backend").chmod(0o600)
        with patch.object(self.instance, "service"), patch.object(self.instance, "healthy", return_value=True):
            self.instance.activate(self.candidate, self.new)
        self.assertEqual((self.live / ".build/services/rust/dispatch-backend").stat().st_mode & 0o777, 0o700)

    def test_inventory_rejects_retired_runtime_files_even_with_valid_hashes(self):
        for number, (name, reason) in enumerate([("api/main.js", "outside managed code"),
                                                 ("node_modules/unused/index.js", "outside managed code"),
                                                 ("package.json", "outside managed code"),
                                                 ("services/runtime/main.js", "retired runtime files"),
                                                 ("tooling/cli.js", "retired runtime files")]):
            with self.subTest(name=name):
                candidate = self.instance.runtime / f"retired-{number}"
                artifact(candidate, self.new)
                target = candidate / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("retired Node runtime")
                manifest = json.loads((candidate / "release.json").read_text())
                manifest.pop("digest")
                manifest["files"].append({"path": name, "size": target.stat().st_size,
                                          "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
                manifest["digest"] = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
                (candidate / "release.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(RuntimeError, reason):
                    runtime.verify_artifact(candidate, self.new)
        (self.candidate / "shared").mkdir()
        with self.assertRaisesRegex(RuntimeError, "outside managed code"):
            runtime.verify_artifact(self.candidate, self.new)

    def test_retired_artifact_formats_are_rejected(self):
        for format in [1, 2]:
            manifest = dict(self.manifest, format=format)
            (self.candidate / "release.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, "Unsupported artifact format/schema"):
                runtime.verify_artifact(self.candidate, self.new)


    def test_private_state_is_ignored_even_with_an_old_gitignore(self):
        self.assertEqual(self.instance.live, self.root)
        self.instance.clean_checkout()
        (self.root / "dsps").mkdir()
        (self.root / "dsps/private.json").write_text("private")
        (self.root / ".platform.lock").touch()
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all"), "")
        self.assertEqual(self.git("ls-files", "--others", "--exclude-standard"), "")

    def test_update_cannot_overwrite_private_state_with_tracked_files(self):
        settings = (self.root / "config/updater.json").read_bytes()
        self.git("add", "-f", "config/updater.json")
        self.git("commit", "-m", "invalid tracked state")
        bad = self.git("rev-parse", "HEAD")
        self.git("reset", "--hard", self.old)
        (self.root / "config").mkdir(mode=0o700, exist_ok=True)
        (self.root / "config/updater.json").write_bytes(settings)
        candidate = self.instance.runtime / "bad"
        artifact(candidate, bad)
        with patch.object(self.instance, "service") as service:
            with self.assertRaisesRegex(RuntimeError, "private environment paths"):
                self.instance.activate(candidate, bad)
            service.assert_not_called()
        self.assertEqual(self.git("rev-parse", "HEAD"), self.old)
        self.assertEqual((self.root / "data/private-sentinel").read_text(), "retained")
        self.assertEqual((self.root / "config/updater.json").read_bytes(), settings)

    def test_installed_host_updater_survives_source_rollback(self):
        updater.install_management(self.live)
        script = self.live / ".runtime/management/update-dev.py"
        self.assertEqual(script.stat().st_mode & 0o777, 0o600)
        self.git("reset", "--hard", self.old)
        subprocess.run(["python3", str(script), "--root", str(self.root), "--verify"],
                       check=True, capture_output=True)

    def track_updater(self, change=""):
        """Commit the real host updater, as a dev merge that touches it would."""
        (self.live / "tooling").mkdir(exist_ok=True)
        for name in updater.MANAGEMENT:
            (self.live / "tooling" / name).write_text((TOOLING / name).read_text() + change)
        self.git("add", "tooling")
        self.git("commit", "-m", "host updater" + change)
        return self.git("rev-parse", "HEAD")

    def installed(self, name="update-dev.py"):
        return (self.live / ".runtime/management" / name).read_text()

    def test_activation_installs_the_updater_of_the_activated_checkout(self):
        current = self.track_updater()
        artifact(self.live / ".build.next", current, "current")
        shutil.rmtree(self.live / ".build")
        (self.live / ".build.next").rename(self.live / ".build")
        latest = self.track_updater("\n# Reviewed change\n")
        self.git("update-ref", "refs/remotes/origin/dev", latest)
        self.git("reset", "--hard", current)
        candidate = self.instance.runtime / "latest"
        manifest = artifact(candidate, latest)
        run = {"id": 1, "head_sha": latest, "head_branch": "dev", "event": "push", "status": "completed",
               "conclusion": "success", "head_repository": {"full_name": updater.REPOSITORY}}
        original = self.instance.git
        def git(*args):
            if args[0] == "fetch":
                # The installed copy was missing: every run first follows the active checkout.
                self.assertEqual(self.installed(), (TOOLING / "update-dev.py").read_text())
                return ""
            return original(*args)
        with patch.object(self.instance, "git", side_effect=git), patch.object(self.instance, "service"), \
                patch.object(self.instance, "healthy", return_value=True), \
                patch.object(updater, "github", side_effect=[{"workflow_runs": [run]}, {"artifacts": [
                    {"name": f"dispatch-dev-{latest}", "expired": False}]}]), \
                patch.object(updater, "download_run_artifact", return_value=(candidate, manifest)):
            self.instance.update()
        self.assertEqual(self.git("rev-parse", "HEAD"), latest)
        for name in updater.MANAGEMENT:
            self.assertEqual(self.installed(name), (self.live / "tooling" / name).read_text())
            self.assertEqual((self.live / ".runtime/management" / name).stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.installed().endswith("# Reviewed change\n"))
        self.assertEqual(updater.management_drift(self.live), [])
        self.assertFalse(list(self.instance.runtime.glob("management-*")), "Staging is removed")

    def test_failed_activation_keeps_the_updater_that_performs_the_recovery(self):
        current = self.track_updater()
        artifact(self.live / ".build.next", current, "current")
        shutil.rmtree(self.live / ".build")
        (self.live / ".build.next").rename(self.live / ".build")
        self.instance.refresh_management()
        latest = self.track_updater("\n# Change that fails its health check\n")
        self.git("update-ref", "refs/remotes/origin/dev", latest)
        self.git("reset", "--hard", current)
        candidate = self.instance.runtime / "latest"
        artifact(candidate, latest)
        with patch.object(self.instance, "service"), patch.object(self.instance, "healthy", side_effect=[False, True]), \
                self.assertRaisesRegex(RuntimeError, "New Dev build"):
            self.instance.activate(candidate, latest)
        self.assertEqual(self.installed(), (TOOLING / "update-dev.py").read_text())
        self.assertEqual(updater.management_drift(self.live), [])

    def test_updater_that_cannot_start_or_is_uncommitted_is_never_installed(self):
        self.track_updater()
        self.instance.refresh_management()
        working = self.installed()
        (self.live / "tooling/update-dev.py").write_text("import missing_host_module\n")
        self.git("commit", "-am", "broken updater")
        self.git("update-ref", "refs/remotes/origin/dev", "HEAD")
        with patch.object(self.instance, "git", side_effect=lambda *args: "" if args[0] == "fetch" else self.git(*args)), \
                patch.object(updater.sys, "stderr") as stderr:
            self.instance.update()
        self.assertIn("was not installed", "".join(call.args[0] for call in stderr.write.call_args_list))
        self.assertEqual(self.installed(), working)
        self.assertEqual(updater.management_drift(self.live), ["update-dev.py"])
        (self.live / "tooling/update-dev.py").write_text(working + "\n# Unreviewed edit\n")
        with self.assertRaisesRegex(RuntimeError, "unfinished"):
            self.instance.update()
        self.assertEqual(self.installed(), working)

    def activate_build(self, commit):
        artifact(self.live / ".build.next", commit, "current")
        shutil.rmtree(self.live / ".build")
        (self.live / ".build.next").rename(self.live / ".build")

    def unit(self, flag="--verify", script=None):
        """The check exactly as dispatch-dev.service runs it before every start."""
        script = script or self.live / ".runtime/management/update-dev.py"
        return subprocess.run(["python3", str(script), "--root", str(self.root), flag], capture_output=True,
                              text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    def start_like_the_unit(self, starts):
        def service(action):
            if action == "start":
                starts.append(self.unit())
                if starts[-1].returncode:
                    raise RuntimeError("ExecStartPre failed; the service did not start")
        return service

    def test_commit_that_changes_the_updater_still_starts_the_service_and_deploys(self):
        current = self.track_updater()
        self.activate_build(current)
        self.instance.refresh_management()
        self.assertEqual(self.unit("--verify-management").returncode, 0)
        latest = self.track_updater("\n# Reviewed change\n")
        self.git("update-ref", "refs/remotes/origin/dev", latest)
        self.git("reset", "--hard", current)
        candidate = self.instance.runtime / "latest"
        manifest = artifact(candidate, latest)
        run = {"id": 1, "head_sha": latest, "head_branch": "dev", "event": "push", "status": "completed",
               "conclusion": "success", "head_repository": {"full_name": updater.REPOSITORY}}
        starts = []
        with patch.object(self.instance, "git", side_effect=lambda *args: "" if args[0] == "fetch" else self.git(*args)), \
                patch.object(self.instance, "service", side_effect=self.start_like_the_unit(starts)), \
                patch.object(self.instance, "healthy", return_value=True), \
                patch.object(updater, "github", side_effect=[{"workflow_runs": [run]}, {"artifacts": [
                    {"name": f"dispatch-dev-{latest}", "expired": False}]}]), \
                patch.object(updater, "download_run_artifact", return_value=(candidate, manifest)):
            self.instance.update()
        # The start inside the activation saw the new checkout beside the previous installed updater.
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0].returncode, 0, starts[0].stderr)
        self.assertIn("differs from the checkout (runtime_artifact.py, update-dev.py)", starts[0].stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), latest)
        self.assertEqual(json.loads(self.instance.status_file.read_text())["status"], "ready")
        for name in updater.MANAGEMENT:
            self.assertEqual(self.installed(name), (self.live / "tooling" / name).read_text())
        self.assertTrue(self.installed().endswith("# Reviewed change\n"))
        self.assertEqual(self.unit("--verify-management").returncode, 0)

    def test_rollback_starts_the_service_whether_the_installed_updater_is_newer_or_older(self):
        current = self.track_updater()
        self.activate_build(current)
        latest = self.track_updater("\n# Change that fails its health check\n")
        self.git("update-ref", "refs/remotes/origin/dev", latest)
        self.git("reset", "--hard", current)
        for number, installed in enumerate(["\n# Newer copy installed by hand\n", "", None]):
            with self.subTest(installed=installed):
                updater.install_management(self.live, TOOLING)
                script = self.live / ".runtime/management/update-dev.py"
                if installed is None:
                    # An updater from before the shared module was installed beside it.
                    (self.live / ".runtime/management/runtime_artifact.py").write_text(
                        (TOOLING / "runtime_artifact.py").read_text() + "\n# Older installed copy\n")
                else:
                    script.write_text((TOOLING / "update-dev.py").read_text() + installed)
                before = self.installed()
                candidate = self.instance.runtime / f"failing-{number}"
                artifact(candidate, latest)
                starts = []
                with patch.object(self.instance, "service", side_effect=self.start_like_the_unit(starts)), \
                        patch.object(self.instance, "healthy", side_effect=[False, True]), \
                        self.assertRaisesRegex(RuntimeError, "New Dev build"):
                    self.instance.activate(candidate, latest)
                self.assertEqual([start.returncode for start in starts], [0, 0], [s.stderr for s in starts])
                self.assertEqual(self.git("rev-parse", "HEAD"), current)
                self.assertEqual(json.loads(self.instance.status_file.read_text())["status"], "rolled_back")
                self.assertEqual(self.installed(), before, "A failed activation never replaces the updater")

    def test_only_the_explicit_management_check_fails_on_a_differing_installed_updater(self):
        self.track_updater()
        self.activate_build(self.git("rev-parse", "HEAD"))
        checkout = self.live / "tooling/update-dev.py"
        for flag, code in [("--verify", 0), ("--verify-management", 1)]:
            missing = self.unit(flag, checkout)
            self.assertEqual(missing.returncode, code, missing.stderr)
            self.assertIn("runtime_artifact.py, update-dev.py", missing.stderr)
        self.assertIn("--install-management", missing.stderr)
        self.assertEqual(self.unit("--install-management", checkout).returncode, 0)
        for flag in ["--verify", "--verify-management"]:
            matching = self.unit(flag)
            self.assertEqual((matching.returncode, matching.stderr), (0, ""))
        (self.live / ".runtime/management/runtime_artifact.py").write_text(
            (TOOLING / "runtime_artifact.py").read_text() + "\n# Older installed copy\n")
        for flag, code in [("--verify", 0), ("--verify-management", 1)]:
            drifted = self.unit(flag)
            self.assertEqual(drifted.returncode, code, drifted.stderr)
            self.assertIn("differs from the checkout (runtime_artifact.py)", drifted.stderr)
        for name in ["dispatch-dev.service", "dispatch-dev-update.service", "dispatch-dev-checks.service"]:
            self.assertNotIn("--verify-management", (TOOLING / "systemd" / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
