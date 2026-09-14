'use strict';
// Loaded only by the test worker shim, before the production worker imports the
// adapter. Every provider request is fulfilled locally, inside its network namespace.
const fs = require('node:fs');
const cdp = require('/app/provider/auth/cdp.js');
const original = cdp.createTarget;
const origin = 'https://www.paycomonline.net';
const loginPath = '/v4/cl/cl-login.php';
const actionPath = '/v4/cl/cl-loginproc.php';
const pinPath = '/v4/cl/web.php/security/security-question/login';
const landing = '/v4/cl/web.php/client-landing/arc';
const login = `<form method="post" action="${actionPath}"><input name="clientcode"><input name="username"><input type="password" name="password"><button>Log in</button></form>`;
const pins = `<form method="post" action="${pinPath}"><label for="first">PIN 3</label><input id="first" name="firstSecurityQuestion" type="password"><label for="second">PIN 5</label><input id="second" name="secondSecurityQuestion" type="password"><input name="firstIndex" type="hidden" value="3"><input name="secondIndex" type="hidden" value="5"><button name="continue" type="submit">Continue</button></form>`;
const challenge = `<iframe style="position:absolute;left:900px;top:300px;width:200px;height:140px" src="https://captcha-assethost.paycomonline.net/static/hcaptcha.html"></iframe><button type="button" id="solveCaptcha" style="position:absolute;left:900px;top:450px;width:140px;height:40px" onclick="document.querySelector('iframe').remove();window.fixtureSolved=true;document.cookie='fixture_captcha=solved; Path=/; Secure';this.remove()">Solve fixture</button>`;
const captchaMode = () => fs.existsSync('/app/captcha-mode') ? fs.readFileSync('/app/captcha-mode', 'utf8') : '';
const authenticated = '<a id="mainMenuLink">Menu</a><a id="clientLogout">Log out</a>';
const connections = new Set();
const record = event => fs.appendFileSync('/profile/fixture-events', event + '\n', { mode: 0o600 });
cdp.createTarget = async (endpoint, url) => {
  const target = await original(endpoint, 'about:blank');
  const connection = await cdp.CdpConnection.connect(target.webSocketDebuggerUrl);
  connections.add(connection);
  connection.socket.addEventListener('close', () => connections.delete(connection));
  connection.socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const selected = new URL(request.url);
    let body = '<!doctype html>', status = 200, headers = [{ name: 'Content-Type', value: 'text/html' }];
    const redirect = destination => { status = 302; headers.push({ name: 'Location', value: origin + destination }); };
    const expired = fs.existsSync('/profile/force-rejection');
    if (selected.pathname === landing) {
      record('landing');
      if (!expired && /fixture_session=one/.test(request.headers.Cookie || request.headers.cookie || '')) body += authenticated;
      else redirect(loginPath);
    } else if (selected.pathname === loginPath) {
      body += login;
      if (captchaMode() === 'before-login' && !/fixture_captcha=solved/.test(request.headers.Cookie || request.headers.cookie || '')) body += challenge;
    }
    else if (selected.pathname === actionPath && request.method === 'POST') {
      record('primary');
      const values = new URLSearchParams(request.postData);
      if (expired || values.get('clientcode') !== 'fixture-client' || values.get('username') !== 'fixture-user' || values.get('password') !== 'fixture-password') {
        // Paycom reports an explicit credential rejection on its login route.
        body += login + '<p>Invalid username or password</p><script>history.replaceState({},"",'+JSON.stringify(loginPath)+')</script>';
      } else redirect(pinPath);
    } else if (selected.pathname === pinPath && request.method === 'POST') {
      record('pins');
      const values = new URLSearchParams(request.postData);
      if (values.get('firstSecurityQuestion') !== '00 Three !' || values.get('secondSecurityQuestion') !== ' Five? ') body += pins + '<p>Security answers are not correct</p>';
      else { headers.push({ name: 'Set-Cookie', value: 'fixture_session=one; Path=/; Max-Age=3600; Secure; HttpOnly' }); redirect(landing); }
    } else if (selected.pathname === pinPath) {
      body += pins;
      if (captchaMode() === 'after-pins') body += '<script>document.querySelector("form").onsubmit=event=>{if(!window.fixtureSolved){event.preventDefault();if(!document.getElementById("solveCaptcha"))document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(challenge)+');}}</script>';
    }
    connection.command('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(body).toString('base64') }).catch(() => {});
  });
  await connection.command('Page.enable');
  await connection.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await connection.command('Page.navigate', { url });
  return target;
};
