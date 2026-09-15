import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ChromeBrowserRuntime } = require('./provider/auth/browser-runtime.js');
const { CdpConnection, createTarget } = require('./provider/auth/cdp.js');
const runtime = new ChromeBrowserRuntime({
  stateRoot: '/profile/profiles',
  executable: process.argv[2],
  transport: 'tcp',
  directoryNetwork: true,
});
let browser, connection;
try {
  browser = await runtime.launch({ provider: 'paycom', profile: 'preflight', nativeInput: true });
  const target = await createTarget(browser.endpoint, 'chrome://sandbox');
  connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(await connection.evaluate('document.body.innerText'));
  await connection.command('Page.navigate', { url: 'about:blank' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await connection.evaluate('document.body.innerHTML="<input id=check>"');
  const rect = await connection.evaluate(
    '(()=>{const r=document.querySelector("input").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
  );
  await browser.nativeInput.click(connection, rect.x, rect.y);
  await browser.nativeInput.type('00Native !?');
  if ((await connection.evaluate('document.querySelector("input").value')) !== '00Native !?')
    throw Error('native_input_failed');
  console.log('Native OS input verified');
} finally {
  connection?.close();
  await browser?.close();
}
