"""Fetch the repository-pinned Chrome archive into a new disposable build directory."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request
import zipfile


def prepare(destination):
    pins = json.loads((Path(__file__).resolve().parent.parent / 'runtime-dependencies.json').read_text())
    destination = Path(destination)
    if not destination.is_absolute() or destination.exists():
        raise ValueError('new_absolute_destination_required')
    url = f"https://storage.googleapis.com/chrome-for-testing-public/{pins['chrome']}/linux64/chrome-linux64.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(destination.parent).free < 2 * 1024**3:
        raise ValueError('browser_build_insufficient_space')
    with tempfile.TemporaryDirectory(prefix='dispatch-browser-', dir=destination.parent) as stage:
        archive = Path(stage) / 'chrome.zip'
        with urllib.request.urlopen(url, timeout=120) as incoming, archive.open('xb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        with archive.open('rb') as source:
            checksum = hashlib.file_digest(source, 'sha256').hexdigest()
        if checksum != pins['chromeArchiveSha256']:
            raise ValueError('browser_checksum_failed')
        with zipfile.ZipFile(archive) as source:
            # The archive is authenticated above; still restrict paths and links.
            for item in source.infolist():
                if not item.filename.startswith('chrome-linux64/') or any(x in ('..', '') for x in item.filename.rstrip('/').split('/')) or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('browser_archive_invalid')
            source.extractall(stage)
            for item in source.infolist():
                file = Path(stage) / item.filename
                file.chmod(0o755 if file.is_dir() or (item.external_attr >> 16) & 0o111 else 0o644)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(Path(stage) / 'chrome-linux64'), destination)
    print(destination)


if __name__ == '__main__':
    prepare(sys.argv[1])
