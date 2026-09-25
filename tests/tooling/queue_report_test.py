"""The failed queue run's comment on its PR: which jobs it lists, and where the excerpt starts."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tooling"))


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tooling" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


report = module("queue_report", "queue-report.py")
RUN = {"id": 36159093343, "html_url": "https://github.com/dispatch-systems/dispatch-platform/actions/runs/36159093343",
       "run_started_at": "2026-09-25T16:10:51Z", "updated_at": "2026-09-25T16:15:42Z"}


def job(name, conclusion, step="", number=1):
    return {"id": number, "name": name, "conclusion": conclusion, "html_url": f"https://github.com/job/{number}",
            "steps": [{"name": "Set up job", "conclusion": "success"},
                      {"name": step or "Run it", "conclusion": conclusion}]}


def log(*lines):
    return "\n".join(f"2026-09-25T16:11:23.4428662Z {line}" for line in lines).encode()


class QueueReportTests(unittest.TestCase):
    def test_the_pr_number_comes_from_the_queue_branch_only(self):
        self.assertEqual(report.pull_number("refs/heads/gh-readonly-queue/main/pr-253-5c4e0a1a52eff4872dd23a2502dde6dfacd587db"), 253)
        for other in ["refs/heads/feature", "refs/heads/gh-readonly-queue/main/pr-x-5c4e", "", None]:
            with self.assertRaises(RuntimeError):
                report.pull_number(other)

    def test_only_the_jobs_that_failed_the_run_are_listed_with_their_failed_step(self):
        jobs = [job("build", "success"), job("api", "failure", "Run npm run check:ci -- api", 2),
                job("browser (3)", "timed_out", "Browser suite shard 3 of 8", 3), job("tools", "failure", "Build the CI and host tools", 4),
                job("platform", "failure", "Require every suite", 5), {"id": 6, "name": "report", "conclusion": None, "steps": None}]
        self.assertEqual([(j["name"], j["step"], j["url"]) for j in report.failed_jobs(jobs)], [
            ("api", "Run npm run check:ci -- api", "https://github.com/job/2"),
            ("browser (3)", "Browser suite shard 3 of 8", "https://github.com/job/3")])
        # The gate fails whenever a suite does, so it is listed only when it failed by itself.
        alone = [job("build", "success"), job("tools", "failure", number=2), job("platform", "failure", "Verify the build's source commit and inventory", 3)]
        self.assertEqual([(j["name"], j["step"]) for j in report.failed_jobs(alone)],
                         [("platform", "Verify the build's source commit and inventory")])
        self.assertEqual(report.failed_jobs([job("build", "success")]), [])

    def test_the_excerpt_starts_at_the_first_failure_marker_and_ends_before_the_runners_error(self):
        text, more = report.excerpt(log(
            "##[group]Run npm run check:ci -- api", "npm run check:ci -- api", "##[endgroup]",
            "[pass] dependency audit (0.6s)", ".F.................",
            "FAIL: test_collector_shards (build_pipeline_test.PipelineTests.test_collector_shards)",
            "Traceback (most recent call last):", "AssertionError: Items in the first set but not the second:",
            "\x1b[31mFAILED (failures=1)\x1b[0m", "[fail] Python tests (0.7s)", "",
            *[f"# {{\"event\":\"http.request\",\"line\":{n}}}" for n in range(40)],
            "##[error]Process completed with exit code 1.", "Post job cleanup."))
        self.assertEqual(text.splitlines()[0], "FAIL: test_collector_shards (build_pipeline_test.PipelineTests.test_collector_shards)")
        self.assertIn("FAILED (failures=1)", text, "colours are stripped")
        self.assertNotIn("\x1b", text)
        self.assertNotIn("2026-09-25", text, "timestamps are stripped")
        # The check's own failure line ends the excerpt: what follows belongs to the next check.
        self.assertEqual(text.splitlines()[-1], "[fail] Python tests (0.7s)")
        self.assertEqual(len(text.splitlines()), 5)
        self.assertEqual(more, 41, "the lines left before the runner's error line")
        text, more = report.excerpt(log("FAIL: x", *[f"line {n}" for n in range(60)], "##[error]Process completed with exit code 1."))
        self.assertEqual(len(text.splitlines()), report.EXCERPT_LINES)
        self.assertEqual(more, 61 - report.EXCERPT_LINES)
        for marker in ["  1) tests/browser/verification.spec.ts:5:1 › Paycom window", "failures:", "thread 'tests::x' panicked at src/lib.rs:1:1:",
                       "not ok 1 - first Sync Now discovers Cortex scope", "error[E0308]: mismatched types", "error: test failed",
                       "npm error code ERESOLVE", "    Error: expect(received).toEqual(expected)"]:
            text, more = report.excerpt(log("ok 1 - fine", marker, "detail", "##[error]Process completed with exit code 1."))
            self.assertEqual(text, f"{marker.rstrip()}\ndetail", marker)
            self.assertEqual(more, 0)

    def test_without_a_marker_the_excerpt_is_what_preceded_the_runners_error(self):
        text, more = report.excerpt(log(*[f"line {n}" for n in range(50)], "##[error]Process completed with exit code 1.", "after"))
        self.assertEqual(text.splitlines(), [f"line {n}" for n in range(20, 50)])
        self.assertEqual(more, 0)
        self.assertEqual(report.excerpt(b""), ("", 0))
        # A log with neither a marker nor the runner's error shows its end; long lines are cut.
        text, more = report.excerpt(log("x" * 500))
        self.assertEqual(text, "x" * report.LINE_WIDTH)

    def test_the_comment_names_the_commits_lists_each_job_and_folds_the_excerpt(self):
        failed = report.failed_jobs([job("api", "failure", "Run npm run check:ci -- api", 2), job("platform", "failure", "Require every suite", 3)])
        body = report.comment(RUN, 1, "5c4e0a1a52eff4872dd23a2502dde6dfacd587db", "50f9c2286e36f10875a8d718ac7bb7d6c6cde76d",
                              failed, ("FAIL: test_x\nFAILED (failures=1)", 12))
        self.assertEqual(body.splitlines(), [
            "### :x: Queue run failed on `50f9c22`",
            "",
            "The merge queue tested this PR squashed onto `main` at `5c4e0a1` and removed it. Nothing was merged. Fix on the branch, push, and ship again.",
            "",
            "| Job | Failed step | Log |",
            "|---|---|---|",
            "| `api` | Run npm run check:ci -- api | [view](https://github.com/job/2) |",
            "",
            "<details>",
            "<summary>First failure in <code>api</code></summary>",
            "",
            "```",
            "FAIL: test_x",
            "FAILED (failures=1)",
            "```",
            "",
            "… 12 more lines in the log",
            "",
            "</details>",
            "",
            "[Full run](https://github.com/dispatch-systems/dispatch-platform/actions/runs/36159093343) · attempt 1 · 4m 51s"])
        # A job cancelled before any step names its conclusion; an empty excerpt folds nothing.
        body = report.comment({"html_url": "u"}, 2, "abc", "def", report.failed_jobs([job("core", "cancelled", number=1) | {"steps": []}]), ("", 0))
        self.assertIn("| `core` | cancelled | [view](https://github.com/job/1) |", body)
        self.assertNotIn("<details>", body)
        self.assertTrue(body.endswith("[Full run](u) · attempt 2\n"))
        body = report.comment(RUN, 1, "abc", "def", failed, ("```sh\nx", 0))
        self.assertNotIn("```sh", body, "a fence inside the excerpt cannot close the block")

    def test_main_reads_the_run_and_posts_one_comment_on_the_pr(self):
        calls = []

        def github(endpoint, *args, binary=False, timeout=120):
            calls.append((endpoint, args))
            if endpoint == "actions/runs/36159093343":
                return RUN
            if endpoint.startswith("actions/runs/36159093343/jobs"):
                return {"jobs": [job("api", "failure", "Run npm run check:ci -- api", 2), job("platform", "failure", "Require every suite", 3)]}
            if endpoint == "actions/jobs/2/logs":
                self.assertTrue(binary)
                return log("FAIL: test_x", "##[error]Process completed with exit code 1.")
            self.assertEqual(endpoint, "issues/253/comments")
            self.assertEqual(args[:3], ("--method", "POST", "--input"))
            self.assertIn('"body": "### :x: Queue run failed on `50f9c22`', Path(args[3]).read_text())
            return {}

        with patch.object(report, "github", side_effect=github):
            report.main(["--run", "36159093343", "--attempt", "1", "--head-ref", "refs/heads/gh-readonly-queue/main/pr-253-5c4e0a1a",
                         "--base-sha", "5c4e0a1a52eff4872dd23a2502dde6dfacd587db", "--head-sha", "50f9c2286e36f10875a8d718ac7bb7d6c6cde76d"])
        self.assertEqual([c[0] for c in calls], ["actions/runs/36159093343", "actions/runs/36159093343/jobs?filter=latest&per_page=100",
                                                  "actions/jobs/2/logs", "issues/253/comments"])
        self.assertEqual(calls[2][1], ("--allow-escape-sequences",))
        with patch.object(report, "github", return_value={"jobs": [job("api", "success")]}), self.assertRaises(RuntimeError):
            report.main(["--run", "1", "--attempt", "1", "--head-ref", "refs/heads/gh-readonly-queue/main/pr-1-abc", "--base-sha", "a", "--head-sha", "b"])


if __name__ == "__main__":
    unittest.main()
