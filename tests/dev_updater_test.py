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


def artifact(root, commit, marker="candidate", rust=False, schema=None, rust_only=False):
    rust = rust or rust_only
    root.mkdir(mode=0o700, parents=True)
    contents = {
        ("services/rust/dispatch-backend" if rust else "api/main.js"): marker, "dashboard/index.html": "<h1>Dispatch</h1>",
        "package.json": '{"type":"module"}',
        "tooling/build-info.json": json.dumps({"commit": commit}),
    }
    if rust_only:
        contents.pop("package.json")
    if rust and not rust_only:
        contents.update({"services/runtime/auth-worker.js": "worker", "services/runtime/collection-worker.js": "worker"})
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
    manifest = ({"format": 2, "version": "0.1.0-dev.0", "runtime": "rust", "workerNodeMajor": 22, "schema": 3, "files": files} if rust else
                {"format": 1, "version": "0.1.0-dev.0", "nodeMajor": 22, "schema": schema or 1, "files": files})
    if rust_only:
        manifest["format"] = 3
        manifest.pop("workerNodeMajor")
    manifest["digest"] = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
    (root / "release.json").write_text(json.dumps(manifest))
    return manifest


class DevUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-dev-updater-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "dev"
        self.root.mkdir(mode=0o700)
        self.live = self.root / "live"
        self.live.mkdir(mode=0o700)
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
        self.assertEqual(updater.verify_artifact(self.live / ".build", self.new)["digest"], self.manifest["digest"])
        self.assertEqual((self.root / "data/private-sentinel").read_text(), "retained")
        self.assertFalse(self.instance.receipt.exists())

    def test_failed_health_restores_previous_runtime_and_checkout(self):
        with patch.object(self.instance, "service"), \
                patch.object(self.instance, "healthy", side_effect=[False, True]):
            with self.assertRaisesRegex(RuntimeError, "New Dev build"):
                self.instance.activate(self.candidate, self.new)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.old)
        self.assertEqual(updater.verify_artifact(self.live / ".build", self.old)["digest"], self.old_artifact["digest"])
        self.assertEqual(json.loads(self.instance.status_file.read_text())["status"], "rolled_back")
        self.assertEqual((self.root / "data/private-sentinel").read_text(), "retained")

    def test_interrupt_after_rename_recovers_on_next_run(self):
        updater.write_json(self.instance.receipt, {"commit": self.new, "oldCommit": self.old,
                           "oldDigest": self.old_artifact["digest"], "previous": "previous"})
        (self.live / ".build").rename(self.instance.runtime / "previous")
        with patch.object(self.instance, "service"), patch.object(self.instance, "healthy", return_value=True):
            self.instance.recover()
        updater.verify_artifact(self.live / ".build", self.old)
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
            updater.verify_artifact(self.candidate, self.old)
        (self.candidate / "api/main.js").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            updater.verify_artifact(self.candidate, self.new)

    def test_archive_rejects_traversal_links_and_duplicate_files(self):
        for number, mode in enumerate(["traversal", "link", "duplicate"]):
            with self.subTest(mode=mode):
                package = self.root / f"{number}.tar.gz"
                with tarfile.open(package, "w:gz") as bundle:
                    entry = tarfile.TarInfo("../outside" if mode == "traversal" else "api/main.js")
                    if mode == "link":
                        entry.type, entry.linkname = tarfile.SYMTYPE, "/etc/passwd"
                    else:
                        entry.size = 4
                    bundle.addfile(entry, None if mode == "link" else io.BytesIO(b"test"))
                    if mode == "duplicate":
                        bundle.addfile(entry, io.BytesIO(b"test"))
                with self.assertRaises(RuntimeError):
                    updater.unpack(package, self.root / f"unpacked-{number}")
        self.assertFalse((self.root / "outside").exists())


class RustDevUpdaterTests(DevUpdaterTests):
    def setUp(self):
        super().setUp()
        shutil.rmtree(self.live / ".build")
        shutil.rmtree(self.candidate)
        self.old_artifact = artifact(self.live / ".build", self.old, "old Rust", rust=True)
        self.manifest = artifact(self.candidate, self.new, "new Rust", rust=True)

    def test_inventory_rejects_changed_files_and_wrong_source(self):
        with self.assertRaisesRegex(RuntimeError, "another commit"):
            updater.verify_artifact(self.candidate, self.old)
        (self.candidate / "services/rust/dispatch-backend").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            updater.verify_artifact(self.candidate, self.new)

    def test_activate_restores_executable_bit_from_untrusted_archive_modes(self):
        (self.candidate / "services/rust/dispatch-backend").chmod(0o600)
        with patch.object(self.instance, "service"), patch.object(self.instance, "healthy", return_value=True):
            self.instance.activate(self.candidate, self.new)
        self.assertEqual((self.live / ".build/services/rust/dispatch-backend").stat().st_mode & 0o777, 0o700)

    def test_rust_inventory_rejects_retired_core_even_with_valid_hash(self):
        target = self.candidate / "api/main.js"
        target.parent.mkdir()
        target.write_text("retired Node core")
        manifest = json.loads((self.candidate / "release.json").read_text())
        manifest.pop("digest")
        manifest["files"].append({"path": "api/main.js", "size": target.stat().st_size,
                                  "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
        manifest["digest"] = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        (self.candidate / "release.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "retired Node core"):
            updater.verify_artifact(self.candidate, self.new)


class RustOnlyTransitionTests(RustDevUpdaterTests):
    """Exercise activation and rollback from deployed format 2 to format 3."""
    def setUp(self):
        super().setUp()
        shutil.rmtree(self.candidate)
        self.manifest = artifact(self.candidate, self.new, "Rust only", rust_only=True)

    def test_runtime_payload_is_rejected_even_with_valid_inventory(self):
        target = self.candidate / "node_modules/unused/index.js"
        target.parent.mkdir(parents=True)
        target.write_text("unused runtime")
        manifest = json.loads((self.candidate / "release.json").read_text())
        manifest.pop("digest")
        manifest["files"].append({"path": "node_modules/unused/index.js", "size": target.stat().st_size,
                                  "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
        manifest["digest"] = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        (self.candidate / "release.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "retired runtime files"):
            updater.verify_artifact(self.candidate, self.new)


class RustOnlyUpdaterTests(RustOnlyTransitionTests):
    """Once upgraded, future format-3 updates keep the same recovery guarantees."""
    def setUp(self):
        super().setUp()
        shutil.rmtree(self.live / ".build")
        self.old_artifact = artifact(self.live / ".build", self.old, "previous Rust only", rust_only=True)


if __name__ == "__main__":
    unittest.main()
