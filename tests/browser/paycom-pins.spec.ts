import { test, expect } from './fixtures.js';
import fs from 'node:fs';
const auth = fs
  .readFileSync('backend/src/core/browsers/paycom/auth.js', 'utf8')
  .trim()
  .replace(/;$/, '');
function expression(input: Record<string, unknown>) {
  return `(${auth})(${JSON.stringify({ origin, ...input })})`;
}
const classify = (observation: { state: string }) => observation.state;
const loginExpression = (credentials: Record<string, string>) =>
  expression({ action: 'login', credentials });
const challengeExpression = (credentials: Record<string, string>, challenge: { index: number }[]) =>
  expression({ action: 'pins', credentials, challenge });
const origin = 'https://www.paycomonline.net';
const SNAPSHOT = expression({ action: 'observe' });
const securityPath = '/v4/cl/web.php/security/security-question/login';

function challenge(first = 2, second = 5) {
  return `<form method="post" action="${securityPath}">
    <label for="first">Unique pin #${first}</label><input id="first" type="password" name="firstSecurityQuestion">
    <label for="second">Unique pin #${second}</label><input id="second" type="password" name="secondSecurityQuestion">
    <input type="hidden" name="firstIndex" value="${first}"><input type="hidden" name="secondIndex" value="${second}">
    <button name="continue" type="submit">Continue</button></form>`;
}

test('Paycom credential entry invokes the provider submit handler on the exact login form', async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  const posts: URLSearchParams[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      posts.push(new URLSearchParams(request.postData()!));
      await route.fulfill({ contentType: 'text/html', body: 'Received' });
    } else
      await route.fulfill({
        contentType: 'text/html',
        body: `<form method="post" action="/v4/cl/cl-loginproc.php"><input name="clientcode"><input name="username"><input name="password" type="password"><button>Sign in</button></form><script>document.querySelector('form').onsubmit=event=>{const token=document.createElement('input');token.name='request-token';token.value='fixture-token';event.target.appendChild(token)}</script>`,
      });
  });
  await page.goto(origin + '/v4/cl/cl-login.php');
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('logged_out');
  await page.evaluate(
    loginExpression({ clientCode: 'FIXTURE', username: 'test', password: 'test-password' }),
  );
  await expect.poll(() => posts.length).toBe(1);
  expect(Object.fromEntries(posts[0]!)).toEqual({
    clientcode: 'FIXTURE',
    username: 'test',
    password: 'test-password',
    'request-token': 'fixture-token',
  });
});

test('Paycom PIN recognition verifies numbered fields and exact values without assigning secrets', async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  await context.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: challenge() }),
  );
  await page.goto(origin + securityPath);
  const observation = await page.evaluate<{
    state: string;
    snapshot: { challenge: { index: number }[] };
  }>(SNAPSHOT);
  const snapshot = observation.snapshot;
  expect(classify(observation)).toBe('security_questions_required');
  expect(snapshot.challenge.map((field: { index: number }) => field.index)).toEqual([2, 5]);
  const credentials = { pin2: '00Two !', pin5: ' Five? ' };
  expect(
    (await page.evaluate<{ status: string }>(challengeExpression(credentials, snapshot.challenge)))
      .status,
  ).toBe('challenge_layout_changed');
  await expect(page.locator('#first')).toHaveValue('');
  await page.locator('#first').pressSequentially(credentials.pin2);
  await page.locator('#second').pressSequentially(credentials.pin5);
  expect(
    (await page.evaluate<{ status: string }>(challengeExpression(credentials, snapshot.challenge)))
      .status,
  ).toBe('native_challenge_ready');
  await page.locator('input[name="secondIndex"]').evaluate((field: HTMLInputElement) => {
    field.value = '4';
  });
  expect(
    (await page.evaluate<{ status: string }>(challengeExpression(credentials, snapshot.challenge)))
      .status,
  ).toBe('challenge_layout_changed');
});

test('Paycom classifier requires authenticated page markers and keeps verification manual', async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  await context.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: challenge() }),
  );
  await page.goto(origin + securityPath);
  await page.locator('body').evaluate((element) => {
    element.insertAdjacentHTML('beforeend', '<input autocomplete="one-time-code">');
  });
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('manual_verification_required');
  await page.goto(origin + '/v4/cl/cl-menu.php');
  await page.setContent('<main>Loading</main>');
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('pending');
  await page.setContent('<a id="mainMenuLink">Menu</a><a id="clientLogout">Log out</a>');
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('authenticated');
  await page.goto('https://untrusted.dispatch.invalid/v4/cl/cl-menu.php');
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('manual_verification_required');
});
