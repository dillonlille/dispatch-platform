import { test, expect } from '@playwright/test';
import { startPreview } from '../../tooling/dev-server.js';
import { built, demo } from '../support.js';

test('a demo preview link opens the requested page in fresh browsers without signing in', async ({
  browser,
}) => {
  const preview = await startPreview({ host: '127.0.0.1', port: 0, binary: built.binary });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    for (const context of contexts) {
      const page = await context.newPage();
      await page.goto(`${preview.previewUrl}#account`);
      await expect(page).toHaveURL(`${preview.origin}/#account`);
      await expect(page.getByRole('tab', { name: 'Profile', exact: true })).toBeVisible();
      await expect(page.locator('.profile-badge')).toContainText(demo.email);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.profile-badge')).toContainText(demo.email);
    }
    const sessions = await Promise.all(contexts.map((context) => context.cookies()));
    expect(sessions[0]![0]!.value).not.toBe(sessions[1]![0]!.value);
    const manual = await browser.newContext();
    try {
      const page = await manual.newPage();
      await page.goto(preview.origin);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    } finally {
      await manual.close();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await preview.close();
  }
});
