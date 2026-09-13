import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package', Path(__file__).resolve().parents[1] / 'src/release-package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
COMMIT = 'a' * 40


class Packages(unittest.TestCase):
    def test_deterministic_archives_and_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'input'
            file = root / 'dependencies/node/bin/node'
            file.parent.mkdir(parents=True)
            file.write_bytes(b'fixture')
            file.chmod(0o555)
            a, b = Path(tmp) / 'a.gz', Path(tmp) / 'b.gz'
            self.assertEqual(package.pack(root, a, 'dependencies', '-'), 7)
            package.pack(root, b, 'dependencies', '-')
            self.assertEqual(a.read_bytes(), b.read_bytes())
            output = Path(tmp) / 'output'
            package.unpack(a, str(output), 'dependencies', '-', package.digest(a))
            self.assertEqual((output / 'dependencies/node/bin/node').read_bytes(), b'fixture')
            self.assertEqual((output / 'dependencies/node/bin/node').stat().st_mode & 0o777, 0o555)
            for directory in [output, output / 'dependencies', output / 'dependencies/node', output / 'dependencies/node/bin']:
                directory.chmod(0o700)

    def test_rejects_traversal_links_duplicates_oversize_missing_and_wrong_commit(self):
        for bad in ['traversal', 'symlink', 'duplicate', 'oversize', 'missing', 'commit', 'unlisted', 'corrupt', 'wrong-root']:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as tmp:
                name = '../escape' if bad == 'traversal' else 'runtime/dependencies/node' if bad == 'wrong-root' else 'core/code/shared/fixture.js'
                entry = {'path': name, 'mode': '444', 'size': 128 * 1024 ** 2 + 1 if bad == 'oversize' else 1, 'sha256': hashlib.sha256(b'x').hexdigest()}
                data = json.dumps({'schemaVersion': 1, 'kind': 'app', 'sourceCommit': 'b' * 40 if bad == 'commit' else COMMIT, 'files': [entry]}).encode()
                archive = Path(tmp) / 'bad.gz'
                with tarfile.open(archive, 'w:gz') as target:
                    m = tarfile.TarInfo(package.MANIFEST); m.size = len(data); target.addfile(m, io.BytesIO(data))
                    if bad != 'missing':
                        m = tarfile.TarInfo('core/code/shared/other.js' if bad == 'unlisted' else name); m.size = 1; m.mode = 0o444
                        if bad == 'symlink': m.type = tarfile.SYMTYPE; m.linkname = '/etc/passwd'; m.size = 0
                        target.addfile(m, io.BytesIO(b'y' if bad == 'corrupt' else b'x'))
                        if bad == 'duplicate': target.addfile(m, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    package.unpack(archive, str(Path(tmp) / 'out'), 'app', COMMIT, package.digest(archive))
                self.assertFalse((Path(tmp) / 'escape').exists())


if __name__ == '__main__':
    unittest.main()
