'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChromeBrowserRuntime, processGroupAlive } = require('../../integrations/paycom/provider/auth/browser-runtime');
const { CdpConnection, createTarget } = require('../../integrations/paycom/provider/auth/cdp');
const adapter = require('../../integrations/paycom/provider/auth/adapter');
const { navigateFixture, reportNativeFixture } = require('./helpers/native-fixture');

test('normal Chrome types exact PINs into locally intercepted forms and preserves the profile', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-native-window-'));
  fs.chmodSync(root, 0o700);
  const runtime = new ChromeBrowserRuntime({ stateRoot: path.join(root, 'profiles'),
    executable: process.env.DISPATCH_CHROME_EXECUTABLE || '/usr/bin/google-chrome',
    transport: 'pipe', socketRoot: path.join(root, 'run'), directoryNetwork: false });
  let browser, connection, resolvePost, rejectPost, pending;
  let pair = [2, 5];
  const credentials = { pin1: 'one', pin2: '00A!2', pin3: 'three', pin4: '4$B"\\', pin5: '5Z?#' };
  const url = `https://www.paycomonline.net${adapter.SECURITY_QUESTION_PATH}`;
  const intercept = async ({ requestId, request }) => {
    let html = '<!doctype html><title>Local input fixture</title>';
    if (request.url === url && request.method === 'GET') html += `<form method="POST" action="${url}">
      <label for="first_sq_eye_input">Unique pin #${pair[0]}</label><input id="first_sq_eye_input" type="password" name="firstSecurityQuestion">
      <label for="second_sq_eye_input">Unique pin #${pair[1]}</label><input id="second_sq_eye_input" type="password" name="secondSecurityQuestion">
      <input type="hidden" name="firstIndex" value="${pair[0]}"><input type="hidden" name="secondIndex" value="${pair[1]}">
      <button name="continue" type="submit" onclick="document.body.dataset.clicked='yes'">Continue</button></form>`;
    if (request.url === url && request.method === 'POST') resolvePost(new URLSearchParams(request.postData));
    // Every request, including navigations and subresources, is answered here.
    // No real provider receives a request or synthetic credentials.
    await connection.command('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(html).toString('base64') });
  };
  try {
    browser = await runtime.launch({ provider: 'paycom', profile: 'fixture', nativeInput: true });
    assert.ok(browser.nativeInput);
    assert.match(browser.endpoint, /^http:\/\/127\.0\.0\.1:/);
    const pid = browser.pid, profile = browser.profileDirectory;
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    assert.equal(args.some(arg => arg.startsWith('--headless')), false);
    assert.equal(args.includes('--remote-debugging-port=0'), false);
    assert.equal(args.some(arg => /AutomationControlled|user-agent|disable-web-security/.test(arg)), false);
    const target = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    connection.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Fetch.requestPaused') intercept(message.params).catch(error => rejectPost?.(error));
    });
    await connection.command('Page.enable');
    await connection.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await connection.command('Network.setCookie', { name: 'fixture_cookie', value: 'retained', url, httpOnly: true });
    for (const indices of [[2, 5], [5, 4]]) {
      pair = indices;
      pending = new Promise((resolve, reject) => { resolvePost = resolve; rejectPost = reject; });
      pending.catch(() => {});
      await navigateFixture(connection, url,
        `document.querySelector('input[name="firstIndex"]')?.value === ${JSON.stringify(String(pair[0]))}
          && document.querySelector('input[name="secondIndex"]')?.value === ${JSON.stringify(String(pair[1]))}`);
      const current = await adapter.waitForState(connection, 5000, new Set(['security_questions_required']));
      await adapter.submitNativeChallenge(connection, credentials, current.snapshot.challenge, browser, AbortSignal.timeout(10000));
      const form = await pending;
      assert.equal(form.get('firstIndex'), String(pair[0]));
      assert.equal(form.get('secondIndex'), String(pair[1]));
      assert.equal(form.get('firstSecurityQuestion'), credentials[`pin${pair[0]}`]);
      assert.equal(form.get('secondSecurityQuestion'), credentials[`pin${pair[1]}`]);
      assert.equal(form.has('continue'), true);
    }
    const input = browser.nativeInput;
    await assert.rejects(input.type('unsupported\nvalue'), { code: 'manual_verification_required' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(input.type('fixture', controller.signal), { code: 'acquisition_cancelled' });
    connection.close(); connection = null;
    await browser.close(); browser = null;
    assert.equal(processGroupAlive(pid), false);
    assert.equal(fs.readdirSync(path.dirname(profile)).some(name => name.startsWith('native-window-')), false);
    await assert.rejects(input.type('fixture'), { code: 'manual_verification_required' });
    await runtime.reconcile();
    browser = await runtime.launch({ provider: 'paycom', profile: 'fixture' });
    assert.equal(browser.nativeInput, undefined);
    assert.equal(browser.profileDirectory, profile);
    const target2 = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target2.webSocketDebuggerUrl);
    const cookies = (await connection.command('Network.getCookies', { urls: [url] })).cookies;
    assert.equal(cookies.some(cookie => cookie.name === 'fixture_cookie' && cookie.value === 'retained'), true);
  } catch (error) {
    await reportNativeFixture(connection);
    throw error;
  } finally {
    connection?.close(); await browser?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});


test('failed and cancelled window startup clean the display and leave the profile reusable', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-window-failure-'));
  fs.chmodSync(root, 0o700);
  const runtime = new ChromeBrowserRuntime({ stateRoot: path.join(root, 'profiles'), executable: '/usr/bin/false', startTimeoutMs: 1000 });
  try {
    await assert.rejects(runtime.launch({ provider: 'paycom', profile: 'fixture', nativeInput: true }), { code: 'browser_start_failed' });
    const profiles = fs.readdirSync(path.join(root, 'profiles'));
    assert.equal(profiles.length, 1);
    const directory = path.join(root, 'profiles', profiles[0]);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('native-window-')), false);
    assert.equal(fs.existsSync(path.join(directory, 'dispatch-browser.json')), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.launch({ provider: 'paycom', profile: 'fixture', nativeInput: true, signal: controller.signal }), { code: 'acquisition_cancelled' });
    await runtime.reconcile();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
