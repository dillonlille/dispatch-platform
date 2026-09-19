// Owner-approved v0.0.10 exception during npm's 2026-09-19 maintenance.
// These dependencies passed npm audit with zero findings in run 35455082310
// at 16:29 UTC; only the platform version changed. Remove after the release.
export function releaseAuditException(
  version: string,
  lockfileDigest: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  const release =
    env.GITHUB_EVENT_NAME === 'pull_request' &&
    ((env.GITHUB_BASE_REF === 'main' && env.GITHUB_HEAD_REF === 'release/v0.0.10') ||
      (env.GITHUB_BASE_REF === 'dev' && env.GITHUB_HEAD_REF === 'chore/sync-main-v0.0.10'));
  const push =
    env.GITHUB_EVENT_NAME === 'push' &&
    ['refs/heads/main', 'refs/heads/dev'].includes(env.GITHUB_REF ?? '');
  return (
    env.CI === 'true' &&
    env.GITHUB_REPOSITORY === 'dillonlille/dispatch-platform' &&
    (release || push) &&
    version === '0.0.10' &&
    now >= Date.parse('2026-09-19T17:00:00Z') &&
    now < Date.parse('2026-09-19T19:00:00Z') &&
    lockfileDigest === '533c9421c74833caa542ed37f057f014be458445946451ce4c811647bc4b11b8'
  );
}
