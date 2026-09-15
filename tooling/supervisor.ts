import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { configuration } from '../services/config.js';
import { Storage } from '../services/storage/index.js';
import { Audit } from '../services/audit/index.js';
import { ReleaseService } from '../services/releases/index.js';
import { acquireLock } from '../services/storage/lock.js';
import { keyFile } from '../services/storage/paths.js';
import { assert, safeError } from '../shared/errors.js';
import type { Environment } from '../shared/contracts/index.js';
// Explicit operator entrypoint. Building or importing an artifact never starts it.
assert(
  process.env.DISPATCH_ENABLE_DEPLOYMENT === '1' && process.env.DISPATCH_STATE_ROOT,
  'explicit_supervisor_configuration_required',
);
const config = configuration(),
  storage = new Storage(config),
  audit = new Audit(storage),
  releases = new ReleaseService(storage, audit);
const unlock = acquireLock(storage.paths.platform, 'supervisor');
const previewKey = keyFile(path.join(storage.paths.platform, 'preview.key')).toString('base64url');
const children = new Map<Environment, ChildProcess>();
let stopping = false,
  busy = false;
const port = (env: Environment) => (env === 'production' ? config.port : config.port + 1);
const target = (env: Environment) =>
  env === 'production' ? config.stateRoot : path.join(config.stateRoot, 'preview');
function start(env: Environment) {
  if (!fs.existsSync(path.join(target(env), 'api/main.js'))) return;
  const child = spawn(process.execPath, [path.join(target(env), 'api/main.js')], {
    cwd: target(env),
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port(env)),
      DISPATCH_ENVIRONMENT: env,
      DISPATCH_PREVIEW_ORIGIN: `http://127.0.0.1:${port('preview')}`,
      DISPATCH_PREVIEW_KEY: previewKey,
      DISPATCH_FIXTURE_PREVIEW: '0',
    },
  });
  children.set(env, child);
  child.once('exit', () => {
    if (children.get(env) === child) children.delete(env);
  });
  return child;
}
async function stop(env: Environment) {
  const child = children.get(env);
  if (!child) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 30_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', reject);
    child.kill('SIGTERM');
  });
}
async function healthy(env: Environment, digest: string) {
  const child = children.get(env);
  for (let i = 0; i < 100; i++) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
      throw new Error('release_process_exited');
    try {
      const response = await fetch(`http://127.0.0.1:${port(env)}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = (await response.json()) as { release: string; status: string };
      if (response.ok && body.release === digest && body.status === 'ready') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('release_health_failed');
}
async function tick() {
  if (busy || stopping) return;
  busy = true;
  let activation: ReturnType<ReleaseService['installFiles']> | undefined;
  const request = storage.platform.one<{ id: string; digest: string; environment: Environment }>(
    "SELECT * FROM deployment_requests WHERE status='queued' ORDER BY created_at LIMIT 1",
  );
  try {
    if (!request) return;
    storage.platform.run("UPDATE deployment_requests SET status='running' WHERE id=?", request.id);
    await stop(request.environment);
    activation = releases.installFiles(request.digest, request.environment);
    assert(start(request.environment), 'release_start_failed');
    await healthy(request.environment, request.digest);
    releases.complete(request.id);
  } catch (error) {
    if (request) {
      await stop(request.environment);
      if (activation) releases.rollbackFiles(activation.backup);
      start(request.environment);
      storage.platform.run(
        "UPDATE deployment_requests SET status='failed',error=?,completed_at=? WHERE id=?",
        safeError(error),
        new Date().toISOString(),
        request.id,
      );
      audit.record(null, null, 'release.activation_failed', safeError(error));
    }
  } finally {
    busy = false;
  }
}
// A crash during activation requires inspecting the durable request and receipt;
// fail closed instead of starting a possibly incomplete directory automatically.
assert(
  !storage.platform.one("SELECT id FROM deployment_requests WHERE status='running'"),
  'interrupted_activation_requires_recovery',
);
start('preview');
start('production');
const timer = setInterval(() => void tick(), 1000);
async function close() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  while (busy) await new Promise((resolve) => setTimeout(resolve, 100));
  await stop('production');
  await stop('preview');
  storage.close();
  unlock();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
