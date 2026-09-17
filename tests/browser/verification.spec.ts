import { test, expect } from '@playwright/test';

test.use({ hasTouch: true });

test('Paycom window scales input, supports drag/scroll/keyboard, and only continues on Submit', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const url = message.location().url;
    const expectedResponse =
      (message.text().includes('401') && url.endsWith('/api/session')) ||
      (message.text().includes('409') && url.endsWith('/api/dsp/connections/paycom/submit'));
    if (message.type() === 'error' && !expectedResponse) errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  // This local provider screen exercises the viewer without any external CAPTCHA.
  const provider = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await provider.setContent(
    `<html><head><style>body{margin:0;font:20px Arial;background:#f6f7fa;color:#233029}header{padding:28px;border-bottom:1px solid #ddd;background:white}main{position:relative;height:1700px}#challenge{position:absolute;left:620px;top:100px;width:360px;padding:26px;background:white;border:1px solid #c9d2d9;border-radius:12px}h2{margin:0 0 14px}p{font-size:18px}button{width:110px;height:100px;margin:5px;border:3px solid white;border-radius:6px;background:#829cc5;cursor:pointer}button.selected{border-color:#184cb4;background:#cadeff}#drag{position:absolute;left:1050px;top:240px;width:180px;height:60px;background:#f0e1be;border-radius:9px;display:grid;place-items:center}input{position:absolute;left:640px;top:520px;font-size:24px;width:290px;padding:12px}</style></head><body><header>Paycom · Demo DSP</header><main><div id="challenge"><h2>Verify your session</h2><p>Select the blue square to complete this local test.</p><button aria-label="Blue square" onclick="this.classList.toggle('selected');window.solved=this.classList.contains('selected')"></button><button style="background:#d9b39e" aria-label="Tan square"></button><p>Then press Submit in Dispatch.</p></div><div id="drag">Drag to move</div><input aria-label="Provider text" placeholder="Type here"></main><script>const d=document.querySelector('#drag');d.onpointerdown=e=>{d.setPointerCapture(e.pointerId);window.dragging=true};d.onpointermove=e=>{if(window.dragging){window.dragX=e.clientX;d.textContent='Moved '+e.clientX}};d.onpointerup=()=>{window.dragging=false}</script></body></html>`,
  );
  const sessionId = 'run_' + 'a'.repeat(32);
  let ready = false,
    submits = 0;
  const inputs: { kind: string; x?: number; y?: number; phase?: string }[] = [];
  await page.route('**/api/dsp/connections', (route) =>
    route.fulfill({
      json: {
        provider: 'paycom',
        enabled: true,
        status: ready ? 'ready' : 'needs_verification',
        error: null,
        updatedAt: new Date().toISOString(),
        lastVerifiedAt: null,
        accountLabel: 'DEMO',
        ...(!ready ? { verificationSessionId: sessionId } : {}),
      },
    }),
  );
  await page.route('**/api/dsp/connections/paycom/screenshot?*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('sessionId')).toBe(sessionId);
    await route.fulfill({
      json: { sessionId, image: (await provider.screenshot()).toString('base64') },
    });
  });
  await page.route('**/api/dsp/connections/paycom/assist', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.sessionId).toBe(sessionId);
    const input = body.input;
    inputs.push(input);
    if (input.kind === 'pointer') {
      await provider.mouse.move(input.x, input.y);
      if (input.phase === 'down') await provider.mouse.down();
      if (input.phase === 'up') await provider.mouse.up();
    }
    if (input.kind === 'scroll') {
      await provider.mouse.move(input.x, input.y);
      await provider.mouse.wheel(input.deltaX, input.deltaY);
    }
    if (input.kind === 'key')
      await provider.keyboard.press((input.shift ? 'Shift+' : '') + input.key);
    if (input.kind === 'type') await provider.keyboard.insertText(input.text);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/dsp/connections/paycom/submit', async (route) => {
    submits++;
    expect(route.request().postDataJSON()).toEqual({ sessionId });
    ready = await provider.evaluate(() =>
      Boolean((window as unknown as { solved?: boolean }).solved),
    );
    await route.fulfill(
      ready
        ? { json: { status: 'ready' } }
        : { status: 409, json: { error: 'verification_incomplete' } },
    );
  });
  try {
    await page.goto('/');
    await expect(page).toHaveTitle(/Dispatch/);
    await page.getByLabel('Email address').fill('owner@dispatch.test');
    await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: /Northline Logistics/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Complete Paycom verification' });
    const window = dialog.getByRole('application', { name: 'Paycom verification browser' });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => window.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(1600);
    await dialog.screenshot({ path: test.info().outputPath('dispatch-verification-desktop.png') });
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Paycom still needs verification');
    await expect(dialog).toBeVisible();
    const point = async (x: number, y: number) => {
      const bounds = (await window.boundingBox())!;
      return { x: bounds.x + (x * bounds.width) / 1600, y: bounds.y + (y * bounds.height) / 1000 };
    };
    const button = await provider.getByRole('button', { name: 'Blue square' }).boundingBox();
    const target = await point(button!.x + 55, button!.y + 50);
    await page.mouse.click(target.x, target.y);
    await expect
      .poll(() =>
        provider.evaluate(() => Boolean((globalThis as unknown as { solved?: boolean }).solved)),
      )
      .toBe(true);
    expect(submits).toBe(1);
    const down = inputs.find((input) => input.kind === 'pointer' && input.phase === 'down')!;
    expect(down.x).toBeCloseTo(button!.x + 55, 0);
    expect(down.y).toBeCloseTo(button!.y + 50, 0);
    const drag = (await provider.locator('#drag').boundingBox())!;
    const from = await point(drag.x + 20, drag.y + 30),
      to = await point(drag.x + 120, drag.y + 30);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => provider.evaluate(() => (globalThis as unknown as { dragX: number }).dragX))
      .toBeGreaterThan(drag.x + 100);
    const field = (await provider.getByLabel('Provider text').boundingBox())!;
    const fieldPoint = await point(field.x + 20, field.y + 25);
    await page.mouse.click(fieldPoint.x, fieldPoint.y);
    await page.keyboard.type('Hello');
    await expect(provider.getByLabel('Provider text')).toHaveValue('Hello');
    await page.keyboard.press('Backspace');
    await expect(provider.getByLabel('Provider text')).toHaveValue('Hell');
    await page.mouse.wheel(0, 220);
    await expect.poll(() => provider.evaluate(() => globalThis.scrollY)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Fit window', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fit window', exact: true }).click();
    // Touch input uses the same coordinates after the window has been resized.
    const mobileField = (await provider.getByLabel('Provider text').boundingBox())!;
    const mobilePoint = await point(mobileField.x + 20, mobileField.y + 25);
    await page.touchscreen.tap(mobilePoint.x, mobilePoint.y);
    await expect(provider.getByLabel('Provider text')).toBeFocused();
    await dialog.getByLabel('Text to type in Paycom').fill('!');
    await dialog.getByRole('button', { name: 'Type', exact: true }).click();
    await expect(provider.getByLabel('Provider text')).toHaveValue(/!/);
    await dialog.screenshot({ path: test.info().outputPath('dispatch-verification-mobile.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Open verification window' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Your Paycom connection is ready to use.')).toBeVisible();
    expect(submits).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await provider.close();
  }
});
