"""Extract only bounded regular release files. Never extract links or special files."""
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile


def extract(archive, destination):
    target = Path(destination)
    target.mkdir(mode=0o700)
    seen, total = set(), 0
    with tarfile.open(archive, 'r:gz') as bundle:
        for index, member in enumerate(bundle):
            name = member.name
            if name == '.' and member.isdir():
                continue
            if name.startswith('./'):
                name = name[2:]
            name = name.rstrip('/') if member.isdir() else name
            parts = PurePosixPath(name).parts
            if (index > 100000 or not parts or name.startswith('/') or '\\' in name
                    or any(c in name for c in '\x00\r\n') or '..' in parts
                    or str(PurePosixPath(name)) != name or name in seen
                    or not (member.isdir() or member.isreg()) or member.size < 0):
                raise ValueError('release_archive_invalid')
            seen.add(name)
            total += member.size
            if total > 2 * 1024 ** 3:
                raise ValueError('release_archive_capacity')
            output = target.joinpath(*parts)
            if member.isdir():
                output.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                output.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, output.open('xb') as stream:
                    remaining = member.size
                    while remaining:
                        data = source.read(min(1024 * 1024, remaining))
                        if not data:
                            raise ValueError('release_archive_truncated')
                        stream.write(data)
                        remaining -= len(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                output.chmod(0o755 if member.mode & 0o111 else 0o644)


if __name__ == '__main__':
    extract(*sys.argv[1:])
