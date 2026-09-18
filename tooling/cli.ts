// Development convenience only. Installed platforms invoke the Rust executable directly.
import { spawn } from 'node:child_process';
import path from 'node:path';
const child = spawn(path.resolve('target/debug/dispatch-backend'), process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});
child.once('error', (error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
