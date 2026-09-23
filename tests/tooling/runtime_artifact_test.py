import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[2] / "tooling"))
import runtime_artifact as runtime


class SharedToolingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dispatch-runtime-artifact-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.commit = "a" * 40
        self.run = {"id": 5, "run_attempt": 1, "head_sha": self.commit, "event": "push", "head_branch": "main",
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

    def test_source_verifier_prefers_a_restored_host_only_from_its_own_ci_cache(self):
        (self.root / "backend/host").mkdir(parents=True)
        (self.root / "backend/host/Cargo.toml").touch()
        (self.root / "tooling").mkdir()
        tools = self.root / ".ci-tools"
        binary = tools / "tools/dispatch-host"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n")
        binary.chmod(0o700)
        trusted = {"CI": "true", "DISPATCH_CI_TOOLS": str(tools)}
        with patch.object(runtime, "__file__", str(self.root / "tooling/runtime_artifact.py")), \
                patch.object(runtime.subprocess, "check_call") as build, \
                patch.object(runtime, "command", return_value=json.dumps({"target_directory": str(self.root / "target")})):
            with patch.dict(os.environ, trusted, clear=False):
                self.assertEqual(runtime.host_binary.__wrapped__(), binary)
                build.assert_not_called()
                binary.chmod(0o600)
                self.assertEqual(runtime.host_binary.__wrapped__(), self.root / "target/release/dispatch-host",
                                 "a non-executable file is not a tool")
                binary.chmod(0o700)
            for untrusted in [{"DISPATCH_CI_TOOLS": str(tools)}, {"CI": "true"},
                              {"CI": "true", "DISPATCH_CI_TOOLS": str(self.root / "elsewhere")}]:
                with patch.dict(os.environ, untrusted, clear=True):
                    self.assertEqual(runtime.host_binary.__wrapped__(), self.root / "target/release/dispatch-host",
                                     untrusted)
            self.assertEqual(build.call_count, 4)


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


    def test_stable_versions_exclude_prereleases_and_padded_numbers(self):
        for value, stable in {"0.0.9": True, "10.20.30": True, "0.1.0-dev.0": False, "1.2": False,
                              "01.2.3": False, "v1.2.3": False, "1.2.3\n": False}.items():
            self.assertEqual(bool(runtime.re.fullmatch(runtime.STABLE, value)), stable, value)


if __name__ == "__main__":
    unittest.main()
