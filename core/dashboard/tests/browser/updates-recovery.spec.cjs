const { test, expect } = require('@playwright/test');

test('changelog remains readable across rollout phases and Core restarts without operational controls', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const mutations = []; let disconnected = false;
  const release = { id: 'dispatch_0.0.8', version: '0.0.8', publishedAt: '2026-09-08T00:00:00.000Z', state: 'rolling_out',
    changelog: [{ kind: 'fixed', title: 'Saved connections recover correctly', description: 'Retry an interrupted connection.' }] };
  const rollout = { release: release.id, version: release.version, status: 'running', phase: 'backups',
    core: { status: 'queued', message: null }, total: 2, updated: 0, members: [], activity: [] };
  await page.route('**/api/platform/updates*', route => {
    if (route.request().method() !== 'GET') mutations.push(route.request().method());
    return route.fulfill({ status: disconnected ? 503 : 200, contentType: 'application/json',
      json: disconnected ? { ok: false, error: { code: 'unavailable' } } : { ok: true, data: {
        enabled: true, releases: [], releaseHistory: [release], displayedRelease: release, rollout,
      } } });
  });
  await page.goto('/');
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.desktop-sidebar').getByRole('link', { name: 'Updates', exact: true }).click();
  const content = page.locator('#platform-updates-content');
  const refresh = () => page.getByRole('button', { name: 'Refresh', exact: true }).click();
  for (const phase of ['backups', 'core', 'verify_core', 'dsps', 'complete']) {
    rollout.phase = phase;
    if (phase === 'complete') { rollout.status = 'completed'; release.state = 'installed'; }
    await refresh();
    await expect(content.getByText('Saved connections recover correctly')).toBeVisible();
    await expect(content.getByRole('button', { name: /^(Install update|Start rollout|Pause rollout|Resume rollout|Retry download)$/ })).toHaveCount(0);
    await expect(content.locator('.update-live-rollout, .update-stage-list')).toHaveCount(0);
    if (phase === 'core') {
      disconnected = true; await refresh();
      await expect(content.getByRole('status')).toContainText('Showing the last loaded changelog');
      await expect(content.getByText('Saved connections recover correctly')).toBeVisible();
      disconnected = false; await refresh();
      await expect(content.locator('.update-reconnecting')).toHaveCount(0);
    }
    rollout.status = 'paused'; await refresh();
    await expect(content.getByRole('button', { name: 'Resume rollout' })).toHaveCount(0);
    rollout.status = 'running';
  }
  await expect(content.locator('.update-release-meta')).toContainText('Installed');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(mutations).toEqual([]); expect(errors).toEqual([]);
});
