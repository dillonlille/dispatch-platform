import { collectorDatabase } from './collector-storage.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// The one place tests and tooling start a private Dispatch server: temporary state,
// a free port, the fixture environment, seeded data, `serve`, the health wait and login.

/** The accounts `seed` creates; `bootstrap` gives the owner the same password. */
export const demo = {
  email: 'owner@dispatch.test',
  member: 'member@dispatch.test',
  password: 'Dispatch-demo-2026!',
};
/** The release build `npm run build` writes, which browser and smoke checks serve. */
export const built = {
  binary: path.resolve('.build/services/rust/dispatch-backend'),
  env: { DISPATCH_ARTIFACT_ROOT: path.resolve('.build') },
};
export type FixtureOptions = {
  /** `seed` loads the demo DSPs (default); false bootstraps an empty platform. */
  seed?: boolean;
  /** Added to, or replacing, the fixture environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to DISPATCH_TEST_BINARY or the debug build. */
  binary?: string;
  /** `inherit` streams the server's output instead of keeping it for `logs()`. */
  output?: 'capture' | 'inherit';
};
const defaultBinary = path.resolve(
  process.env.DISPATCH_TEST_BINARY ?? 'target/debug/dispatch-backend',
);
export async function freePort() {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
/** Private state, environment and seeded data for a server that is not running yet. */
export async function prepare(options: boolean | FixtureOptions = true) {
  let binary = typeof options === 'boolean' ? defaultBinary : (options.binary ?? defaultBinary);
  const seed = typeof options === 'boolean' ? options : (options.seed ?? true);
  const overrides = typeof options === 'boolean' ? {} : (options.env ?? {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-fixture-'));
  if (overrides.DISPATCH_FIXTURE_PROVIDER_URL) {
    const executable = path.join(root, 'dispatch-backend');
    fs.copyFileSync(binary, executable, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(executable, 0o700);
    binary = executable;
  }
  const port = await freePort();
  // Keep the server transport pinned to loopback, while advertising localhost as
  // the application origin. WebAuthn permits localhost for development but does
  // not permit an IP address as a relying-party ID.
  const address = `http://127.0.0.1:${port}`;
  const origin = `http://localhost:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DISPATCH_STANDALONE: '1',
    DISPATCH_ENVIRONMENT: 'preview',
    DISPATCH_DEV_MAIL_MODE: 'capture',
    DISPATCH_PRODUCTION_MAIL_MODE: 'capture',
    DISPATCH_STATE_ROOT: root,
    DISPATCH_PROVIDER_MODE: 'fixture',
    DISPATCH_ORIGIN: origin,
    PORT: String(port),
    ...overrides,
  };
  const cli = (args: string[], input?: string) =>
    execFileSync(binary, args, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (seed)
    execFileSync(binary, ['seed'], {
      env: { ...env, DISPATCH_PROVIDER_MODE: 'fixture' },
      stdio: 'pipe',
    });
  else cli(['bootstrap', demo.email, 'Fresh', 'Owner'], demo.password);
  return { root, binary, env, port, address, cli };
}
export async function fixture(options: boolean | FixtureOptions = true) {
  const { root, binary, env, address: origin, cli } = await prepare(options);
  const overrides = typeof options === 'boolean' ? {} : (options.env ?? {});
  const inherit = typeof options !== 'boolean' && options.output === 'inherit';
  const password = demo.password;
  let server: ChildProcess | undefined;
  let logs = '';
  /** The untouched response, for pages and assets that are not JSON. */
  const raw = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: env.DISPATCH_ORIGIN, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(overrides.DISPATCH_FIXTURE_PROVIDER_URL ? 180000 : 15000),
    });
  const request = async (url: string, body?: unknown, headers: Record<string, string> = {}) => {
    if (headers.host) {
      return await new Promise<{
        status: number;
        statusCode: number;
        body: string;
        json: <T = any>() => T;
        headers: Headers;
        value: any;
      }>((resolve, reject) => {
        const req = http.request(origin + url, { headers }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              statusCode: res.statusCode!,
              body: text,
              json: <T = any>() => JSON.parse(text) as T,
              headers: new Headers(),
              value: JSON.parse(text),
            }),
          );
        });
        req.once('error', reject);
        req.end();
      });
    }
    const response = await raw(url, body, headers);
    const value = await response.json();
    return {
      status: response.status,
      statusCode: response.status,
      body: JSON.stringify(value),
      json: <T = any>() => value as T,
      headers: response.headers,
      value,
    };
  };
  const start = async () => {
    server = spawn(binary, ['serve'], {
      env,
      stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    // A browser that fails to start says why only in the server's log. Show that line in
    // the test output as it happens, so a failure on a CI runner explains itself.
    const keep = (data: Buffer) => {
      logs += data;
      for (const line of String(data).split('\n'))
        if (line.includes('"browser.start_failed"')) process.stderr.write(`${line}\n`);
    };
    server.stdout?.on('data', keep);
    server.stderr?.on('data', keep);
    await until(async () => {
      try {
        return (await request('/api/health')).status === 200;
      } catch {
        assert(server?.exitCode === null, logs);
        return false;
      }
    });
  };
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const process = server;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          process.kill('SIGKILL');
          reject(new Error(`Server failed to stop: ${logs}`));
        }, 10000);
        process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        process.kill(signal);
      });
    }
  };
  const database = <T>(area: string, callback: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path.join(root, area));
    try {
      // The fixture server's mail worker can briefly hold the write lock.
      db.exec('PRAGMA busy_timeout=5000');
      return callback(db);
    } finally {
      db.close();
    }
  };
  const client = async (email = demo.email, secret = password) => {
    const login = await request('/api/auth/login', { email, password: secret });
    assert.equal(login.status, 200, JSON.stringify(login.value));
    const headers: Record<string, string> = {
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    };
    const session = await request('/api/session', undefined, headers);
    headers['x-csrf-token'] = session.value.csrf;
    return {
      session: session.value,
      headers,
      get: (url: string) => request(url, undefined, headers),
      post: (url: string, body: unknown = {}) => request(url, body, headers),
      select: async (id: string) => {
        const view = await request('/api/session/dsp', { dspId: id }, headers);
        assert.equal(view.status, 200, JSON.stringify(view.value));
        headers['x-dispatch-view'] = view.value.token;
        return view.value;
      },
    };
  };
  await start();
  return {
    root,
    binary,
    env,
    cli,
    start,
    stop,
    request,
    raw,
    client,
    database,
    collector: <T>(dspId: string, callback: (db: DatabaseSync) => T): T =>
      database(path.relative(root, collectorDatabase(root, dspId, 'paycom')), callback),
    pid: () => server!.pid!,
    /** Resolves when the running server exits, however it was stopped. */
    exited: () =>
      new Promise<void>((resolve) =>
        server!.exitCode === null && server!.signalCode === null
          ? server!.once('exit', () => resolve())
          : resolve(),
      ),
    logs: () => logs,
    close: async () => {
      await stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function until(check: () => Promise<boolean>, timeout = 12000) {
  const start = Date.now();
  while (!(await check())) {
    assert(Date.now() - start < timeout, 'Condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
