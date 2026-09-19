import { spawn } from 'node:child_process';
import { demo, fixture } from './fixture-server.js';
// The live Dev service already holds the backend's default port on this host, so the
// fixture server takes a free one and Vite proxies to it.
// DISPATCH_DEV_HOST serves the fixtures on another of this machine's addresses, such as its
// Tailscale one, so a browser elsewhere can open them. The backend checks the page's origin,
// so Vite and the fixture server must agree on it. This host also has a public address, so an
// address that means "every interface" is refused.
const host = process.env.DISPATCH_DEV_HOST || '127.0.0.1';
if (['0.0.0.0', '::', '[::]', '*'].includes(host))
  throw new Error(`DISPATCH_DEV_HOST must name one address, not ${host}`);
const origin = `http://${host}:5173`;
const app = await fixture({
  env: { DISPATCH_ORIGIN: origin },
  output: 'inherit',
});
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', host], {
  stdio: 'inherit',
  env: { ...app.env, DISPATCH_DEV_API_PORT: app.env.PORT },
});
process.stdout.write(
  `Development fixtures: ${origin}\nSign in: ${demo.email} / ${demo.password}\nTemporary state: ${app.root}\n`,
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void app.stop().catch(() => {});
  ui.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const api = app.exited();
void api.then(stop);
ui.once('exit', stop);
await Promise.all([api, new Promise<void>((resolve) => ui.once('exit', () => resolve()))]);
await app.close();
