import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-development-'));
const binary = path.resolve('target/debug/dispatch-backend');
// The live Dev service already holds the backend's default port on this host.
const listener = net.createServer();
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = String((listener.address() as net.AddressInfo).port);
await new Promise<void>((resolve) => listener.close(() => resolve()));
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DISPATCH_STATE_ROOT: root,
  DISPATCH_STANDALONE: '1',
  DISPATCH_ENVIRONMENT: 'preview',
  DISPATCH_DEV_MAIL_MODE: 'capture',
  DISPATCH_PROVIDER_MODE: 'fixture',
  DISPATCH_ORIGIN: 'http://127.0.0.1:5173',
  PORT: port,
  DISPATCH_DEV_API_PORT: port,
};
execFileSync(binary, ['seed'], { env, stdio: 'inherit' });
const api = spawn(binary, ['serve'], { stdio: 'inherit', env });
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit',
  env,
});
process.stdout.write(
  `Development fixtures: http://127.0.0.1:5173\nSign in: owner@dispatch.test / Dispatch-demo-2026!\nTemporary state: ${root}\n`,
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  ui.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
api.once('exit', stop);
ui.once('exit', stop);
await Promise.all(
  [api, ui].map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve()))),
);
fs.rmSync(root, { recursive: true, force: true });
