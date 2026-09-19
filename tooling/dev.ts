import { spawn } from 'node:child_process';
import { demo, fixture } from './fixture-server.js';
// The live Dev service already holds the backend's default port on this host, so the
// fixture server takes a free one and Vite proxies to it.
const app = await fixture({
  env: { DISPATCH_ORIGIN: 'http://127.0.0.1:5173' },
  output: 'inherit',
});
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit',
  env: { ...app.env, DISPATCH_DEV_API_PORT: app.env.PORT },
});
process.stdout.write(
  `Development fixtures: http://127.0.0.1:5173\nSign in: ${demo.email} / ${demo.password}\nTemporary state: ${app.root}\n`,
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
