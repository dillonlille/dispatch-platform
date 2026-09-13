import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('archive', Path(__file__).parents[1] / 'src/native-runtime-archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTests(unittest.TestCase):
    def make_archive(self, root, extra=None, content=b'original'):
        payload = b'original'
        manifest = json.dumps({'schemaVersion': 1, 'backend': 'native_service_v1', 'sourceCommit': 'a' * 40,
                               'platform': 'linux/amd64', 'files': [{'path': 'app/libstdc++.so.6', 'mode': '444',
                               'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}]}).encode()
        file = root / 'runtime.tar.gz'
        with tarfile.open(file, 'w:gz') as target:
            for name, data in [('runtime-release-manifest.json', manifest), ('app/libstdc++.so.6', content)]:
                member = tarfile.TarInfo(name)
                member.mode = 0o444
                member.size = len(data)
                target.addfile(member, io.BytesIO(data))
            if extra:
                member = tarfile.TarInfo(extra)
                member.type = tarfile.SYMTYPE
                member.linkname = '/etc/passwd'
                target.addfile(member)
        return file, hashlib.sha256(manifest).hexdigest()

    def test_roundtrip_preserves_code_and_rejects_unexpected_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file, digest = self.make_archive(root)
            archive.unpack(str(file), str(root / 'out'), digest, 'a' * 40, archive.digest_file(file))
            self.assertEqual((root / 'out/app/libstdc++.so.6').read_bytes(), b'original')
            self.assertEqual((root / 'out/app/libstdc++.so.6').stat().st_mode & 0o777, 0o444)
            (root / 'out').chmod(0o700)
            (root / 'out/app').chmod(0o700)

    def test_rejects_traversal_links_and_modified_payload(self):
        for extra, content in [('../escape', b'original'), ('app/link', b'original'), (None, b'modified')]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                file, digest = self.make_archive(root, extra, content)
                with self.assertRaises(ValueError):
                    archive.unpack(str(file), str(root / 'out'), digest, 'a' * 40, archive.digest_file(file))
                self.assertFalse((root / 'escape').exists())


if __name__ == '__main__':
    unittest.main()
