import { collectorDatabase } from '../tooling/collector-storage.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const defaultBinary = path.resolve('target/debug/dispatch-backend');
const password = 'Dispatch-demo-2026!';
export async function fixture(
  options: boolean | { seed?: boolean; env?: NodeJS.ProcessEnv; binary?: string } = true,
) {
  let binary = typeof options === 'boolean' ? defaultBinary : (options.binary ?? defaultBinary);
  const seed = typeof options === 'boolean' ? options : (options.seed ?? true);
  const overrides = typeof options === 'boolean' ? {} : (options.env ?? {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rust-core-'));
  if (overrides.DISPATCH_FIXTURE_PROVIDER_URL) {
    const executable = path.join(root, 'dispatch-backend');
    fs.copyFileSync(binary, executable, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(executable, 0o700);
    binary = executable;
  }
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DISPATCH_STANDALONE: '1',
    DISPATCH_ENVIRONMENT: 'preview',
    DISPATCH_STATE_ROOT: root,
    DISPATCH_PROVIDER_MODE: 'fixture',
    DISPATCH_ORIGIN: origin,
    PORT: String(port),
    DISPATCH_WORKER_NODE: process.execPath,
    ...overrides,
  };
  const cli = (args: string[], input?: string) =>
    execFileSync(binary, args, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (seed)
    execFileSync(binary, ['seed'], {
      env: { ...env, DISPATCH_PROVIDER_MODE: 'fixture' },
      stdio: 'pipe',
    });
  else cli(['bootstrap', 'owner@dispatch.test', 'Fresh', 'Owner'], password);
  let server: ChildProcess | undefined;
  let logs = '';
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
    const response = await fetch(origin + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(overrides.DISPATCH_FIXTURE_PROVIDER_URL ? 180000 : 15000),
    });
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
    server = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (data) => {
      logs += data;
    });
    server.stderr!.on('data', (data) => {
      logs += data;
    });
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
      return callback(db);
    } finally {
      db.close();
    }
  };
  const client = async (email = 'owner@dispatch.test', secret = password) => {
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
    env,
    cli,
    start,
    stop,
    request,
    client,
    database,
    collector: <T>(dspId: string, callback: (db: DatabaseSync) => T): T =>
      database(path.relative(root, collectorDatabase(root, dspId, 'paycom')), callback),
    pid: () => server!.pid!,
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
