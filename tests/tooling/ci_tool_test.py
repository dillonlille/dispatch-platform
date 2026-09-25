"""The Python launchers only find or build the Rust tools; these test that bootstrap."""
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


verify = module("ci_verify", "ci-verify.py")


class CiLauncherTests(unittest.TestCase):
    def test_verify_hands_the_archive_to_the_checkout_host(self):
        with patch.object(verify, "host_binary", return_value=Path("/tmp/host")), \
                patch.object(verify.os, "execv") as execute:
            verify.main(["/tmp/artifact with spaces.tar.gz"])
            execute.assert_called_once_with("/tmp/host", ["/tmp/host", "host", "ci", "verify", "/tmp/artifact with spaces.tar.gz"])

    def test_bootstrap_builds_only_small_ci_binary_and_uses_configured_cargo_target(self):
        # Without a restored tool of its own, which CI has whenever that cache hits.
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(ci_tool.subprocess, "check_call") as build, \
                patch.object(ci_tool.subprocess, "check_output", return_value=json.dumps({"target_directory": "/custom target"})), \
                patch.object(ci_tool.os, "execv") as execute:
            ci_tool.launch("preflight")
            build.assert_called_once_with(["cargo", "build", "--locked", "-p", "dispatch-ci"], cwd=ROOT, stdout=sys.stderr)
            execute.assert_called_once_with(Path("/custom target/debug/dispatch-ci"),
                                            ["/custom target/debug/dispatch-ci", "preflight", "--root", str(ROOT)])

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
                ci_tool.launch("preflight")
                build.assert_not_called()
                execute.assert_called_once_with(binary, [str(binary), "preflight", "--root", str(ROOT)])


if __name__ == "__main__":
    unittest.main()
