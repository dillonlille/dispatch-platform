import { spawn } from 'node:child_process';
import { configuration } from '../services/config.js';
import { Runtime } from '../services/runtime.js';
import { seed, demo } from './seed.js';
const config = configuration({ development: true, providerMode: 'fixture' });
const runtime = new Runtime(config);
await seed(runtime);
await runtime.close();
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DISPATCH_STATE_ROOT: config.stateRoot,
  DISPATCH_FIXTURE_PREVIEW: '1',
  DISPATCH_PROVIDER_MODE: 'fixture',
};
const api = spawn(process.execPath, ['--import', 'tsx', 'api/main.ts'], { stdio: 'inherit', env });
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit',
  env,
});
process.stdout.write(
  `Development fixtures only. Open ${config.origin}\nSign in: ${demo.email} / ${demo.password}\nState: ${config.stateRoot}\n`,
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
