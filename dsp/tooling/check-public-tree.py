#!/usr/bin/env python3
"""Check every entry, including ignored/hidden files, without printing contents."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat

def inspect(root, policy):
    root = root.resolve()
    findings = []
    inventory = []
    forbidden = {'.git', 'node_modules', '__pycache__', '.env', '.npmrc', '.ssh'}
    if policy.get('profile') != 'repository': forbidden.add('.github')
    private_extensions = {'.sqlite', '.sqlite3', '.db', '.log', '.har', '.pem', '.key', '.p12', '.pfx'}
    patterns = [(label, re.compile(expression, re.I)) for label, expression in policy.get('patterns', {}).items()]
    literal_patterns = [(f'private-term-{i}', re.compile(re.escape(value), re.I)) for i, value in enumerate(policy.get('privateTerms', []))]
    patterns += literal_patterns
    patterns += [
        ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
        ('github-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b')),
    ]
    allowed_binary = policy.get('allowedBinaries', {})
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            file = pathlib.Path(base, name)
            relative = file.relative_to(root).as_posix()
            info = file.lstat()
            def finding(reason): findings.append({'path': relative, 'rule': reason})
            if file.is_symlink():
                finding('symlink'); continue
            if name in forbidden or file.suffix.lower() in private_extensions:
                finding('private-or-generated-entry')
            for label, expression in patterns:
                if expression.search(relative): finding(label + '-filename')
            if stat.S_ISDIR(info.st_mode): continue
            if not stat.S_ISREG(info.st_mode):
                finding('special-file'); continue
            if info.st_nlink != 1: finding('hardlink')
            content = file.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            inventory.append({'path': relative, 'bytes': len(content), 'sha256': digest})
            try: text = content.decode('utf-8')
            except UnicodeDecodeError:
                if allowed_binary.get(relative) != digest: finding('unreviewed-binary')
                continue
            for label, expression in patterns:
                if expression.search(text): finding(label)
    return {'ok': not findings, 'files': len(inventory), 'findings': findings, 'inventory': inventory,
            'scope': 'Full tree scan with private policy; complements manual review and secret scanning.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--policy', required=True, type=pathlib.Path)
    parser.add_argument('--report', required=True, type=pathlib.Path)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.policy.resolve().is_relative_to(root) or args.report.resolve().is_relative_to(root):
        parser.error('Keep the private policy and report outside the public tree')
    result = inspect(root, json.loads(args.policy.read_text()))
    args.report.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['ok', 'files', 'findings']}))
    raise SystemExit(0 if result['ok'] else 1)
