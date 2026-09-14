import { chromium, type BrowserContext, type Page } from 'playwright';
import net from 'node:net';
import fs from 'node:fs';
import readline from 'node:readline';
import {
  fixtureLogin,
  fixtureVerify,
  fixtureConnectionState,
} from '../../integrations/paycom/native.js';
import {
  PaycomAuthentication,
  authenticationError,
} from '../../integrations/paycom/authentication.js';
import { safeError, AppError } from '../../shared/errors.js';
import type { BrowserCommand, BrowserEvent } from './protocol.js';
let context: BrowserContext | undefined,
  page: Page | undefined,
  timezone = 'UTC',
  fixtureUrl: string | undefined,
  busy = false,
  cdp: net.Server | undefined,
  wsPath = '',
  browserPort = 0;
let native: PaycomAuthentication | undefined;
const send = (event: BrowserEvent) => process.stdout.write(JSON.stringify(event) + '\n');
async function saveSession() {
  if (context) {
    const state = await context.storageState();
    fs.writeFileSync('/profile/session.json', JSON.stringify(state), { mode: 0o600 });
    fs.chmodSync('/profile/session.json', 0o600);
  }
}
let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  return (shutdownPromise ??= (async () => {
    try {
      await saveSession();
      await context?.close();
      await native?.close();
    } finally {
      process.exit(0);
    }
  })());
}
const proxy = net.createServer((client) => {
  const upstream = net.connect('/run/dispatch/egress.sock');
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
  client.once('close', () => upstream.destroy());
});
await new Promise<void>((resolve) => proxy.listen(17891, '127.0.0.1', resolve));
async function report(state = 'challenge') {
  if (fixtureUrl) state = await fixtureConnectionState(page!);
  if (state === 'ready') await saveSession();
  send(
    state === 'ready'
      ? { type: 'ready' }
      : {
          type: 'challenge',
          message: 'Complete the provider verification to continue.',
        },
  );
}
async function exposeBrowser() {
  cdp = net.createServer((client) => {
    const upstream = net.connect(browserPort, '127.0.0.1');
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    client.once('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    cdp!.once('error', reject);
    cdp!.listen('/run/dispatch/cdp.sock', resolve);
  });
  fs.chmodSync('/run/dispatch/cdp.sock', 0o600);
}
async function command(command: BrowserCommand) {
  if (command.action === 'close') {
    await shutdown();
    return;
  }
  if (command.action === 'start') {
    timezone = command.timezone;
    fixtureUrl = command.fixtureUrl;
    const address = proxy.address() as net.AddressInfo;
    if (!fixtureUrl) {
      native = new PaycomAuthentication('/profile', process.argv[2]!);
      const state = await native.start(command.credentials, command.ownerRetry);
      browserPort = Number(new URL(native.browser!.endpoint).port);
      wsPath = new URL(native.browser!.browserWebSocketUrl).pathname;
      await exposeBrowser();
      await report(state);
      return;
    }
    // Fixture URLs can only be supplied by the local test harness. Production
    // always requires Chromium's internal sandbox as well as the outer namespace.
    context = await chromium.launchPersistentContext('/profile', {
      executablePath: process.argv[2],
      headless: true,
      chromiumSandbox: !fixtureUrl,
      viewport: { width: 1200, height: 800 },
      timezoneId: timezone,
      proxy: { server: `http://127.0.0.1:${address.port}` },
      args: [
        '--remote-debugging-port=0',
        '--proxy-bypass-list=<-loopback>',
        '--disable-dev-shm-usage',
        '--renderer-process-limit=4',
      ],
    });
    if (fs.existsSync('/profile/session.json')) {
      const state = JSON.parse(fs.readFileSync('/profile/session.json', 'utf8'));
      if (Array.isArray(state.cookies)) await context.addCookies(state.cookies);
    }
    const active = fs.readFileSync('/profile/DevToolsActivePort', 'utf8').trim().split('\n');
    browserPort = Number(active[0]);
    wsPath = active[1]!;
    await exposeBrowser();
    page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(20_000);
    await fixtureLogin(page, command.credentials, fixtureUrl);
    await report();
    return;
  }
  if (native) {
    if (command.action === 'complete_assistance') await report(await native.continue());
    if (command.action === 'check') {
      const state = await native.check(command.credentials);
      browserPort = Number(new URL(native.browser!.endpoint).port);
      wsPath = new URL(native.browser!.browserWebSocketUrl).pathname;
      await report(state);
    }
    if (command.action === 'verify') await report(await native.verify(command.code));
    if (command.action === 'assist') {
      await native.assist(command.input);
      send({ type: 'assisted' });
    }
    if (command.action === 'screenshot')
      send({ type: 'screenshot', image: await native.screenshot() });
    if (command.action === 'collect') {
      try {
        await native.prepareCollection();
      } catch (error) {
        if ((error as AppError).code === 'verification_required') await report('challenge');
        throw error;
      }
      send({
        type: 'collection_access',
        path: new URL(native.browser!.browserWebSocketUrl).pathname,
      });
    }
    return;
  }
  if (!page || !context) throw new AppError('browser_unavailable');
  if (command.action === 'check' || command.action === 'complete_assistance') await report();
  if (command.action === 'verify') {
    await fixtureVerify(page, command.code);
    await report();
  }
  if (command.action === 'assist') {
    if (command.input.kind === 'click') await page.mouse.click(command.input.x, command.input.y);
    if (command.input.kind === 'pointer') {
      await page.mouse.move(command.input.x, command.input.y);
      if (command.input.phase === 'down') await page.mouse.down();
      if (command.input.phase === 'up') await page.mouse.up();
    }
    if (command.input.kind === 'scroll') {
      await page.mouse.move(command.input.x, command.input.y);
      await page.mouse.wheel(command.input.deltaX, command.input.deltaY);
    }
    if (command.input.kind === 'type') await page.keyboard.insertText(command.input.text);
    if (command.input.kind === 'key')
      await page.keyboard.press((command.input.shift ? 'Shift+' : '') + command.input.key);
    send({ type: 'assisted' });
  }
  if (command.action === 'screenshot')
    send({
      type: 'screenshot',
      image: (await page.screenshot({ type: 'png', timeout: 5000 })).toString('base64'),
    });
  if (command.action === 'collect') {
    if ((await fixtureConnectionState(page)) !== 'ready')
      throw new AppError('verification_required');
    send({ type: 'collection_access', path: wsPath });
  }
}
readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (line.length > 16384) {
      send({ type: 'error', code: 'browser_protocol_failed' });
      return;
    }
    let request: BrowserCommand;
    try {
      request = JSON.parse(line) as BrowserCommand;
    } catch {
      return;
    }
    if (busy && request.action !== 'close') {
      send({ type: 'error', code: 'connection_busy' });
      return;
    }
    busy = true;
    void command(request)
      .catch((error) => {
        if (fixtureUrl) process.stderr.write(String(error?.stack ?? error) + '\n');
        send({
          type: 'error',
          code:
            native && !(error instanceof AppError)
              ? authenticationError(error).code
              : safeError(error),
        });
      })
      .finally(() => {
        busy = false;
      });
  })
  .on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
