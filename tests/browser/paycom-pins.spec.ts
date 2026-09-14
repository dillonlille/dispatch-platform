import { test, expect, type Page } from '@playwright/test';
import { login } from '../../integrations/paycom/native.js';
import { answerSecurityPins } from '../../integrations/paycom/security-pins.js';

const origin = 'https://www.paycomonline.net';
const challengePath = '/v4/cl/web.php/security/security-question/login';
const credentials = {
  clientCode: 'fixture',
  username: 'fixture',
  password: 'fixture-password',
  securityAnswers: ['first', '00A!2', 'third', '4$B"\\', ' 5Z?# '],
};
function form(pair = [2, 5]) {
  return `<form method="post" action="${challengePath}">
    <label for="first_sq_eye_input">Unique pin #${pair[0]}</label><input id="first_sq_eye_input" type="password" name="firstSecurityQuestion">
    <label for="second_sq_eye_input">Unique pin #${pair[1]}</label><input id="second_sq_eye_input" type="password" name="secondSecurityQuestion">
    <input type="hidden" name="firstIndex" value="${pair[0]}"><input type="hidden" name="secondIndex" value="${pair[1]}">
    <button name="continue" type="submit">Continue</button></form>`;
}
async function provider(page: Page, challenge: string, rejected = false, delay = 0) {
  const submissions: URLSearchParams[] = [];
  await page.context().setOffline(true);
  // Intercept every request. These tests never contact Paycom or another host.
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) throw new Error('Unexpected provider destination');
    if (url.pathname === challengePath && request.method() === 'POST') {
      submissions.push(new URLSearchParams(request.postData()!));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (rejected)
        return route.fulfill({
          contentType: 'text/html',
          body: `Security answers are incorrect${challenge}`,
        });
      return route.fulfill({
        contentType: 'text/html',
        body: '<script>location.replace("/v4/cl/cl-menu.php")</script>',
      });
    }
    if (url.pathname === challengePath)
      return route.fulfill({ contentType: 'text/html', body: challenge });
    if (url.pathname === '/v4/cl/cl-menu.php')
      return route.fulfill({ contentType: 'text/html', body: 'Connected' });
    if (request.method() === 'POST')
      return route.fulfill({
        contentType: 'text/html',
        body: `<script>location.replace(${JSON.stringify(challengePath)})</script>`,
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<form method="post"><input name="clientcode"><input name="username"><input name="password" type="password"><button>Sign in</button></form>',
    });
  });
  return submissions;
}

test('native login maps requested PIN numbers to exact saved values', async ({ page }) => {
  for (const pair of [
    [2, 5],
    [5, 4],
  ]) {
    const submissions = await provider(page, form(pair));
    expect(await login(page, credentials)).toBe('ready');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.get('firstSecurityQuestion')).toBe(
      credentials.securityAnswers[pair[0]! - 1],
    );
    expect(submissions[0]!.get('secondSecurityQuestion')).toBe(
      credentials.securityAnswers[pair[1]! - 1],
    );
    await page.unrouteAll();
  }
});

test('PIN login also supports the archived input submit control', async ({ page }) => {
  const submissions = await provider(
    page,
    form().replace(
      '<button name="continue" type="submit">Continue</button>',
      '<input name="continue" type="submit" value="Continue">',
    ),
  );
  expect(await login(page, credentials)).toBe('ready');
  expect(submissions).toHaveLength(1);
});

test('incomplete credentials and unrecognized challenges stay available for manual assistance', async ({
  page,
}) => {
  const submissions = await provider(page, form());
  const { securityAnswers: _, ...legacy } = credentials;
  expect(await login(page, legacy)).toBe('challenge');
  expect(submissions).toHaveLength(0);
  for (const challenge of [
    form([2, 2]),
    form().replace('name="firstIndex" value="2"', 'name="firstIndex" value="4"'),
    form().replace('Unique pin #2', 'Unknown question'),
    form().replace(`action="${challengePath}"`, 'action="https://example.invalid/collect"'),
    form().replace(
      'name="continue"',
      'name="continue" formaction="https://example.invalid/collect"',
    ),
    form().replace('method="post"', 'method="get"'),
    form() + '<input autocomplete="one-time-code">',
  ]) {
    await page.unrouteAll();
    const posted = await provider(page, challenge);
    await page.goto(origin + challengePath);
    expect(await answerSecurityPins(page, credentials)).toBe(false);
    expect(posted).toHaveLength(0);
    expect(await page.locator('[name=firstSecurityQuestion]').inputValue()).toBe('');
    expect(await page.locator('[name=secondSecurityQuestion]').inputValue()).toBe('');
  }
  await page.unrouteAll();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: form() }));
  for (const url of [
    'https://example.invalid' + challengePath,
    origin + challengePath + '?unexpected=1',
  ]) {
    await page.goto(url);
    expect(await answerSecurityPins(page, credentials)).toBe(false);
    expect(await page.locator('[name=firstSecurityQuestion]').inputValue()).toBe('');
    expect(await page.locator('[name=secondSecurityQuestion]').inputValue()).toBe('');
  }
});

test('rejected PINs are submitted once and not retried automatically', async ({ page }) => {
  const submissions = await provider(page, form(), true);
  await expect(login(page, credentials)).rejects.toMatchObject({
    code: 'security_answers_rejected',
  });
  expect(submissions).toHaveLength(1);
});

test('login waits for a slow PIN response without resubmitting', async ({ page }) => {
  const submissions = await provider(page, form(), false, 900);
  expect(await login(page, credentials)).toBe('ready');
  expect(submissions).toHaveLength(1);
});
