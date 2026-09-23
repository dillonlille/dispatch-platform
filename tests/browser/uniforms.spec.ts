import { test, expect, demo, login, openDsp } from './fixtures.js';
import type { UniformInventory } from '../../shared/contracts/uniforms.js';

test('two users see rapid stock changes live, retries count once, and reopening keeps saved quantities', async ({
  page,
  browser,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const initialized = await owner.post('/api/dsp/uniforms/initialize', { starter: true });
  expect(initialized.status).toBe(200);
  // HTTP previews have getRandomValues but no secure-context-only randomUUID.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  await login(page);
  await openDsp(page, dsp.name);
  await page.getByRole('link', { name: 'Uniform Inventory', exact: true }).click();
  const otherContext = await browser.newContext({ baseURL: dispatch.env.DISPATCH_ORIGIN });
  try {
    const other = await otherContext.newPage();
    await other.goto(dispatch.env.DISPATCH_ORIGIN!);
    await login(other, demo.member);
    await other.getByRole('link', { name: 'Uniform Inventory', exact: true }).click();
    const counter = (scope: typeof page) =>
      scope.getByLabel('Short Sleeve Polo, Men’s, XS in stock', { exact: true });
    const add = page.getByRole('button', {
      name: 'Add one Short Sleeve Polo, Men’s, XS',
      exact: true,
    });
    const remove = page.getByRole('button', {
      name: 'Remove one Short Sleeve Polo, Men’s, XS',
      exact: true,
    });
    await expect(counter(page)).toHaveText('0');
    await expect(counter(other)).toHaveText('0');
    await expect(remove).toBeDisabled();
    await expect(other.getByRole('button', { name: /^Add one/ })).toHaveCount(0);
    // Five actual clicks are allowed while responses are outstanding.
    await add.evaluate((button) => {
      for (let i = 0; i < 5; i++) (button as HTMLButtonElement).click();
    });
    await expect(counter(page)).toHaveText('5');
    await expect(counter(other)).toHaveText('5', { timeout: 3000 });
    let dropped = false;
    await page.route('**/api/dsp/uniforms/stock/*', async (route) => {
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await add.click();
    await expect(counter(page)).toHaveText('6');
    await expect(counter(other)).toHaveText('6');
    await expect(page.locator('.uniform-counter[aria-busy="true"]')).toHaveCount(0);
    await page.unroute('**/api/dsp/uniforms/stock/*');
    await remove.click();
    await expect(counter(other)).toHaveText('5');
    await page.reload();
    await expect(counter(page)).toHaveText('5');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('5 in stock');
    await expect(page.getByRole('dialog').locator('.uniform-history li')).toHaveCount(8);
  } finally {
    await otherContext.close();
  }
});

test('custom fits, sizes, categories and names update other users without overwriting counts', async ({
  page,
  browser,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  await login(page);
  await openDsp(page, dsp.name);
  await page.getByRole('link', { name: 'Uniform Inventory', exact: true }).click();
  await page.getByRole('button', { name: 'Add uniform', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Uniform name', { exact: true }).fill('Rain gear');
  await editor.getByLabel('Category', { exact: true }).fill('Wet weather');
  await editor.getByLabel('Add Men’s sizes', { exact: true }).fill('M, XL');
  await editor.getByLabel('Add Women’s sizes', { exact: true }).fill('S, M');
  await editor.getByRole('checkbox', { name: 'Unisex', exact: true }).check();
  await editor.getByLabel('Add Unisex sizes', { exact: true }).fill('XS/S');
  await editor.getByRole('button', { name: 'Create uniform', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Wet weather', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add one Rain gear, Women’s, XL', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Add one Rain gear, Unisex, XS/S', exact: true }).click();
  await expect(page.getByLabel('Rain gear, Unisex, XS/S in stock', { exact: true })).toHaveText(
    '1',
  );
  const context = await browser.newContext({ baseURL: dispatch.env.DISPATCH_ORIGIN });
  try {
    const other = await context.newPage();
    await other.goto(dispatch.env.DISPATCH_ORIGIN!);
    await login(other, demo.member);
    await other.getByRole('link', { name: 'Uniform Inventory', exact: true }).click();
    await expect(other.getByLabel('Rain gear, Unisex, XS/S in stock', { exact: true })).toHaveText(
      '1',
    );
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByLabel('Uniform name', { exact: true }).fill('Weather jacket');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(other.getByRole('heading', { name: 'Weather jacket', exact: true })).toBeVisible();
    await expect(
      other.getByLabel('Weather jacket, Unisex, XS/S in stock', { exact: true }),
    ).toHaveText('1');
  } finally {
    await context.close();
  }
});

test('disconnected and returning tabs retain known counts and block edits until synchronized', async ({
  page,
  context,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const initialized = await owner.post('/api/dsp/uniforms/initialize', { starter: true });
  const uniform = (initialized.value as UniformInventory).uniforms[0]!;
  const variant = uniform.variants.find((v) => v.fit === 'men' && v.size === 'XS')!;
  await login(page);
  await openDsp(page, dsp.name);
  await page.getByRole('link', { name: 'Uniform Inventory', exact: true }).click();
  const counter = page.getByLabel('Short Sleeve Polo, Men’s, XS in stock', { exact: true });
  await expect(counter).toHaveText('0');
  await context.setOffline(true);
  await expect(page.locator('.uniform-live')).toHaveText('Reconnecting…');
  await expect(counter).toHaveText('0');
  await expect(
    page.getByRole('button', { name: 'Add one Short Sleeve Polo, Men’s, XS', exact: true }),
  ).toBeDisabled();
  await owner.post(`/api/dsp/uniforms/stock/${variant.id}`, {
    delta: 1,
    requestId: crypto.randomUUID(),
  });
  await context.setOffline(false);
  await expect(counter).toHaveText('1');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await owner.post(`/api/dsp/uniforms/stock/${variant.id}`, {
    delta: 1,
    requestId: crypto.randomUUID(),
  });
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(counter).toHaveText('2');
});
