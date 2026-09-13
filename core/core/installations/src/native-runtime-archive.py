"""Dispatch runtime archive reader. Never delegates extraction to tar/extractall."""
import errno
import hashlib
import json
import os
import re
import stat
import sys
import tarfile

MAX_BYTES = 2 * 1024 ** 3
MAX_FILES = 20000
MANIFEST = 'runtime-release-manifest.json'


def require(condition):
    if not condition:
        raise ValueError('invalid_native_runtime')


def digest_file(filename):
    result = hashlib.sha256()
    with open(filename, 'rb') as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def manifest_entries(data, expected_hash, commit):
    require(hashlib.sha256(data).hexdigest() == expected_hash)
    manifest = json.loads(data)
    require(set(manifest) == {'schemaVersion', 'backend', 'sourceCommit', 'platform', 'files'})
    require(manifest['schemaVersion'] == 1 and manifest['backend'] == 'native_service_v1')
    require(manifest['sourceCommit'] == commit and manifest['platform'] == 'linux/amd64')
    require(isinstance(manifest['files'], list) and 1 <= len(manifest['files']) <= MAX_FILES)
    entries = {}
    total = 0
    for entry in manifest['files']:
        require(set(entry) == {'path', 'mode', 'size', 'sha256'})
        name = entry['path']
        require(isinstance(name, str) and len(name) <= 240 and re.fullmatch(r'[A-Za-z0-9_./+-]+', name))
        require(all(part not in ('', '.', '..') for part in name.split('/')))
        require(name != MANIFEST and name not in entries)
        require(entry['mode'] in ('444', '555') and type(entry['size']) is int and entry['size'] >= 0)
        require(re.fullmatch(r'[a-f0-9]{64}', entry['sha256']))
        total += entry['size']
        require(total <= MAX_BYTES)
        entries[name] = entry
    for name in entries:
        parts = name.split('/')[:-1]
        while parts:
            require('/'.join(parts) not in entries)
            parts.pop()
    return entries


def unpack(archive, root, expected_hash, commit, archive_hash):
    require(os.path.isabs(root) and not os.path.lexists(root))
    require(digest_file(archive) == archive_hash)
    os.mkdir(root, 0o700)
    with tarfile.open(archive, 'r|gz') as source:
        first = source.next()
        require(first is not None and first.name == MANIFEST and first.isreg() and first.size <= 8 * 1024 ** 2)
        data = source.extractfile(first).read()
        entries = manifest_entries(data, expected_hash, commit)
        with open(os.path.join(root, MANIFEST), 'xb') as target:
            target.write(data)
        os.chmod(os.path.join(root, MANIFEST), 0o444)
        seen = set()
        for member in source:
            if member is first:
                continue
            require(member.name in entries and member.name not in seen and member.isreg())
            entry = entries[member.name]
            require(member.size == entry['size'] and member.mode == int(entry['mode'], 8))
            target = os.path.join(root, member.name)
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            result = hashlib.sha256()
            with source.extractfile(member) as incoming, open(target, 'xb') as outgoing:
                while chunk := incoming.read(1024 * 1024):
                    result.update(chunk)
                    outgoing.write(chunk)
                outgoing.flush()
                os.fsync(outgoing.fileno())
            require(result.hexdigest() == entry['sha256'])
            os.chmod(target, int(entry['mode'], 8))
            seen.add(member.name)
        require(seen == set(entries))
    for directory, _, _ in os.walk(root, topdown=False):
        os.chmod(directory, 0o555)


def verify(root, expected_hash, commit):
    require(os.path.isabs(root) and os.path.realpath(root) == root)
    info = os.lstat(os.path.join(root, MANIFEST))
    require(stat.S_ISREG(info.st_mode) and info.st_size <= 8 * 1024 ** 2)
    with open(os.path.join(root, MANIFEST), 'rb') as source:
        entries = manifest_entries(source.read(), expected_hash, commit)
    seen = set()
    for directory, directories, files in os.walk(root, followlinks=False):
        for selected in [directory] + [os.path.join(directory, name) for name in directories]:
            info = os.lstat(selected)
            require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o555 and info.st_uid == 0 and info.st_gid == 0)
        for name in files:
            filename = os.path.join(directory, name)
            relative = os.path.relpath(filename, root)
            info = os.lstat(filename)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and info.st_gid == 0)
            if relative == MANIFEST:
                require(stat.S_IMODE(info.st_mode) == 0o444)
                continue
            require(relative in entries)
            entry = entries[relative]
            require(stat.S_IMODE(info.st_mode) == int(entry['mode'], 8) and info.st_size == entry['size'])
            require(digest_file(filename) == entry['sha256'])
            seen.add(relative)
    require(seen == set(entries))


def pack(root, archive):
    require(not os.path.lexists(archive))
    with open(os.path.join(root, MANIFEST), 'rb') as source:
        data = source.read()
    value = json.loads(data)
    entries = manifest_entries(data, hashlib.sha256(data).hexdigest(), value['sourceCommit'])
    with tarfile.open(archive, 'x:gz', format=tarfile.USTAR_FORMAT) as target:
        for name in [MANIFEST] + sorted(entries):
            filename = os.path.join(root, name)
            info = os.lstat(filename)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
            member = tarfile.TarInfo(name)
            member.size = info.st_size
            member.mode = 0o444 if name == MANIFEST else int(entries[name]['mode'], 8)
            with open(filename, 'rb') as source:
                target.addfile(member, source)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'unpack' and len(sys.argv) == 7:
            unpack(*sys.argv[2:])
        elif sys.argv[1] == 'verify' and len(sys.argv) == 5:
            verify(*sys.argv[2:])
        elif sys.argv[1] == 'pack' and len(sys.argv) == 4:
            pack(*sys.argv[2:])
        else:
            raise ValueError('invalid_native_runtime')
    except OSError as error:
        print('archive_disk_full' if error.errno in (errno.ENOSPC, errno.EDQUOT) else 'archive_io_failed', file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('native runtime verification failed', file=sys.stderr)
        sys.exit(1)
