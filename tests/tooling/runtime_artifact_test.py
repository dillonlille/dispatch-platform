import hashlib
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

sys.path.insert(0, str(Path(__file__).parents[2] / "tooling"))
import runtime_artifact as runtime

from dev_updater_test import artifact


class SharedToolingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-runtime-artifact-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.commit = "a" * 40
        self.run = {"id": 5, "run_attempt": 1, "head_sha": self.commit, "event": "push", "head_branch": "dev",
                    "status": "completed", "conclusion": "success",
                    "head_repository": {"full_name": runtime.REPOSITORY}}

    def test_source_verifier_uses_cargos_configured_output_and_never_a_stale_default(self):
        (self.root / "backend/host").mkdir(parents=True)
        (self.root / "backend/host/Cargo.toml").touch()
        (self.root / "tooling").mkdir()
        custom = self.root / "custom-target"
        with patch.object(runtime, "__file__", str(self.root / "tooling/runtime_artifact.py")), \
                patch.object(runtime.subprocess, "check_call") as build, \
                patch.object(runtime, "command", return_value=json.dumps({"target_directory": str(custom)})):
            self.assertEqual(runtime.host_binary.__wrapped__(), custom / "release/dispatch-host")
            build.assert_called_once_with(["cargo", "build", "--locked", "--release", "-p", "dispatch-host"],
                                          cwd=self.root, stdout=sys.stderr)

    def test_only_the_newest_run_of_this_repository_branch_and_commit_decides(self):
        select = lambda runs, **rules: (runtime.latest_run(runs, self.commit, "push", "dev", **rules) or {}).get("id")
        others = [{**self.run, "id": 9, "head_sha": "b" * 40}, {**self.run, "id": 10, "event": "pull_request"},
                  {**self.run, "id": 11, "head_branch": "main"},
                  {**self.run, "id": 12, "head_repository": {"full_name": "fork/repo"}},
                  {**self.run, "id": 13, "head_repository": None}]
        self.assertEqual(select([self.run, *others]), 5)
        self.assertIsNone(select(others))
        self.assertIsNone(select([]))
        self.assertEqual(runtime.latest_run([*others, self.run], self.commit, "push")["id"], 11)
        for newer in [{"conclusion": "failure"}, {"status": "in_progress", "conclusion": None}]:
            run = runtime.latest_run([self.run, {**self.run, "id": 6, **newer}], self.commit, "push", "dev")
            self.assertEqual(run["id"], 6)
            self.assertFalse(runtime.passed(run))
        self.assertEqual(runtime.latest_run([{**self.run, "run_attempt": 2, "conclusion": "failure"}, self.run],
                                            self.commit, "push", "dev")["conclusion"], "failure")
        self.assertTrue(runtime.passed(self.run))
        self.assertFalse(runtime.passed(None))

    def test_skipped_run_checked_nothing_unless_the_caller_must_not_look_past_it(self):
        runs = [self.run, {**self.run, "id": 6, "conclusion": "skipped"}]
        self.assertEqual(runtime.latest_run(runs, self.commit, "push", "dev")["id"], 5)
        newest = runtime.latest_run(runs, self.commit, "push", "dev", skipped=True)
        self.assertEqual(newest["id"], 6)
        self.assertFalse(runtime.passed(newest))

    def test_github_reads_this_repository_and_reports_why_the_cli_failed(self):
        done = lambda code, out, err: subprocess.CompletedProcess([], code, out, err)
        with patch.object(runtime.subprocess, "run", return_value=done(0, '{"id": 7}\n', "")) as run:
            self.assertEqual(runtime.github("releases/7", "--method", "PATCH", timeout=20), {"id": 7})
            self.assertEqual(run.call_args.args[0], ("gh", "api", f"repos/{runtime.REPOSITORY}/releases/7",
                                                     "--method", "PATCH"))
            self.assertEqual(run.call_args.kwargs["timeout"], 20)
        with patch.object(runtime.subprocess, "run", return_value=done(0, b"PK\x03\x04 \n", b"")) as run:
            self.assertEqual(runtime.github("actions/artifacts/1/zip", binary=True), b"PK\x03\x04 \n")
            self.assertFalse(run.call_args.kwargs["text"])
        for error in ["HTTP 404: Not Found", b"HTTP 404: Not Found"]:
            with patch.object(runtime.subprocess, "run", return_value=done(1, "", error)), \
                    self.assertRaisesRegex(RuntimeError, "gh api repos/.* failed: HTTP 404: Not Found"):
                runtime.github("missing", binary=isinstance(error, bytes))

    def download(self, change=None, inner="dispatch-dev.tar.gz", commit=None, **options):
        source = self.root / "source"
        if not source.exists():
            artifact(source, self.commit)
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            archive.add(source, arcname=".")
        packed = io.BytesIO()
        with zipfile.ZipFile(packed, "w") as bundle:
            bundle.writestr(inner, data.getvalue())
        record = {"id": 42, "size_in_bytes": len(packed.getvalue()),
                  "digest": "sha256:" + hashlib.sha256(packed.getvalue()).hexdigest(), **(change or {})}
        def gh(args, **kwargs):
            self.assertEqual(args, ["gh", "api", f"repos/{runtime.REPOSITORY}/actions/artifacts/42/zip"])
            kwargs["stdout"].write(packed.getvalue())
        directory = Path(tempfile.mkdtemp(dir=self.root))
        runtime.host_binary()
        with patch.object(runtime.subprocess, "run", side_effect=gh):
            return data.getvalue(), runtime.download_run_artifact(record, directory, commit or self.commit, **options)

    def test_downloaded_run_artifact_is_verified_unpacked_and_its_package_kept_on_request(self):
        package = self.root / "dispatch-platform-1.2.3.tar.gz"
        inner, (candidate, manifest) = self.download(package=package)
        self.assertEqual(package.read_bytes(), inner)
        self.assertEqual(runtime.verify_artifact(candidate, self.commit), manifest)
        self.assertEqual((candidate / "services/rust/dispatch-backend").read_text(), "candidate")
        _inner, (candidate, _manifest) = self.download()
        self.assertTrue((candidate.parent / "build.tar.gz").is_file())

    def test_run_artifact_that_differs_from_the_github_record_or_source_is_rejected(self):
        for problem, options in {
                "Invalid artifact size": {"change": {"size_in_bytes": 0}},
                "Invalid artifact size ": {"change": {"size_in_bytes": runtime.MAX_BYTES + 1}},
                "GitHub artifact digest mismatch": {"change": {"digest": "sha256:" + "0" * 64}},
                "GitHub artifact digest mismatch ": {"change": {"digest": None}},
                "GitHub artifact digest mismatch  ": {"change": {"size_in_bytes": 1}},
                "Unexpected artifact package": {"inner": "other.tar.gz"},
                "another commit": {"commit": "b" * 40}}.items():
            with self.subTest(problem=problem), self.assertRaisesRegex(RuntimeError, problem.strip()):
                self.download(**options)
        with self.assertRaises(FileExistsError):
            (self.root / "existing.tar.gz").write_text("prepared earlier")
            self.download(package=self.root / "existing.tar.gz")
        self.assertEqual((self.root / "existing.tar.gz").read_text(), "prepared earlier")

    def test_stable_versions_exclude_prereleases_and_padded_numbers(self):
        for value, stable in {"0.0.9": True, "10.20.30": True, "0.1.0-dev.0": False, "1.2": False,
                              "01.2.3": False, "v1.2.3": False, "1.2.3\n": False}.items():
            self.assertEqual(bool(runtime.re.fullmatch(runtime.STABLE, value)), stable, value)


if __name__ == "__main__":
    unittest.main()
