'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChromeBrowserRuntime } = require('../src/browser-runtime');
const cdp = require('../src/cdp');
const { CLIENT_LANDING_PATH, LOGIN_URL, LOGIN_ACTION_URL, SECURITY_QUESTION_PATH,
  TIMECARD_SEARCH_URL, SNAPSHOT } = require('../../../plugins/paycom/backend/auth/adapter');

const chrome = process.env.DISPATCH_CHROME_EXECUTABLE
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));
const landing = `https://www.paycomonline.net${CLIENT_LANDING_PATH}`;
const authenticated = '<!doctype html><a id="mainMenuLink">Menu</a><a id="clientLogout">Log out</a>';
const credentials = { clientCode: 'fixture-client', username: 'fixture-user', password: 'fixture-password',
  pin3: 'fixture-three', pin4: 'fixture-four' };
const login = `<!doctype html><form method="post" action="${LOGIN_ACTION_URL}">
  <input name="clientcode"><input name="username"><input name="password" type="password"><button>Log in</button></form>
  <script>
    window.actions=[];
    document.querySelector('form').onsubmit=event=>{
      event.preventDefault();
      const values=new FormData(event.target);
      if(values.get('clientcode')!=='fixture-client'||values.get('username')!=='fixture-user'||values.get('password')!=='fixture-password')throw Error('Wrong fixture credentials');
      actions.push('credentials');
      history.pushState({},'',${JSON.stringify(SECURITY_QUESTION_PATH)});
      document.body.innerHTML='<form method="post" action="${SECURITY_QUESTION_PATH}">'
        +'<label for="first">PIN 3</label><input id="first" name="firstSecurityQuestion" type="password">'
        +'<label for="second">PIN 4</label><input id="second" name="secondSecurityQuestion" type="password">'
        +'<input name="firstIndex" type="hidden" value="3"><input name="secondIndex" type="hidden" value="4">'
        +'<button name="continue" type="submit">Continue</button></form>';
      document.querySelector('form').onsubmit=event=>{
        event.preventDefault();
        const values=new FormData(event.target);
        if(values.get('firstSecurityQuestion')!=='fixture-three'||values.get('secondSecurityQuestion')!=='fixture-four')throw Error('Wrong fixture PIN mapping');
        actions.push('pins');history.pushState({},'',${JSON.stringify(CLIENT_LANDING_PATH)});
        document.body.innerHTML=${JSON.stringify(authenticated)};
      };
    };
  </script>`;

// Intercept before navigation so every request stays local. The adapter still
// drives its real CDP connection, URL checks, DOM classification and native PIN input.
async function fixture(t, scenario, run, { application = false, nativeInput = scenario === 'expired' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-start-'));
  const originalCreateTarget = cdp.createTarget;
  const modulePath = require.resolve('../../../plugins/paycom/backend/auth/adapter');
  const originalModule = require.cache[modulePath];
  const connections = [], requests = [], failures = [], starts = [];
  let browser;
  try {
    browser = await new ChromeBrowserRuntime({ stateRoot: path.join(root, 'profiles'), socketRoot: path.join(root, 'run'),
      executable: chrome, transport: 'pipe' }).launch({ provider: 'paycom', profile: 'fixture', nativeInput });
    t.mock.method(cdp, 'createTarget', async (endpoint, url) => {
      starts.push(url);
      const target = await originalCreateTarget(endpoint, 'about:blank');
      const connection = await cdp.CdpConnection.connect(target.webSocketDebuggerUrl);
      connections.push(connection);
      connection.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = message.params;
        requests.push({ url: request.url, method: request.method });
        const redirect = scenario === 'expired' && request.url === landing;
        let html = '<!doctype html>';
        if (request.url === landing) html = scenario === 'captcha'
          ? '<!doctype html><iframe src="https://captcha-assethost.paycomonline.net/static/hcaptcha.html"></iframe>'
          : authenticated;
        if (request.url === LOGIN_URL) html = login;
        if (request.url === TIMECARD_SEARCH_URL) html = `${authenticated}
          <title>Timecard Search</title><p>Employee Status Is Active</p><button>Export</button>`;
        connection.command('Fetch.fulfillRequest', { requestId, responseCode: redirect ? 302 : 200,
          responseHeaders: redirect ? [{ name: 'Location', value: LOGIN_URL }] : [{ name: 'Content-Type', value: 'text/html' }],
          body: Buffer.from(redirect ? '' : html).toString('base64'),
        }).catch(error => failures.push(error));
      });
      await connection.command('Page.enable');
      await connection.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await connection.command('Page.navigate', { url });
      return target;
    });
    delete require.cache[modulePath];
    const { paycomAdapter } = require(modulePath);
    await run(paycomAdapter, browser, connections);
    assert.deepEqual(starts, application ? [landing, TIMECARD_SEARCH_URL] : [landing]);
    assert.equal(requests[0].url, landing);
    if (scenario === 'expired') assert.ok(requests.some(request => request.url === LOGIN_URL));
    else assert.equal(requests.some(request => request.url === LOGIN_URL), false);
    assert.deepEqual(failures, []);
  } finally {
    cdp.createTarget.mock?.restore();
    require.cache[modulePath] = originalModule;
    for (const connection of connections) connection.close();
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const operation of ['inspect', 'recover', 'authenticate']) {
  test(`Paycom ${operation} reuses a valid landing session without reading or submitting credentials`, {
    skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
  }, async t => fixture(t, 'valid', async (adapter, browser) => {
    const options = { loginOnly: true, onSubmit: () => assert.fail('must not submit credentials') };
    const unreadable = new Proxy({}, { get: () => assert.fail('must not read credentials') });
    const result = operation === 'authenticate'
      ? await adapter.authenticate(browser, unreadable, options) : await adapter[operation](browser, options);
    assert.equal(result.status || result.state, 'authenticated');
  }));
}

test('expired Paycom session redirects to login and completes stored credentials plus numbered PINs', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
}, async t => fixture(t, 'expired', async (adapter, browser, connections) => {
  const submissions = [];
  const result = await adapter.authenticate(browser, credentials, { loginOnly: true, onSubmit: phase => submissions.push(phase) });
  assert.equal(result.status, 'authenticated');
  assert.deepEqual(submissions, ['credentials']); // The durable attempt latch is raised once.
  assert.deepEqual(await connections[0].evaluate('window.actions'), ['credentials', 'pins']);
}));

test('credential-free recovery refuses an expired Paycom session', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
}, async t => fixture(t, 'expired', async (adapter, browser, connections) => {
  await assert.rejects(adapter.recover(browser, { loginOnly: true }), { code: 'manual_verification_required' });
  assert.deepEqual(await connections[0].evaluate('window.actions'), []);
}));

for (const scenario of ['valid', 'expired']) {
  test(`${scenario} Paycom session completes automated collector handoff and closes prior tabs`, {
    skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
  }, async t => fixture(t, scenario, async (adapter, browser, connections) => {
    const submissions = [];
    const result = await adapter.authenticate(browser, credentials, { onSubmit: phase => submissions.push(phase) });
    assert.equal(result.status, 'authenticated');
    assert.equal(result.replacedCredentialPage, true);
    assert.deepEqual(submissions, scenario === 'expired' ? ['credentials'] : []);
    const control = await cdp.CdpConnection.connect(browser.browserWebSocketUrl);
    try {
      const { targetInfos } = await control.command('Target.getTargets');
      assert.deepEqual(targetInfos.filter(target => target.type === 'page')
        .map(target => ({ id: target.targetId, url: target.url })), [{ id: result.targetId, url: TIMECARD_SEARCH_URL }]);
      const snapshot = await connections.at(-1).evaluate(SNAPSHOT);
      assert.equal(snapshot.timecardSearchReady, true);
      assert.deepEqual(snapshot.loginPresent, [false, false, false]);
      assert.deepEqual(snapshot.challenge, []);
    } finally { control.close(); }
  }, { application: true }));
}

test('session-first Paycom CAPTCHA requests a native window before any credential submission', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
}, async t => fixture(t, 'captcha', async (adapter, browser) => {
  await assert.rejects(adapter.authenticate(browser, credentials, {
    loginOnly: true, onSubmit: () => assert.fail('must not submit through CAPTCHA'),
  }), { code: 'browser_interaction_required' });
}));


test('expired session requests a window before reading or submitting credentials', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 30000,
}, async t => fixture(t, 'expired', async (adapter, browser, connections) => {
  const unreadable = new Proxy({}, { get: () => assert.fail('must request a window before reading credentials') });
  await assert.rejects(adapter.authenticate(browser, unreadable,
    { loginOnly: true, onSubmit: () => assert.fail('must not submit in headless mode') }),
  { code: 'browser_interaction_required' });
  assert.deepEqual(await connections[0].evaluate('window.actions'), []);
}, { nativeInput: false }));
