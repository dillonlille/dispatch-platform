import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseAuditException } from '../tooling/release-audit-exception.js';

const lockfile = '533c9421c74833caa542ed37f057f014be458445946451ce4c811647bc4b11b8';
const during = Date.parse('2026-09-19T17:30:00Z');
const env = {
  CI: 'true',
  GITHUB_REPOSITORY: 'dillonlille/dispatch-platform',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_BASE_REF: 'main',
  GITHUB_HEAD_REF: 'release/v0.0.10',
};

test('the approved npm audit exception expires and cannot cover another version or lockfile', () => {
  assert(releaseAuditException('0.0.10', lockfile, env, during));
  for (const at of ['2026-09-19T16:59:59Z', '2026-09-19T19:00:00Z', '2026-09-20T00:00:00Z'])
    assert(!releaseAuditException('0.0.10', lockfile, env, Date.parse(at)));
  assert(!releaseAuditException('0.0.11', lockfile, env, during));
  assert(!releaseAuditException('0.0.10', '0'.repeat(64), env, during));
});

test('the npm audit exception is limited to this repository release, sync and trusted pushes', () => {
  assert(
    releaseAuditException(
      '0.0.10',
      lockfile,
      { ...env, GITHUB_BASE_REF: 'dev', GITHUB_HEAD_REF: 'chore/sync-main-v0.0.10' },
      during,
    ),
  );
  for (const ref of ['refs/heads/main', 'refs/heads/dev'])
    assert(
      releaseAuditException(
        '0.0.10',
        lockfile,
        { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref },
        during,
      ),
    );
  for (const overrides of [
    { CI: 'false' },
    { GITHUB_REPOSITORY: 'someone/dispatch-platform' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'schedule' },
    { GITHUB_HEAD_REF: 'another-change' },
    { GITHUB_BASE_REF: 'dev' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/another-change' },
  ])
    assert(!releaseAuditException('0.0.10', lockfile, { ...env, ...overrides }, during));
});
