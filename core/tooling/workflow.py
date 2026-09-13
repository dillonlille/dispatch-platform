#!/usr/bin/env python3
"""Read-only PR/release facts for the human-approved Dispatch workflow."""
import argparse,json,pathlib,subprocess

def run(*args):
    return subprocess.check_output(args,text=True).strip()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('command',choices=['pr-details','release-status'])
    parser.add_argument('--repo',required=True,help='OWNER/dispatch-core or OWNER/dispatch-dsp')
    parser.add_argument('--pr',type=int)
    args=parser.parse_args()
    import re
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/dispatch-(core|dsp)',args.repo):parser.error('Use the selected Core or DSP repository')
    root=pathlib.Path(__file__).resolve().parents[1]
    expected=json.loads((root/'package.json').read_text())['name']
    if args.repo.split('/')[1]!=expected:parser.error('Repository must match this project')
    if args.command=='pr-details':
        if not args.pr:parser.error('--pr is required')
        print(run('gh','pr','view',str(args.pr),'--repo',args.repo,'--json','number,title,url,baseRefName,headRefName,headRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup'))
    else:
        print(run('gh','release','list','--repo',args.repo,'--limit','10','--json','tagName,name,publishedAt,isLatest,isPrerelease'))
        print('Report the deployed Core/DSP versions separately. Ask the user for the next version before preparing a release.')

if __name__=='__main__':main()
