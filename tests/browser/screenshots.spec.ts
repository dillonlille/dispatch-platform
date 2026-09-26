import fs from 'node:fs';
import path from 'node:path';
import { routeMeta } from '../../dashboard/src/app/route-meta.js';
import { test, expect, login, openDsp } from './fixtures.js';

// Not a test: `npm run pr:screenshots -- capture` runs it to photograph the named screens of
// the built dashboard, from the fixture server, for a PR's Screenshots section. In the suite,
// without the variables, it skips itself.
const screens = (process.env.DISPATCH_SCREENSHOTS ?? '').split(',').filter(Boolean);
const output = process.env.DISPATCH_SCREENSHOT_DIR ?? '';
const scheme = process.env.DISPATCH_SCREENSHOT_SCHEME === 'dark' ? 'dark' : 'light';
test.skip(
  screens.length === 0 || output === '',
  'Set DISPATCH_SCREENSHOTS and DISPATCH_SCREENSHOT_DIR to capture screens',
);
test.use({ viewport: { width: 1920, height: 1080 } });

test('captures the named screens', async ({ page }) => {
  test.slow();
  const unknown = screens.filter((id) => !routeMeta.some((route) => route.id === id));
  expect(unknown, `unknown screens; the ids are in app/route-meta.ts`).toEqual([]);
  fs.mkdirSync(output, { recursive: true });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await login(page);
  let dsp = '';
  const titles: Record<string, string> = {};
  for (const id of screens) {
    const route = routeMeta.find((candidate) => candidate.id === id)!;
    if (route.scope === 'dsp') {
      if (!dsp) {
        await openDsp(page, 'Northline Logistics');
        await expect(page).toHaveURL(/#dsp\/[^/]+\//);
        dsp = new URL(page.url()).hash.split('/')[1]!;
      }
      await page.goto(`/#dsp/${dsp}/${id}`);
    } else {
      await page.goto(`/#${id}`);
    }
    // The page is drawn once nothing is loading; fonts and the last layout settle after.
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 15000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, `${id}.png`), animations: 'disabled' });
    titles[id] = route.label;
  }
  fs.writeFileSync(path.join(output, 'index.json'), JSON.stringify(titles, null, 2) + '\n');
});
