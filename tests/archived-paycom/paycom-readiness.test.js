'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChromeBrowserRuntime } = require('../../integrations/paycom/provider/auth/browser-runtime');
const { CdpConnection, createTarget } = require('../../integrations/paycom/provider/auth/cdp');
const {
  SNAPSHOT, classify, waitForState, submitNativeChallenge, challengeExpression,
  SECURITY_QUESTION_PATH,
} = require('../../integrations/paycom/provider/auth/adapter');

const chrome = process.env.DISPATCH_CHROME_EXECUTABLE
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));

test('PIN submission waits for the provider submit handler to add its request token', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-readiness-'));
  const url = `https://www.paycomonline.net${SECURITY_QUESTION_PATH}`;
  const credentials = { pin2: 'fixture-two', pin5: 'fixture-five' };
  const challenge = [{ index: 2 }, { index: 5 }];
  let browser, connection, releaseScript, scriptRequested, posted;
  const scriptGate = new Promise(resolve => { releaseScript = resolve; });
  const scriptSeen = new Promise(resolve => { scriptRequested = resolve; });
  const submission = new Promise(resolve => { posted = resolve; });
  const failures = [];
  const html = `<!doctype html><html><body>
    <form method="post" action="${url}">
      <label for="first">Unique pin #2</label>
      <input id="first" name="firstSecurityQuestion" type="password">
      <label for="second">Unique pin #5</label>
      <input id="second" name="secondSecurityQuestion" type="password">
      <input name="firstIndex" type="hidden" value="2">
      <input name="secondIndex" type="hidden" value="5">
      <button name="continue" type="submit">Continue</button>
    </form>
    <script src="/fixture-ready.js"></script>
    </body></html>`;
  // Model the observed provider behavior with fake data: the form is visible
  // before DOMContentLoaded installs the token-adding submit listener.
  const script = `window.addEventListener('DOMContentLoaded', () => {
    document.body.addEventListener('submit', event => {
      const token = document.createElement('input');
      token.type = 'hidden'; token.name = 'request-token'; token.value = 'fixture-token';
      event.target.appendChild(token);
    });
  });`;
  async function intercept({ requestId, request }) {
    let body = '', mime = 'text/html';
    if (request.url === url && request.method === 'GET') body = html;
    else if (request.url === 'https://www.paycomonline.net/fixture-ready.js') {
      scriptRequested();
      await scriptGate;
      body = script; mime = 'application/javascript';
    } else if (request.url === url && request.method === 'POST') {
      posted(new URLSearchParams(request.postData));
      body = '<!doctype html><title>Fixture accepted</title>';
    }
    // Fulfill every request locally; this test never contacts Paycom.
    await connection.command('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: mime }], body: Buffer.from(body).toString('base64') });
  }
  try {
    browser = await new ChromeBrowserRuntime({ stateRoot: path.join(root, 'sessions'),
      executable: chrome, transport: 'tcp' }).launch({ nativeInput: true });
    const target = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    connection.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Fetch.requestPaused') intercept(message.params).catch(error => failures.push(error));
    });
    await connection.command('Page.enable');
    await connection.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await connection.command('Page.navigate', { url });
    await scriptSeen;
    // Chrome's preload scanner may request the script before the parser has
    // created both inputs. Wait for the fixture layout while keeping the script
    // blocked; waiting for DOMContentLoaded would erase the regression scenario.
    let loading;
    const deadline = Date.now() + 5000;
    do {
      loading = await connection.evaluate(SNAPSHOT);
      if (JSON.stringify(loading.challenge.map(item => item.index)) === '[2,5]') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(loading.readyState, 'loading');
    assert.deepEqual(loading.challenge.map(item => item.index), [2, 5]);
    assert.equal(classify(loading), 'pending');
    await assert.rejects(submitNativeChallenge(connection, credentials, challenge, browser),
      error => error.code === 'manual_verification_required');
    assert.equal((await connection.evaluate(challengeExpression(credentials, challenge))).status, 'challenge_layout_changed');
    assert.deepEqual(await connection.evaluate(`Array.from(document.querySelectorAll('input[type="password"]')).map(f => f.value)`), ['', '']);

    const ready = waitForState(connection, 5_000, new Set(['security_questions_required']));
    releaseScript();
    const observed = await ready;
    assert.equal(observed.snapshot.readyState, 'complete');
    await submitNativeChallenge(connection, credentials, observed.snapshot.challenge, browser);
    const form = await submission;
    assert.equal(form.get('firstSecurityQuestion'), credentials.pin2);
    assert.equal(form.get('secondSecurityQuestion'), credentials.pin5);
    assert.equal(form.get('firstIndex'), '2');
    assert.equal(form.get('secondIndex'), '5');
    assert.equal(form.get('request-token'), 'fixture-token');
    assert.deepEqual(failures, []);
  } finally {
    releaseScript();
    connection?.close();
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
