import importlib.util
from pathlib import Path
import os
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("isolation", Path(__file__).resolve().parents[2] / "tooling/host/prepare-isolated-runtime.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IsolationTests(unittest.TestCase):
    def test_verified_snapshot_is_read_only_and_bad_replacement_keeps_active(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            (source / "services/rust").mkdir(parents=True)
            binary = source / "services/rust/dispatch-backend"
            binary.write_text("verified")
            destination.mkdir(mode=0o755)
            def verify(path):
                self.assertFalse((path / "services/rust/dispatch-backend").is_symlink())
                if (path / "services/rust/dispatch-backend").read_text() != "verified":
                    raise ValueError("bad hash")
                return {"digest": "expected"}
            module.prepare(source, destination, verify)
            active = destination / "current/services/rust/dispatch-backend"
            self.assertEqual(stat.S_IMODE(active.stat().st_mode), 0o555)
            self.assertEqual(active.read_text(), "verified")
            binary.write_text("tampered")
            with self.assertRaises(ValueError):
                module.prepare(source, destination, verify)
            self.assertEqual(active.read_text(), "verified")

    def test_source_symlink_and_writable_destination_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            link = root / "link"
            link.symlink_to(source)
            with self.assertRaises(ValueError):
                module.prepare(link, destination, lambda _: {"digest": "unused"})
            os.chmod(destination, 0o777)
            with self.assertRaises(ValueError):
                module.prepare(source, destination, lambda _: {"digest": "unused"})


if __name__ == "__main__":
    unittest.main()
