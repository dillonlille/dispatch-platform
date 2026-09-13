'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { platformRelease } = require('../src/platform-release-catalog');

test('a platform release binds readable notes and Core artifacts to the same runtime commit and digest', () => {
  const runtime = { sourceCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` };
  const release = { version: '0.0.2', publishedAt: '2026-09-05T00:00:00.000Z', sourceCommit: runtime.sourceCommit,
    runtimeImageDigest: runtime.imageDigest, changelog: [{ kind: 'fixed', title: 'Clearer setup messages', description: '' }],
    core: { artifactPath: '/opt/dispatch-platform/releases/dispatch_update_2/core-artifact', manifestSha256: 'c'.repeat(64) } };
  assert.equal(platformRelease('dispatch_update_2', release, runtime).version, '0.0.2');
  assert.throws(() => platformRelease('dispatch_update_2', release, { ...runtime, sourceCommit: 'd'.repeat(40) }), /platform_release_invalid/);
  assert.throws(() => platformRelease('dispatch_update_2', { ...release, core: { ...release.core, artifactPath: '/tmp/untrusted' } }, runtime), /platform_release_invalid/);
  assert.throws(() => platformRelease('dispatch_update_2', { ...release, version: 'dispatch_current_1' }, runtime), /platform_release_invalid/);
  assert.throws(() => platformRelease('dispatch_update_2', { ...release, changelog: [] }, runtime), /platform_release_invalid/);
});
