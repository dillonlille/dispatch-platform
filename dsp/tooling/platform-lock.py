#!/usr/bin/env python3
"""Resolve a reviewed dependency lock; source builds are for development CI only."""
import json
import os
import pathlib
import re
import sys
import urllib.parse


def resolve(config, production=False):
    url, digest = config.get('url'), config.get('sha256')
    if url is not None or digest is not None:
        parsed = urllib.parse.urlparse(url or '')
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or not re.fullmatch(r'[a-f0-9]{64}', digest or ''):
            raise ValueError('A release dependency needs an HTTPS URL and SHA-256')
        return {'mode': 'release'}
    if production:
        raise ValueError('DSP publication requires a published Core platform bundle; pin its URL and SHA-256 in a PR first')
    source = config.get('developmentSource') or {}
    repository, commit = source.get('repository', ''), source.get('commit', '')
    if repository != 'dispatch-core' or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Development CI requires an exact Core repository commit')
    return {'mode': 'source', 'repository': repository, 'commit': commit}


if __name__ == '__main__':
    config = json.loads(pathlib.Path(__file__).with_name('platform-dependencies.json').read_text())
    result = resolve(config, '--production' in sys.argv)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for key, value in result.items():
                output.write(f'{key}={value}\n')
    print(json.dumps(result))
