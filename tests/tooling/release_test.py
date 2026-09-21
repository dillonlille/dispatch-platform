"""The release policy/recovery suite lives in backend/host/src/release/tests.rs."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release", ROOT / "tooling/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseLauncherTests(unittest.TestCase):
    def test_legacy_arguments_and_explicit_stages_exec_the_checkout_host(self):
        for args in ([], ["1.2.3", "--bump", "minor"], ["prepare", "--notes", "/tmp/notes with spaces.md"],
                     ["status"], ["publish", "1.2.3"], ["--help"]):
            with self.subTest(args=args), patch.object(release, "host_binary", return_value=Path("/tmp/host")), \
                    patch.object(release.os, "execv") as execute:
                release.main(args)
                execute.assert_called_once_with("/tmp/host", ["/tmp/host", "host", "release", *args,
                                                              "--root", str(ROOT)])


if __name__ == "__main__":
    unittest.main()
