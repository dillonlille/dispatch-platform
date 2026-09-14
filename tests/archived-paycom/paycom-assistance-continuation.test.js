'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChromeBrowserRuntime } = require('../../integrations/paycom/provider/auth/browser-runtime');
const { CdpConnection, createTarget } = require('../../integrations/paycom/provider/auth/cdp');
const { paycomAdapter, SECURITY_QUESTION_PATH, CLIENT_LANDING_PATH, SNAPSHOT } = require('../../integrations/paycom/provider/auth/adapter');
const { navigateFixture, settleFixture, reportNativeFixture } = require('./helpers/native-fixture');

test('CAPTCHA continuation stays on the original document and only submits unchanged retained PINs once', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-assistance-')); fs.chmodSync(root, 0o700);
  const runtime = new ChromeBrowserRuntime({ stateRoot: path.join(root, 'profiles'), executable: process.env.DISPATCH_CHROME_EXECUTABLE || '/usr/bin/google-chrome', directoryNetwork: false });
  const origin = 'https://www.paycomonline.net', url = origin + SECURITY_QUESTION_PATH;
  const form = `<html><title>Local pending form</title><form method="POST" action="${url}">
    <label for="pin2">Unique pin #2</label><input id="pin2" name="firstSecurityQuestion" type="password" value="00fixture!">
    <label for="pin5">Unique pin #5</label><input id="pin5" name="secondSecurityQuestion" type="password" value="fixture?5">
    <input name="firstIndex" type="hidden" value="2"><input name="secondIndex" type="hidden" value="5">
    <button name="continue" type="submit" onclick="window.continueClicked=true">Continue</button></form>
    <iframe width="250" height="180" src="https://example.com/captcha/check"></iframe></html>`;
  let browser, connection; const posts = []; let interceptionError;
  try {
    browser = await runtime.launch({ provider: 'paycom', profile: 'fixture', nativeInput: true });
    const target = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    connection.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = message.params;
      let responseCode = 200, headers = [{ name: 'Content-Type', value: 'text/html' }];
      let body = request.url.includes('example.com') ? '<p>Local challenge fixture</p>' : form;
      if (request.method === 'POST') {
        posts.push(new URLSearchParams(request.postData)); responseCode = 302;
        headers.push({ name: 'Location', value: origin + CLIENT_LANDING_PATH }); body = '';
      } else if (request.url === origin + CLIENT_LANDING_PATH) {
        body = '<html><title>Client</title><a id="mainMenuLink">Menu</a><a id="clientLogout">Logout</a></html>';
      }
      connection.command('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: headers, body: Buffer.from(body).toString('base64') })
        .catch(error => { if (!request.url.includes('example.com')) interceptionError = error; });
    });
    await connection.command('Page.enable'); await connection.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const load = () => navigateFixture(connection, url, `(${SNAPSHOT}).captchaPresent`);
    for (const scenario of ['empty_before', 'still_visible', 'reloaded', 'cleared', 'changed', 'completed']) {
      await load();
      if (scenario === 'empty_before') await connection.evaluate('document.querySelector("#pin2").value=""; document.querySelector("#pin5").value=""');
      const context = await paycomAdapter.prepareBrowserAssistance(browser);
      assert.ok(context?.loaderId);
      if (scenario !== 'empty_before') assert.ok(context.pinFingerprint);
      assert.equal(JSON.stringify(context).includes('00fixture!'), false);
      if (scenario === 'reloaded') await load();
      if (scenario !== 'still_visible') await connection.evaluate('document.querySelector("iframe").remove()');
      if (scenario === 'cleared') await connection.evaluate('document.querySelector("#pin2").value=""');
      if (scenario === 'changed') await connection.evaluate('document.querySelector("#pin2").value="different"');
      await settleFixture(connection);
      let resumed = 0;
      const operation = paycomAdapter.completeBrowserAssistance(browser, context, { loginOnly: true,
        resumeAuthentication: async () => { resumed++; return { status: 'authenticated' }; } });
      if (scenario === 'empty_before') {
        assert.equal((await operation).status, 'authenticated'); assert.equal(resumed, 1); assert.equal(posts.length, 0);
      } else if (scenario !== 'completed') {
        await assert.rejects(operation, { code: 'manual_verification_required' }); assert.equal(posts.length, 0);
      } else {
        assert.equal((await operation).status, 'authenticated'); assert.equal(posts.length, 1);
        assert.equal(posts[0].get('firstSecurityQuestion'), '00fixture!');
        assert.equal(posts[0].get('secondSecurityQuestion'), 'fixture?5');
      }
      if (scenario !== 'empty_before') assert.equal(resumed, 0);
      if (interceptionError) throw interceptionError;
    }
  } catch (error) {
    await reportNativeFixture(connection);
    throw error;
  } finally { connection?.close(); await browser?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
