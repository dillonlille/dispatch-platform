import { chromium } from 'playwright';
import net from 'node:net';
import fs from 'node:fs';
import { collect } from '../../integrations/paycom/native.js';
import { safeError } from '../../shared/errors.js';
import type { BrowserEvent } from './protocol.js';
const send = (event: BrowserEvent) => process.stdout.write(JSON.stringify(event) + '\n');
if (
  fs.existsSync('/profile') ||
  fs.existsSync('/home/thepickle') ||
  process.env.DISPATCH_STATE_ROOT
)
  throw new Error('collector_isolation_failed');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 4096) process.exit(1);
}
const bridge = net.createServer((client) => {
  const upstream = net.connect('/run/dispatch/cdp.sock');
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
  client.once('close', () => upstream.destroy());
});
await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
let diagnostic = false;
try {
  const { endpointPath, timezone, fixtureUrl } = JSON.parse(input) as {
    endpointPath: string;
    timezone: string;
    fixtureUrl?: string;
  };
  diagnostic = Boolean(fixtureUrl);
  if (!/^\/devtools\/browser\/[a-f0-9-]+$/.test(endpointPath)) process.exit(1);
  const endpoint = `ws://127.0.0.1:${(bridge.address() as net.AddressInfo).port}${endpointPath}`;
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('browser_unavailable');
  const workforce = await collect(
    context,
    timezone,
    (progress, message) => send({ type: 'progress', progress, message }),
    fixtureUrl,
  );
  send({ type: 'collected', workforce });
  await browser.close();
} catch (error) {
  if (diagnostic) process.stderr.write(String((error as Error).stack) + '\n');
  send({ type: 'error', code: safeError(error) });
} finally {
  bridge.close();
}
