import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "tooling/ci/pr-screenshots.py"
spec = importlib.util.spec_from_file_location("pr_screenshots", SOURCE)
shots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shots)

PNG = b"\x89PNG\r\n\x1a\n synthetic"


def git(*args, cwd, env=None):
    return subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=True,
                          env={**os.environ, **(env or {})}).stdout.strip()


class PrScreenshotsTests(unittest.TestCase):
    """A worktree with a bare origin, so publishing pushes to a local branch only."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.origin = base / "origin.git"
        git("init", "-q", "--bare", str(self.origin), cwd=base)
        self.root = base / "workspace/worktrees/pr-flow"
        self.root.mkdir(parents=True)
        identity = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        git("init", "-q", "-b", "pr-flow", cwd=self.root)
        git("remote", "add", "origin", str(self.origin), cwd=self.root)
        (self.root / "README").write_text("x")
        git("add", "README", cwd=self.root)
        git("commit", "-q", "-m", "start", cwd=self.root, env=identity)
        self.scratch = base / "scratch"
        self.review = base / "workspace/.privacy/export-review.json"
        self.review.parent.mkdir(parents=True)
        self.review.write_text(json.dumps({"assets": {}}))
        self.review.chmod(0o600)
        self.env = patch.dict(os.environ, {"DISPATCH_SCRATCH": str(self.scratch), **identity})
        self.env.start()
        self.addCleanup(self.env.stop)
        # The origin is a local bare repository; the links name the GitHub repository.
        named = patch.object(shots.Worktree, "repository", lambda self: "example/platform")
        named.start()
        self.addCleanup(named.stop)
        self.tree = shots.Worktree(self.root)

    def capture(self, label, *names):
        directory = self.scratch / "screenshots" / label
        directory.mkdir(parents=True, exist_ok=True)
        for name in names:
            (directory / f"{name}.png").write_bytes(PNG + name.encode() + label.encode())
        (directory / "index.json").write_text(json.dumps({"team": "Team & Roles"}))

    def branch_files(self):
        commit = git("rev-parse", "refs/heads/screenshots", cwd=self.origin)
        return commit, git("ls-tree", "-r", "--name-only", commit, cwd=self.origin).splitlines()

    def test_section_pairs_before_and_after_and_shows_a_new_screen_alone(self):
        captured = [("before", "team.png", None), ("after", "team.png", None), ("after", "dsps.png", None)]
        text = shots.section("example/platform", "abc123", "pr-flow", captured, {"team": "Team & Roles"})
        self.assertEqual(text.splitlines(), [
            "## Screenshots", "",
            "Team & Roles, before and after",
            "![Team & Roles before](https://raw.githubusercontent.com/example/platform/abc123/pr-flow/before/team.png)",
            "![Team & Roles after](https://raw.githubusercontent.com/example/platform/abc123/pr-flow/after/team.png)",
            "",
            "Dsps, new",
            "![Dsps after](https://raw.githubusercontent.com/example/platform/abc123/pr-flow/after/dsps.png)",
        ])

    def test_publish_stops_until_the_images_are_reviewed_then_records_and_pushes(self):
        self.capture("before", "team")
        self.capture("after", "team")
        calls = []

        def auditor(tree, staged, review_file, tesseract):
            calls.append(sorted(p.relative_to(staged).as_posix() for p in staged.rglob("*.png")))
            approved = json.loads(review_file.read_text())["assets"]
            return {name: {shots.NEEDS_REVIEW} for name in
                    ["screenshots/pr-flow/before/team.png", "screenshots/pr-flow/after/team.png"]
                    if name not in approved}

        with self.assertRaises(SystemExit) as stop:
            shots.publish(self.tree, False, self.review, None, auditor=auditor)
        self.assertIn("--reviewed", str(stop.exception))
        self.assertIn(str(self.scratch / "screenshots/after/team.png"), str(stop.exception))
        self.assertFalse(git("ls-remote", "--heads", str(self.origin), "screenshots", cwd=self.root))

        with patch("sys.stdout"):
            commit = shots.publish(self.tree, True, self.review, None, auditor=auditor)
        self.assertEqual(calls[0], ["screenshots/pr-flow/after/team.png", "screenshots/pr-flow/before/team.png"])
        manifest = json.loads(self.review.read_text())
        self.assertEqual(sorted(manifest["assets"]),
                         ["screenshots/pr-flow/after/team.png", "screenshots/pr-flow/before/team.png"])
        self.assertEqual(self.review.stat().st_mode & 0o777, 0o600)
        pushed, names = self.branch_files()
        self.assertEqual(pushed, commit)
        self.assertEqual(names, ["pr-flow/after/team.png", "pr-flow/before/team.png"])
        text = (self.scratch / "screenshots/section.md").read_text()
        self.assertIn(f"https://raw.githubusercontent.com/example/platform/{commit}/pr-flow/after/team.png", text)
        self.assertIn("Team & Roles, before and after", text)

    def test_republishing_replaces_this_branch_and_keeps_other_branches(self):
        self.capture("after", "team", "dsps")
        clean = lambda tree, staged, review, tesseract: {}
        with patch("sys.stdout"):
            first = shots.publish(self.tree, False, self.review, None, auditor=clean)
        # Another PR's directory on the branch, then this branch republished with fewer files.
        other = shots.Worktree(self.root)
        other.branch = "other-pr"
        with patch("sys.stdout"):
            shots.publish(other, False, self.review, None, auditor=clean)
        (self.scratch / "screenshots/after/dsps.png").unlink()
        with patch("sys.stdout"):
            third = shots.publish(self.tree, False, self.review, None, auditor=clean)
        commit, names = self.branch_files()
        self.assertEqual(commit, third)
        self.assertEqual(names, ["other-pr/after/dsps.png", "other-pr/after/team.png", "pr-flow/after/team.png"])
        self.assertEqual(git("rev-parse", f"{third}~2", cwd=self.origin), first)

    def test_other_findings_stop_publishing_without_printing_values(self):
        self.capture("after", "team")
        auditor = lambda tree, staged, review, tesseract: {
            "screenshots/pr-flow/after/team.png": {"ocr:known-private-identity", shots.NEEDS_REVIEW}}
        with self.assertRaises(SystemExit) as stop:
            shots.publish(self.tree, True, self.review, None, auditor=auditor)
        self.assertIn("ocr:known-private-identity", str(stop.exception))
        self.assertEqual(json.loads(self.review.read_text())["assets"], {})

    def test_publishing_from_main_is_refused(self):
        self.tree.branch = "main"
        with self.assertRaises(SystemExit):
            shots.publish(self.tree, True, self.review, None, auditor=lambda *a: {})


if __name__ == "__main__":
    unittest.main()
