import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Storage } from '../storage/index.js';
import { privateDirectory } from '../storage/paths.js';
import type { Credentials } from '../auth-broker/vault.js';
import type { Dsp, Workforce } from '../../shared/contracts/index.js';
import type { BrowserCommand, BrowserEvent } from './protocol.js';
import { AppError, assert } from '../../shared/errors.js';
import { id } from '../../shared/crypto.js';
import { Egress } from './egress.js';
import { launchSandbox, launchCollector } from './sandbox.js';
import { paycom } from '../../integrations/paycom/manifest.js';
import { fixtureWorkforce } from '../../integrations/paycom/fixture.js';
export class BrowserSession extends EventEmitter {
  status: 'starting' | 'ready' | 'challenge' | 'closed' = 'starting';
  private child?: ChildProcessWithoutNullStreams;
  private collector?: ChildProcessWithoutNullStreams;
  private fixtureUrl?: string;
  private egress?: Egress;
  private closePromise?: Promise<void>;
  private deadline: ReturnType<typeof setTimeout>;
  private screenshotWaiter?: (image: string) => void;
  constructor(
    readonly manager: BrowserManager,
    readonly dsp: Dsp,
    readonly run: string,
    readonly fixture: boolean,
  ) {
    super();
    this.deadline = setTimeout(() => void this.close('verification_expired'), 10 * 60_000);
    this.deadline.unref();
  }
  async start(credentials: Credentials, fixtureUrl?: string) {
    this.fixtureUrl = fixtureUrl;
    if (this.fixture && !fixtureUrl) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (credentials.password === 'invalid-password')
        throw new AppError('invalid_credentials', 409);
      if (credentials.password === 'require-verification')
        this.event({
          type: 'challenge',
          message: 'Enter the verification code for this connection.',
        });
      else this.event({ type: 'ready' });
      return;
    }
    const fixture = fixtureUrl ? new URL(fixtureUrl) : undefined;
    assert(
      !fixture ||
        (this.manager.storage.config.development &&
          fixture.hostname === 'fixture.dispatch.invalid'),
      'fixture_forbidden',
      403,
    );
    this.egress = new Egress(path.join(this.run, 'egress.sock'), {
      hosts: fixture ? [] : paycom.hosts,
      ...(fixture ? { fixture: { hostname: fixture.hostname, port: Number(fixture.port) } } : {}),
    });
    await this.egress.listen();
    this.child = launchSandbox(
      this.manager.storage.config,
      this.manager.storage.paths.profile(this.dsp.id),
      this.run,
    );
    let buffer = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 24 * 1024 * 1024) {
        void this.close('browser_protocol_failed');
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.event(JSON.parse(line) as BrowserEvent);
        } catch {
          void this.close('browser_protocol_failed');
        }
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) =>
      this.emit('diagnostic', chunk.toString().slice(0, 4000)),
    );
    this.child.on('error', () => void this.close('browser_start_failed'));
    this.child.on('exit', () => void this.close('browser_lost'));
    const waiting = this.waitFor(['ready', 'challenge'], 30_000);
    this.send({
      action: 'start',
      credentials,
      timezone: this.dsp.timezone,
      ...(fixtureUrl ? { fixtureUrl } : {}),
    });
    await waiting;
  }
  private event(event: BrowserEvent) {
    if (this.status === 'closed') return;
    if (event.type === 'ready') this.status = 'ready';
    if (event.type === 'challenge') this.status = 'challenge';
    if (event.type === 'screenshot') {
      this.screenshotWaiter?.(event.image);
      this.screenshotWaiter = undefined;
    }
    this.emit('event', event);
  }
  private send(command: BrowserCommand) {
    assert(
      this.child && !this.child.killed && this.status !== 'closed',
      'browser_unavailable',
      409,
    );
    this.child.stdin.write(JSON.stringify(command) + '\n');
  }
  private waitFor(types: BrowserEvent['type'][], timeout = 300_000): Promise<BrowserEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new AppError('provider_timeout', 504));
      }, timeout);
      const listener = (event: BrowserEvent) => {
        if (event.type === 'error') {
          cleanup();
          reject(new AppError(event.code, 409));
        } else if (types.includes(event.type)) {
          cleanup();
          resolve(event);
        }
      };
      const closed = () => {
        cleanup();
        reject(new AppError('browser_lost', 503));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', listener);
        this.off('closed', closed);
      };
      this.on('event', listener);
      this.on('closed', closed);
    });
  }
  async verify(code: string) {
    assert(this.status === 'challenge', 'verification_not_requested', 409);
    if (this.fixture && !this.child) {
      assert(code === '123456', 'invalid_verification_code', 409);
      this.event({ type: 'ready' });
      return;
    }
    const waiting = this.waitFor(['ready', 'challenge'], 30_000);
    this.send({ action: 'verify', code });
    await waiting;
  }
  async assist(input: Extract<BrowserCommand, { action: 'assist' }>['input']) {
    assert(this.status === 'challenge' && this.child, 'assistance_unavailable', 409);
    const waiting = this.waitFor(['ready', 'challenge'], 30_000);
    this.send({ action: 'assist', input });
    await waiting;
  }
  async screenshot(): Promise<string> {
    assert(this.status === 'challenge' && this.child, 'assistance_unavailable', 409);
    const waiting = this.waitFor(['screenshot'], 10_000);
    this.send({ action: 'screenshot' });
    const result = await waiting;
    assert(result.type === 'screenshot', 'browser_protocol_failed');
    return result.image;
  }
  async collect(onProgress: (progress: number, message: string) => void): Promise<Workforce> {
    assert(this.status === 'ready', 'verification_required', 409);
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => void this.close('provider_timeout'), 30 * 60_000);
    this.deadline.unref();
    if (this.fixture && !this.child) {
      onProgress(30, 'Reading employee roster');
      await new Promise((resolve) => setTimeout(resolve, 100));
      onProgress(80, 'Validating timecards');
      return fixtureWorkforce(this.dsp);
    }
    assert(!this.collector, 'connection_busy', 409);
    const access = this.waitFor(['collection_access']);
    this.send({ action: 'collect' });
    const grant = await access;
    assert(grant.type === 'collection_access', 'browser_protocol_failed');
    const child = launchCollector(this.manager.storage.config, this.run);
    this.collector = child;
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 24 * 1024 * 1024) {
        void this.close('browser_protocol_failed');
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.event(JSON.parse(line) as BrowserEvent);
        } catch {
          void this.close('browser_protocol_failed');
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) =>
      this.emit('diagnostic', chunk.toString().slice(0, 4000)),
    );
    child.on('error', () => this.event({ type: 'error', code: 'collection_failed' }));
    child.on('exit', (code) => {
      if (code !== 0) this.event({ type: 'error', code: 'collection_failed' });
    });
    const listener = (event: BrowserEvent) => {
      if (event.type === 'progress') {
        try {
          onProgress(event.progress, event.message);
        } catch {
          void this.close('job_cancelled');
        }
      }
    };
    this.on('event', listener);
    try {
      const waiting = this.waitFor(['collected'], 30 * 60_000);
      child.stdin.end(
        JSON.stringify({
          endpointPath: grant.path,
          timezone: this.dsp.timezone,
          fixtureUrl: this.fixtureUrl,
        }),
      );
      const result = await waiting;
      assert(result.type === 'collected', 'browser_protocol_failed');
      return result.workforce;
    } finally {
      this.off('event', listener);
    }
  }
  async close(code?: string) {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.status = 'closed';
      clearTimeout(this.deadline);
      this.emit('closed', code);
      if (
        this.collector &&
        this.collector.exitCode === null &&
        this.collector.signalCode === null
      ) {
        const child = this.collector;
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        });
      }
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          child.stdin.end(JSON.stringify({ action: 'close' }) + '\n');
        });
      }
      await this.egress?.close();
      this.manager.release(this);
      fs.rmSync(this.run, { recursive: true, force: true });
    })();
    return this.closePromise;
  }
}
export class BrowserManager {
  readonly sessions = new Map<string, BrowserSession>();
  private starting = new Set<string>();
  constructor(readonly storage: Storage) {}
  async acquire(dsp: Dsp, credentials: Credentials, fixtureUrl?: string) {
    assert(dsp.environment === this.storage.config.environment, 'environment_mismatch', 403);
    const old = this.sessions.get(dsp.id);
    if (old && old.status !== 'closed') {
      assert(old.status !== 'starting', 'connection_busy', 409);
      return old;
    }
    assert(!this.starting.has(dsp.id), 'connection_busy', 409);
    assert(this.sessions.size < this.storage.config.browserCapacity, 'browser_capacity_busy', 429);
    this.starting.add(dsp.id);
    const run = privateDirectory(
      path.join(this.storage.paths.environment(dsp.environment), 'browser-runs', id('run')),
    );
    const session = new BrowserSession(
      this,
      dsp,
      run,
      this.storage.config.providerMode === 'fixture',
    );
    this.sessions.set(dsp.id, session);
    try {
      await session.start(credentials, fixtureUrl);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    } finally {
      this.starting.delete(dsp.id);
    }
  }
  release(session: BrowserSession) {
    if (this.sessions.get(session.dsp.id) === session) this.sessions.delete(session.dsp.id);
  }
  async revoke(dspId: string) {
    await this.sessions.get(dspId)?.close();
  }
  async close() {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
  health() {
    return { active: this.sessions.size, capacity: this.storage.config.browserCapacity };
  }
}
