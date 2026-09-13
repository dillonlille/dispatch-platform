#!/usr/bin/env python3
"""Download only a configured, digest-pinned public dependency bundle."""
import hashlib,json,os,pathlib,re,sys,tarfile,urllib.parse,urllib.request

def main():
    config=json.loads(pathlib.Path(__file__).with_name('platform-dependencies.json').read_text())
    url=os.environ.get('DISPATCH_PLATFORM_PACKAGES_URL') or config['url']
    digest=os.environ.get('DISPATCH_PLATFORM_PACKAGES_SHA256') or config['sha256']
    if not url or not digest or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('Configure the Core platform package URL and SHA-256 first')
    if urllib.parse.urlparse(url).scheme!='https':raise ValueError('HTTPS required')
    target=pathlib.Path(sys.argv[1]).resolve()
    if target.exists():raise ValueError('Output must be a new directory')
    target.mkdir(parents=True,mode=0o700)
    archive=target.with_suffix('.tar.gz')
    with urllib.request.urlopen(url,timeout=60) as response,archive.open('xb') as output:
        total=0;actual=hashlib.sha256()
        while block:=response.read(1024*1024):
            total+=len(block)
            if total>128*1024*1024:raise ValueError('Bundle too large')
            output.write(block);actual.update(block)
    if actual.hexdigest()!=digest:raise ValueError('Bundle digest mismatch')
    with tarfile.open(archive) as handle:
        members=handle.getmembers()
        if len(members)>10000 or sum(item.size for item in members)>256*1024*1024:raise ValueError('Bundle too large')
        for member in members:
            name=pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not(member.isfile() or member.isdir()):raise ValueError('Invalid bundle entry')
        for member in members:
            # Explicitly reject links and paths above before using the portable extractor.
            handle.extract(member,target,filter='data')
    if not(target/'install.cjs').is_file():raise ValueError('Bundle installer missing')
    print(json.dumps({'ok':True,'sha256':digest}))
if __name__=='__main__':main()
