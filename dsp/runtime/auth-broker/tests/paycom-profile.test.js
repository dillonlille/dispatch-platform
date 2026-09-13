'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChromeBrowserRuntime } = require('../src/browser-runtime');
const { CdpConnection, createTarget } = require('../src/cdp');
const { SNAPSHOT, classify, waitForState, verifyTimecardApplication, securityProfileDismissExpression,
  SECURITY_QUESTION_PATH, SECURITY_PROFILE_PATH, SECURITY_PROFILE_WARNING } = require('../../../plugins/paycom/backend/auth/adapter');

const chrome = process.env.DISPATCH_CHROME_EXECUTABLE
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));

test('PIN login skips the optional profile campaign through real DOM transitions and stops for verification controls', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 30_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-profile-'));
  const url = `https://www.paycomonline.net${SECURITY_QUESTION_PATH}`;
  let browser, connection;
  const failures = [];
  const html = `<!doctype html><html><body>
    <form method="post" action="${url}">
      <label for="first">PIN 3</label><input id="first" name="firstSecurityQuestion" type="password">
      <label for="second">PIN 4</label><input id="second" name="secondSecurityQuestion" type="password">
      <input name="firstIndex" type="hidden" value="3"><input name="secondIndex" type="hidden" value="4">
      <button name="continue" type="submit">Continue</button>
    </form>
    <script>
      window.actions=[];
      const profilePath=${JSON.stringify(SECURITY_PROFILE_PATH)};
      function partial(next) {
        document.body.innerHTML='<p>Setup Your Security Profile — Verify your identity</p>';
        setTimeout(next,450);
      }
      function prompt() {
        document.body.innerHTML='<h1>Setup Your Security Profile</h1><p>Verify your contact information</p>'
          +'<p>Learn about multi-factor authentication. Verify your identity.</p>'
          +'<input name="cell-number"><input name="email"><input name="work-number">'
          +'<button>Verify</button><button>Verify</button><button>Verify</button>'
          +'<button id="later">Not Now</button><button id="proceed">Continue</button>';
        document.querySelector('#later').onclick=()=>{
          actions.push('Not Now');
          const modal=document.createElement('div');
          modal.innerHTML='<p>Warning</p><p>'+${JSON.stringify(SECURITY_PROFILE_WARNING)}
            +'</p><button></button><button>Cancel</button><button id="confirm">Continue</button>';
          document.body.appendChild(modal);
          document.querySelector('#confirm').onclick=()=>{actions.push('Confirm');partial(prompt)};
        };
        document.querySelector('#proceed').onclick=()=>{
          actions.push('Continue');partial(()=>{
            history.pushState({},'', '/v4/cl/web.php/home');
            document.body.innerHTML='<a id="mainMenuLink">Menu</a><a id="clientLogout">Log out</a>';
          });
        };
      }
      document.querySelector('form').onsubmit=event=>{
        event.preventDefault();
        const values=new FormData(event.target);
        if(values.get('firstSecurityQuestion')!=='fixture-three'||values.get('secondSecurityQuestion')!=='fixture-four')throw Error('Wrong fixture PIN mapping');
        actions.push('PIN submit');history.pushState({},'',profilePath);partial(prompt);
      };
    </script></body></html>`;
  try {
    browser = await new ChromeBrowserRuntime({ stateRoot: path.join(root, 'sessions'), executable: chrome, transport: 'tcp' }).launch({ nativeInput: true });
    const target = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    connection.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = message.params;
      // Fulfill every request locally, including iframe requests; never contact Paycom.
      connection.command('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from(request.url === url ? html : '<!doctype html>').toString('base64'),
      }).catch(error => failures.push(error));
    });
    await connection.command('Page.enable');
    await connection.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await connection.command('Page.navigate', { url });
    const initial = await waitForState(connection, 5_000, new Set(['security_questions_required']));
    const submissions = [];
    const result = await verifyTimecardApplication(connection, initial,
      { pin3: 'fixture-three', pin4: 'fixture-four' }, phase => submissions.push(phase), undefined, value => value, true, browser);
    assert.equal(result.state, 'authenticated');
    assert.deepEqual(submissions, ['security_questions']);
    assert.deepEqual(await connection.evaluate('window.actions'), ['PIN submit', 'Not Now', 'Confirm', 'Continue']);

    await connection.evaluate(`history.pushState({},'',${JSON.stringify(SECURITY_PROFILE_PATH)});prompt();`);
    assert.equal(classify(await connection.evaluate(SNAPSHOT)), 'security_profile_prompt');
    await connection.evaluate(`document.body.insertAdjacentHTML('beforeend','<input autocomplete="one-time-code" value="private-fixture-secret">')`);
    let snapshot = await connection.evaluate(SNAPSHOT);
    assert.equal(snapshot.otpPresent, true);
    assert.equal(classify(snapshot), 'manual_verification_required');
    assert.equal(JSON.stringify(snapshot).includes('private-fixture-secret'), false);
    await connection.evaluate(`document.querySelector('[autocomplete="one-time-code"]').remove();
      document.body.insertAdjacentHTML('beforeend','<iframe srcdoc="Local fixture" src="https://captcha-assethost.paycomonline.net/static/hcaptcha.html" style="display:none"></iframe>')`);
    snapshot = await connection.evaluate(SNAPSHOT);
    assert.equal(snapshot.captchaPresent, false);
    assert.equal(classify(snapshot), 'security_profile_prompt');
    await connection.evaluate(`document.querySelector('iframe').style.display='block'`);
    snapshot = await connection.evaluate(SNAPSHOT);
    assert.equal(snapshot.captchaPresent, true);
    assert.equal(classify(snapshot), 'manual_verification_required');
    assert.equal((await connection.evaluate(securityProfileDismissExpression())).status, 'manual_verification_required');
    assert.deepEqual(failures, []);
  } finally {
    connection?.close();
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
