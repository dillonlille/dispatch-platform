"""Artifact promotion policy is tested in backend/host/src/ci/tests.rs."""
from pathlib import Path
import unittest
from unittest.mock import patch
from ci_plan_test import ROOT, module

artifact = module("ci_artifact", "ci-artifact.py")
gate = module("ci_gate", "ci-gate.py")


class CiArtifactLauncherTests(unittest.TestCase):
    def test_restore_uses_checkout_host_and_preserves_destination(self):
        for args, output in [([], ".build"), (["--output", "/tmp/build with spaces"], "/tmp/build with spaces")]:
            with patch.object(artifact, "host_binary", return_value=Path("/tmp/host")), \
                    patch.object(artifact.os, "execv") as execute:
                artifact.main(args)
                execute.assert_called_once_with("/tmp/host", ["/tmp/host", "host", "ci", "restore", "--root", str(ROOT), "--output", output])

    def test_gate_dispatches_job_validation_and_artifact_verification(self):
        with patch.object(gate, "launch") as launch:
            gate.main([])
            launch.assert_called_once_with("gate")
        with patch.object(gate, "host_binary", return_value=Path("/tmp/host")), \
                patch.object(gate.os, "execv") as execute, patch.object(gate, "launch") as launch:
            gate.main(["--artifact", "/tmp/artifact with spaces.tar.gz"])
            execute.assert_called_once_with("/tmp/host", ["/tmp/host", "host", "ci", "verify", "/tmp/artifact with spaces.tar.gz"])
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
