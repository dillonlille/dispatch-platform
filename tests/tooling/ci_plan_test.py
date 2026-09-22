"""Policy and trust cases live in backend/ci/src/tests.rs; these test the bootstrap."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tooling"))
import ci_tool


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tooling" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


plan = module("ci_plan", "ci-plan.py")


class CiLauncherTests(unittest.TestCase):
    def test_plan_and_receipt_arguments_are_preserved(self):
        for args in [["plan"], ["receipt", "--scope", "dashboard", "--output", "/tmp/receipt with spaces.json"]]:
            with patch.object(plan, "launch") as launch:
                plan.main(args)
                launch.assert_called_once_with(*args)

    def test_bootstrap_builds_only_small_ci_binary_and_uses_configured_cargo_target(self):
        # Without a restored tool of its own, which CI has whenever that cache hits.
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(ci_tool.subprocess, "check_call") as build, \
                patch.object(ci_tool.subprocess, "check_output", return_value=json.dumps({"target_directory": "/custom target"})), \
                patch.object(ci_tool.os, "execv") as execute:
            ci_tool.launch("plan")
            build.assert_called_once_with(["cargo", "build", "--locked", "-p", "dispatch-ci"], cwd=ROOT, stdout=sys.stderr)
            execute.assert_called_once_with(Path("/custom target/debug/dispatch-ci"),
                                            ["/custom target/debug/dispatch-ci", "plan", "--root", str(ROOT)])

    def test_bootstrap_runs_a_restored_tool_without_cargo_and_only_from_its_own_ci_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tools = root / ".ci-tools"
            binary = tools / "tools/dispatch-ci"
            trusted = {"CI": "true", "DISPATCH_CI_TOOLS": str(tools)}
            with patch.dict(os.environ, trusted, clear=False):
                self.assertIsNone(ci_tool.prebuilt(root, "dispatch-ci"), "nothing restored yet")
                binary.parent.mkdir(parents=True)
                binary.write_text("#!/bin/sh\n")
                binary.chmod(0o600)
                self.assertIsNone(ci_tool.prebuilt(root, "dispatch-ci"), "a non-executable file is not a tool")
                binary.chmod(0o700)
                self.assertEqual(ci_tool.prebuilt(root, "dispatch-ci"), binary)
                self.assertIsNone(ci_tool.prebuilt(root, "dispatch-host"), "each tool is named exactly")
            for untrusted in [{"DISPATCH_CI_TOOLS": str(tools)}, {"CI": "true"},
                              {"CI": "true", "DISPATCH_CI_TOOLS": str(root / "elsewhere")}]:
                with patch.dict(os.environ, untrusted, clear=True):
                    self.assertIsNone(ci_tool.prebuilt(root, "dispatch-ci"), untrusted)
            with patch.dict(os.environ, trusted, clear=False):
                binary.unlink()
                binary.symlink_to("/bin/sh")
                self.assertIsNone(ci_tool.prebuilt(root, "dispatch-ci"), "a symlink is not a tool")
            with patch.object(ci_tool, "prebuilt", return_value=binary), \
                    patch.object(ci_tool.subprocess, "check_call") as build, \
                    patch.object(ci_tool.os, "execv") as execute:
                ci_tool.launch("gate")
                build.assert_not_called()
                execute.assert_called_once_with(binary, [str(binary), "gate", "--root", str(ROOT)])


if __name__ == "__main__":
    unittest.main()
