import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "tooling/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-release-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = {"id": 5, "run_attempt": 1, "head_sha": "a" * 40, "event": "push", "head_branch": "main",
                    "status": "completed", "conclusion": "success", "html_url": "https://example.invalid/5",
                    "head_repository": {"full_name": release.REPOSITORY}}

    def test_default_is_the_next_patch_and_requested_bumps_reset_lower_parts(self):
        self.assertEqual(release.next_version("0.0.9"), "0.0.10")
        self.assertEqual(release.next_version("1.4.9", "minor"), "1.5.0")
        self.assertEqual(release.next_version("1.4.9", "major"), "2.0.0")
        self.assertTrue(release.newer("0.0.10", "0.0.9"))
        self.assertFalse(release.newer("0.0.9", "0.0.9"))
        with self.assertRaises(RuntimeError):
            release.next_version("0.1.0-dev.0")

    def test_version_commit_changes_only_the_platform_fields_of_the_real_files(self):
        for name in release.VERSIONED:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_bytes((ROOT / name).read_bytes())
        release.set_versions(self.root, "9.8.7")
        self.assertEqual(release.current_version(self.root), "9.8.7")
        for name, changed in zip(release.VERSIONED, (1, 2, 1, 1)):
            before, after = (ROOT / name).read_text().splitlines(), (self.root / name).read_text().splitlines()
            self.assertEqual(len(before), len(after))
            different = [new for old, new in zip(before, after) if old != new]
            self.assertEqual(len(different), changed, name)
            self.assertTrue(all("9.8.7" in line for line in different), name)
        (self.root / "Cargo.lock").write_text("[[package]]\nname = \"other\"\nversion = \"1.0.0\"\n")
        with self.assertRaises(RuntimeError):
            release.set_versions(self.root, "9.8.8")

    def test_release_notes_source_lists_each_merged_dev_pr(self):
        log = ("Merge pull request #76 from dillonlille/fix/a\n\nDelete a member's account\n\x1e\n"
               "Merge dev after the fix\n\n\x1e\nMerge pull request #74 from dillonlille/fix/b\n\x1e")
        self.assertEqual(release.merged_changes(log), ["- #76 Delete a member's account", "- #74"])

    def test_newer_failed_or_pending_run_replaces_success_and_skipped_runs_are_ignored(self):
        runs = [self.run, {**self.run, "id": 6, "conclusion": "skipped"},
                {**self.run, "id": 7, "head_sha": "b" * 40}, {**self.run, "id": 8, "event": "pull_request"},
                {**self.run, "id": 9, "head_branch": "dev"},
                {**self.run, "id": 10, "head_repository": {"full_name": "fork/repo"}}]
        self.assertEqual(release.latest_run(runs, "a" * 40, "push", "main")["id"], 5)
        runs.append({**self.run, "id": 11, "status": "in_progress", "conclusion": None})
        self.assertEqual(release.latest_run(runs, "a" * 40, "push", "main")["id"], 11)
        self.assertIsNone(release.latest_run(runs, "c" * 40, "push", "main"))

    def test_failed_checks_stop_the_release(self):
        with patch.object(release, "github", return_value={"workflow_runs": [{**self.run, "conclusion": "failure"}]}), \
                patch.object(release, "say"), self.assertRaises(RuntimeError):
            release.wait_for_checks("a" * 40, "push", "main")
        with patch.object(release, "github", return_value={"workflow_runs": [self.run]}), patch.object(release, "say"):
            self.assertEqual(release.wait_for_checks("a" * 40, "push", "main")["id"], 5)

    def test_draft_assets_must_match_the_prepared_bytes_exactly(self):
        names = ("dispatch-platform-1.0.0.tar.gz", *release.ASSETS)
        assets = []
        for name in names:
            (self.root / name).write_text(name)
            assets.append({"name": name, "state": "uploaded", "size": len(name),
                           "digest": "sha256:" + hashlib.sha256(name.encode()).hexdigest()})
        self.assertEqual(release.asset_problems({"assets": assets}, self.root, names), [])
        for change in ({"digest": "sha256:" + "0" * 64}, {"size": 1}, {"state": "starter"}, {"digest": None}):
            with self.subTest(change=change):
                damaged = [assets[0] | change, *assets[1:]]
                self.assertEqual(len(release.asset_problems({"assets": damaged}, self.root, names)), 1)
        self.assertEqual(len(release.asset_problems({"assets": assets[1:]}, self.root, names)), 1)
        extra = [*assets, {**assets[0], "name": "extra.txt"}]
        self.assertEqual(release.asset_problems({"assets": extra}, self.root, names), ["unexpected asset extra.txt"])

    def test_new_draft_is_awaited_verified_and_only_then_published(self):
        item = release.Release("1.0.0", "origin/dev", None, self.root)
        item.output.mkdir(parents=True, mode=0o700)
        item.notes.write_text("Notes\n")
        names = (item.archive, *release.ASSETS)
        assets = []
        for name in names:
            (item.output / name).write_text(name)
            assets.append({"name": name, "state": "uploaded", "size": len(name),
                           "digest": "sha256:" + hashlib.sha256(name.encode()).hexdigest()})
        draft = {"id": 9, "tag_name": "v1.0.0", "draft": True, "prerelease": False,
                 "target_commitish": "a" * 40, "assets": assets}
        # The listing misses the draft at first, as GitHub did for v0.0.7.
        with patch.object(item, "published", side_effect=[None, None, draft, draft | {"draft": False}]), \
                patch.object(release, "command") as command, patch.object(release, "github") as api, \
                patch.object(release.time, "sleep"):
            self.assertFalse(item.publish("a" * 40)["draft"])
            self.assertIn("--draft", command.call_args.args)
            api.assert_called_once()
        damaged = draft | {"assets": [assets[0] | {"digest": "sha256:" + "0" * 64}, *assets[1:]]}
        for listed in (damaged, draft | {"target_commitish": "b" * 40}):
            with patch.object(item, "published", return_value=listed), patch.object(release, "github") as api, \
                    self.assertRaises(RuntimeError):
                item.publish("a" * 40)
            api.assert_not_called()

    def test_bare_rerun_continues_the_single_unfinished_release(self):
        def state(pulls, releases):
            return patch.object(release, "command", return_value=json.dumps(pulls)), \
                patch.object(release, "github", return_value=releases)
        cases = [([{"headRefName": "release/v0.0.7"}], [{"tag_name": "v0.0.7", "draft": True}], "0.0.7"),
                 ([{"headRefName": "fix/other"}], [{"tag_name": "v0.0.6", "draft": False}], None),
                 ([], [{"tag_name": "v0.0.8", "draft": True}], "0.0.8")]
        for pulls, releases, expected in cases:
            first, second = state(pulls, releases)
            with first, second:
                self.assertEqual(release.unfinished(), expected)
        first, second = state([{"headRefName": "release/v0.0.7"}], [{"tag_name": "v0.0.8", "draft": True}])
        with first, second, self.assertRaises(RuntimeError):
            release.unfinished()

    def test_release_branch_is_the_dev_commit_plus_main_and_a_stopped_merge_is_reported(self):
        def git(*args, cwd=self.root / "origin"):
            return subprocess.check_output(["git", "-C", str(cwd), *args], stderr=subprocess.DEVNULL, text=True).strip()
        origin = self.root / "origin"
        origin.mkdir()
        git("init", "-b", "main")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "user.name", "Fixture")
        (origin / "app.txt").write_text("base\n")
        git("add", ".")
        git("commit", "-m", "base")
        git("branch", "dev")
        (origin / "release-only.txt").write_text("fix made while releasing\n")
        git("add", ".")
        git("commit", "-m", "release fix")
        clone = self.root / "clone"
        subprocess.run(["git", "clone", "-q", str(origin), str(clone)], check=True)
        git("config", "user.email", "fixture@example.invalid", cwd=clone)
        git("config", "user.name", "Fixture", cwd=clone)
        with patch.object(release, "ROOT", clone):
            item = release.Release("1.0.0", "origin/dev", None, self.root / "releases")
            worktree = self.root / "sync"
            item.checkout(worktree, "chore/sync", "origin/dev")
            item.merge_main(worktree, "Bring main into dev")
            self.assertTrue((worktree / "release-only.txt").exists())
            before = git("rev-parse", "HEAD", cwd=worktree)
            item.merge_main(worktree, "Bring main into dev")
            self.assertEqual(git("rev-parse", "HEAD", cwd=worktree), before)
            (worktree / "unfinished.txt").write_text("keep")
            with self.assertRaises(RuntimeError):
                item.checkout(worktree, "chore/sync", "origin/dev")
            self.assertEqual((worktree / "unfinished.txt").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
