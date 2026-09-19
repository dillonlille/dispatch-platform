import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("ci_plan", Path(__file__).parents[1] / "tooling/ci-plan.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class CiPlanTests(unittest.TestCase):
    def setUp(self):
        self.context = {"base": "a" * 40, "head": "b" * 40, "tree": "c" * 40, "commit": "d" * 40}
        self.run = {"id": 17, "run_attempt": 2, "head_sha": self.context["head"],
                    "event": "pull_request", "status": "completed", "conclusion": "success",
                    "path": ci.WORKFLOW, "head_repository": {"full_name": ci.REPOSITORY}}
        self.receipt = {"format": 1, "repository": ci.REPOSITORY, "workflow": ci.WORKFLOW,
                        "baseRef": "dev", "runId": 17, "attempt": 2, "scope": "full", **self.context}
        self.event = {"pull_request": {
            "base": {"ref": "dev", "sha": self.context["base"], "repo": {"full_name": ci.REPOSITORY}},
            "head": {"sha": self.context["head"], "repo": {"full_name": ci.REPOSITORY}}}}

    def archive(self, value=None, filename="validation.json"):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as bundle:
            bundle.writestr(filename, json.dumps(self.receipt if value is None else value))
        data = output.getvalue()
        return data, "sha256:" + hashlib.sha256(data).hexdigest()

    def test_dashboard_scope_is_conservative(self):
        for paths in [["dashboard/src/styles.css", "dashboard/src/archive/styles.css"],
                      ["dashboard/src/main.tsx"],
                      ["dashboard/src/meal-breaks.tsx", "shared/meal-breaks.ts", "tests/meal-breaks.test.ts"],
                      ["tests/browser/meal-breaks.spec.ts"],
                      ["dashboard/src/lib/format.ts", "tests/dashboard-format.test.ts"],
                      ["tests/dashboard-structure.test.ts", "tests/collection-history.test.ts"]]:
            with self.subTest(paths=paths):
                self.assertEqual(ci.scope(paths), "dashboard")
        # A test file counts as dashboard-only exactly when the dashboard build check runs it.
        plan = json.loads((Path(__file__).parents[1] / "tooling/test-plan.json").read_text())
        self.assertEqual(sorted(ci.DASHBOARD_TESTS), sorted(plan["dashboard"]))
        self.assertIn("...dashboardTests", (Path(__file__).parents[1] / "tooling/checks.ts").read_text())
        for file in plan["dashboard"]:
            self.assertEqual(ci.scope([file]), "dashboard", file)
        for paths in [[], ["README.md"], ["styles.css"], ["dashboard/vite.config.ts"],
                      ["shared/contracts/index.ts"], ["shared/paycom.ts"], ["shared/new-helper.ts"],
                      ["tests/support.ts"], ["tests/api-auth.test.ts"], ["backend/src/main.rs"],
                      ["tooling/test-plan.json"], ["tooling/test-plan.ts"], ["tests/browser/fixtures.ts"],
                      ["tests/test-plan.test.ts", "dashboard/src/main.tsx"],
                      ["dashboard/src/styles.css", "package-lock.json"],
                      ["dashboard/src/styles.css", ".github/workflows/checks.yml"]]:
            with self.subTest(paths=paths):
                self.assertEqual(ci.scope(paths), "full")

    def test_shared_helper_runtime_consumer_forces_full_checks(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-ci-consumer-") as temp:
            root = Path(temp)
            (root / "tooling").mkdir()
            (root / "tooling/new-runtime.ts").write_text("import { mealPairs } from '../shared/meal-breaks.js';")
            old = Path.cwd()
            try:
                ci.os.chdir(root)
                self.assertEqual(ci.scope(["shared/meal-breaks.ts"]), "full")
            finally:
                ci.os.chdir(old)

    def test_move_from_backend_to_css_cannot_hide_a_backend_change(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-ci-plan-") as temp:
            root = Path(temp)
            def git(*args):
                return subprocess.check_output(["git", "-C", temp, *args], stderr=subprocess.DEVNULL, text=True).strip()
            git("init", "-b", "dev")
            git("config", "user.email", "fixture@example.invalid")
            git("config", "user.name", "Fixture")
            (root / "api").mkdir()
            (root / "api/source.ts").write_text("same content\n")
            git("add", ".")
            git("commit", "-m", "base")
            base = git("rev-parse", "HEAD")
            (root / "dashboard").mkdir()
            git("mv", "api/source.ts", "dashboard/styles.css")
            git("commit", "-m", "move")
            original = subprocess.check_output
            def command(args, **kwargs):
                return original(args, cwd=temp, **kwargs)
            with patch.object(ci.subprocess, "check_output", side_effect=command):
                self.assertEqual(ci.scope(ci.changes(base)), "full")

    def test_receipt_requires_identical_source_and_validation_context(self):
        self.assertTrue(ci.matches(self.receipt, self.run, self.context, "full"))
        for field, value in {"base": "e" * 40, "head": "e" * 40, "tree": "e" * 40,
                             "baseRef": "main", "repository": "other/repo", "workflow": "other.yml",
                             "runId": 16, "attempt": 1, "scope": "dashboard", "format": 2}.items():
            with self.subTest(field=field):
                changed = {**self.receipt, field: value}
                self.assertFalse(ci.matches(changed, self.run, self.context, "full"))
        self.assertTrue(ci.matches({**self.receipt, "scope": "dashboard"}, self.run, self.context, "dashboard"))

    def test_release_receipt_is_bound_to_main_and_the_full_suite(self):
        release = {**self.receipt, "baseRef": "main"}
        self.assertTrue(ci.matches(release, self.run, self.context, "full", "main"))
        self.assertFalse(ci.matches(self.receipt, self.run, self.context, "full", "main"))
        self.assertFalse(ci.matches(release, self.run, self.context, "full"))
        archive, digest = self.archive({**release, "scope": "dashboard"})
        artifact = {"id": 9, "name": "dispatch-validation-17-2", "expired": False,
                    "size_in_bytes": len(archive), "digest": digest}
        # A dashboard-only diff still cannot shrink what a release must have run.
        with patch.object(ci, "github", side_effect=[{"workflow_runs": [self.run]},
                          {"artifacts": [artifact]}, archive]), \
                patch.object(ci, "changes", return_value=["dashboard/src/main.tsx"]):
            self.assertIsNone(ci.validated_run(self.context, "main"))

    def test_wrong_failed_pending_or_fork_runs_are_not_trusted(self):
        for field, value in {"head_sha": "f" * 40, "event": "push", "status": "in_progress",
                             "conclusion": "failure", "path": "other.yml",
                             "head_repository": {"full_name": "fork/repo"}}.items():
            with self.subTest(field=field):
                self.assertFalse(ci.trusted_run({**self.run, field: value}, self.context["head"]))

    def test_validation_archive_rejects_wrong_digest_and_unexpected_files(self):
        archive, digest = self.archive()
        self.assertEqual(ci.read_receipt(archive, digest), self.receipt)
        with self.assertRaises(ValueError):
            ci.read_receipt(archive + b"tampered", digest)
        archive, digest = self.archive(filename="../validation.json")
        with self.assertRaises(ValueError):
            ci.read_receipt(archive, digest)
        archive, digest = self.archive({"oversized": "x" * 17000})
        with self.assertRaises(ValueError):
            ci.read_receipt(archive, digest)
        archive, digest = self.archive([])
        with self.assertRaises(ValueError):
            ci.read_receipt(archive, digest)

    def test_reuse_verifies_successful_run_archive_and_matching_tree(self):
        archive, digest = self.archive()
        artifact = {"id": 9, "name": "dispatch-validation-17-2", "expired": False,
                    "size_in_bytes": len(archive), "digest": digest}
        with patch.object(ci, "github", side_effect=[{"workflow_runs": [self.run]},
                          {"artifacts": [artifact]}, archive]), \
                patch.object(ci, "changes", return_value=["api/main.ts"]):
            self.assertEqual(ci.validated_run(self.context), 17)
        with patch.object(ci, "github", side_effect=[{"workflow_runs": [self.run]},
                          {"artifacts": [{**artifact, "expired": True}]}]):
            self.assertIsNone(ci.validated_run(self.context))

    def test_newer_failed_pending_or_skipped_run_cannot_reuse_older_success(self):
        # A PR returned to draft skips every check; its older green run is not revived.
        for newer in [{"conclusion": "failure"}, {"status": "in_progress", "conclusion": None},
                      {"conclusion": "skipped"}]:
            with self.subTest(newer=newer), patch.object(ci, "github", return_value={"workflow_runs": [
                    self.run, {**self.run, "id": 18, **newer}]}):
                self.assertIsNone(ci.validated_run(self.context))
        with patch.object(ci, "github", return_value={"workflow_runs": []}):
            self.assertIsNone(ci.validated_run(self.context))

    def test_push_reuses_validation_but_api_failure_runs_normal_checks(self):
        with patch.object(ci, "merge_context", return_value=self.context), \
                patch.object(ci, "validated_run", return_value=17):
            self.assertEqual(ci.plan("push", "refs/heads/dev", {})[0], "reuse")
        with patch.object(ci, "merge_context", return_value=self.context), \
                patch.object(ci, "validated_run", side_effect=subprocess.TimeoutExpired("gh", 20)), \
                patch.object(ci, "changes", return_value=["api/main.ts"]):
            self.assertEqual(ci.plan("push", "refs/heads/dev", {"before": "a" * 40})[0], "full")

    def test_main_reuses_only_its_release_validation_and_never_narrows(self):
        with patch.object(ci, "merge_context", return_value=self.context), \
                patch.object(ci, "validated_run", return_value=17) as reuse:
            self.assertEqual(ci.plan("push", "refs/heads/main", {})[0], "reuse")
            reuse.assert_called_once_with(self.context, "main")
        for outcome in [{"return_value": None}, {"side_effect": subprocess.TimeoutExpired("gh", 20)}]:
            with patch.object(ci, "merge_context", return_value=self.context), \
                    patch.object(ci, "validated_run", **outcome), \
                    patch.object(ci, "changes", return_value=["dashboard/src/main.tsx"]):
                self.assertEqual(ci.plan("push", "refs/heads/main", {"before": "a" * 40})[0], "full")
        with patch.object(ci, "merge_context", return_value=None), patch.object(ci, "validated_run") as reuse:
            self.assertEqual(ci.plan("push", "refs/heads/main", {"before": "a" * 40})[0], "full")
            reuse.assert_not_called()

    def test_manual_scheduled_and_release_pr_checks_always_run_full_suite(self):
        release = copy.deepcopy(self.event)
        release["pull_request"]["base"]["ref"] = "main"
        with patch.object(ci, "validated_run") as reuse, \
                patch.object(ci, "changes", return_value=["dashboard/src/main.tsx"]):
            self.assertEqual(ci.plan("workflow_dispatch", "refs/heads/dev", {})[0], "full")
            self.assertEqual(ci.plan("workflow_dispatch", "refs/heads/main", {})[0], "full")
            self.assertEqual(ci.plan("schedule", "refs/heads/dev", {})[0], "full")
            self.assertEqual(ci.plan("pull_request", "refs/pull/1/merge", release)[0], "full")
            reuse.assert_not_called()

    def test_draft_checks_defer_until_ready_and_cannot_publish_validation(self):
        event = copy.deepcopy(self.event)
        event["pull_request"]["draft"] = True
        self.assertEqual(ci.plan("pull_request", "refs/pull/1/merge", event)[0], "draft")
        with patch.object(ci, "merge_context", return_value=self.context), self.assertRaises(ValueError):
            ci.receipt(event, "full")
        event["pull_request"]["draft"] = False
        with patch.object(ci, "changes", return_value=["dashboard/src/main.tsx"]):
            self.assertEqual(ci.plan("pull_request", "refs/pull/1/merge", event)[0], "dashboard")

    def test_receipt_cannot_claim_a_different_checked_out_merge(self):
        environment = {"GITHUB_SHA": self.context["commit"], "GITHUB_RUN_ID": "17", "GITHUB_RUN_ATTEMPT": "2"}
        with patch.dict(ci.os.environ, environment), patch.object(ci, "merge_context", return_value=self.context):
            self.assertEqual(ci.receipt(self.event, "full"), self.receipt)
            changed = copy.deepcopy(self.event)
            changed["pull_request"]["head"]["sha"] = "f" * 40
            with self.assertRaises(ValueError):
                ci.receipt(changed, "full")
            with patch.object(ci, "changes", return_value=["api/main.ts"]):
                with self.assertRaises(ValueError):
                    ci.receipt(self.event, "dashboard")
            release = copy.deepcopy(self.event)
            release["pull_request"]["base"]["ref"] = "main"
            self.assertEqual(ci.receipt(release, "full"), {**self.receipt, "baseRef": "main"})
            with patch.object(ci, "changes", return_value=["dashboard/src/main.tsx"]):
                with self.assertRaises(ValueError):
                    ci.receipt(release, "dashboard")
            release["pull_request"]["base"]["ref"] = "other"
            with self.assertRaises(ValueError):
                ci.receipt(release, "full")


if __name__ == "__main__":
    unittest.main()
