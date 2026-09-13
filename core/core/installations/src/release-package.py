"""Deterministic release packages with bounded, inventory-checked extraction."""
import errno
import gzip
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile

MANIFEST = 'package-manifest.json'
MAX_BYTES = 2 * 1024 ** 3
MAX_FILES = 20000


def require(value):
    if not value:
        raise ValueError('release_package_invalid')


def digest(filename):
    result = hashlib.sha256()
    with open(filename, 'rb') as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def allowed(name, kind):
    if kind == 'dependencies':
        return name.startswith(('dependencies/node/', 'dependencies/browser/'))
    return bool(re.match(r'^(core/(code/(core|host|dashboard|shared|plugins)/|code/bin/dispatch-(dashboard|access-admin)$|host-helper-artifact/)|bridge/bridge-artifact/|runtime/(runtime/|shared/|plugins/|runtime-release-manifest.json$))', name))


def entries(value, kind, commit):
    require(set(value) == {'schemaVersion', 'kind', 'sourceCommit', 'files'})
    require(value['schemaVersion'] == 1 and value['kind'] == kind and value['sourceCommit'] == commit)
    require(isinstance(value['files'], list) and 1 <= len(value['files']) <= MAX_FILES)
    result = {}
    total = 0
    for item in value['files']:
        require(set(item) == {'path', 'mode', 'size', 'sha256'})
        name = item['path']
        require(isinstance(name, str) and len(name) <= 240 and re.fullmatch(r'[A-Za-z0-9_./+-]+', name))
        require(all(part not in ('', '.', '..') for part in name.split('/')) and allowed(name, kind))
        require(name not in result and item['mode'] in ('444', '555'))
        require(type(item['size']) is int and item['size'] >= 0 and re.fullmatch(r'[a-f0-9]{64}', item['sha256']))
        total += item['size']
        require(total <= (MAX_BYTES if kind == 'dependencies' else 128 * 1024 ** 2))
        result[name] = item
    for name in result:
        parts = name.split('/')[:-1]
        while parts:
            require('/'.join(parts) not in result)
            parts.pop()
    return result


def pack(root, archive, kind, commit):
    require(kind in ('app', 'dependencies') and (re.fullmatch(r'[a-f0-9]{40}', commit) if kind == 'app' else commit == '-'))
    files = []
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs:
            require(stat.S_ISDIR(os.lstat(os.path.join(directory, name)).st_mode))
        for name in names:
            filename = os.path.join(directory, name)
            info = os.lstat(filename)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
            files.append({'path': os.path.relpath(filename, root), 'mode': '555' if info.st_mode & 0o111 else '444',
                          'size': info.st_size, 'sha256': digest(filename)})
    value = {'schemaVersion': 1, 'kind': kind, 'sourceCommit': commit, 'files': sorted(files, key=lambda item: item['path'])}
    entries(value, kind, commit)
    total = sum(item['size'] for item in files)
    data = (json.dumps(value, separators=(',', ':')) + '\n').encode()
    require(len(data) <= 8 * 1024 ** 2)
    # Both gzip and tar metadata are independent of the build path and wall clock.
    with open(archive, 'xb') as output, gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as target:
            member = tarfile.TarInfo(MANIFEST)
            member.size, member.mode = len(data), 0o444
            target.addfile(member, io.BytesIO(data))
            for entry in value['files']:
                member = tarfile.TarInfo(entry['path'])
                member.size, member.mode = entry['size'], int(entry['mode'], 8)
                with open(os.path.join(root, entry['path']), 'rb') as source:
                    target.addfile(member, source)

    return total

def unpack(archive, root, kind, commit, expected, unpacked_size=None):
    require(os.path.isabs(root) and not os.path.lexists(root) and digest(archive) == expected)
    os.mkdir(root, 0o700)
    with tarfile.open(archive, 'r|gz') as source:
        first = source.next()
        require(first is not None and first.name == MANIFEST and first.isreg() and first.size <= 8 * 1024 ** 2)
        inventory = entries(json.loads(source.extractfile(first).read()), kind, commit)
        if unpacked_size is not None:
            require(sum(item['size'] for item in inventory.values()) == int(unpacked_size))
        seen = set()
        for member in source:
            if member is first:
                continue
            require(member.name in inventory and member.name not in seen and member.isreg())
            entry = inventory[member.name]
            require(member.size == entry['size'] and member.mode == int(entry['mode'], 8))
            filename = os.path.join(root, member.name)
            os.makedirs(os.path.dirname(filename), mode=0o700, exist_ok=True)
            result = hashlib.sha256()
            with source.extractfile(member) as incoming, open(filename, 'xb') as outgoing:
                while chunk := incoming.read(1024 * 1024):
                    result.update(chunk)
                    outgoing.write(chunk)
                outgoing.flush()
                os.fsync(outgoing.fileno())
            require(result.hexdigest() == entry['sha256'])
            os.chmod(filename, int(entry['mode'], 8))
            seen.add(member.name)
        require(seen == set(inventory))
    for directory, _, _ in os.walk(root, topdown=False):
        os.chmod(directory, 0o555)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'pack' and len(sys.argv) == 6:
            print(json.dumps({'unpackedSize': pack(*sys.argv[2:])}))
        elif sys.argv[1] == 'unpack' and len(sys.argv) in (7, 8):
            unpack(*sys.argv[2:])
        else:
            raise ValueError()
    except OSError as error:
        print('archive_disk_full' if error.errno in (errno.ENOSPC, errno.EDQUOT) else 'archive_io_failed', file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('release package verification failed', file=sys.stderr)
        sys.exit(1)
