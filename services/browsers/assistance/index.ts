import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Storage } from '../../storage/index.js';
import { atomicPrivateWrite } from '../../storage/paths.js';
import { assert } from '../../../shared/errors.js';
const require = createRequire(import.meta.url);
interface Configuration {
  concurrency: number;
  maximum: number;
}
interface Queue {
  run(
    key: string,
    work: (signal: AbortSignal) => Promise<void>,
    options: { signal: AbortSignal; onPhase: (phase: string) => void },
  ): Promise<void>;
  close(): Promise<void>;
}
interface Runner {
  loadConfiguration(paths: { local: string; live: string }): Configuration | null;
  reapSessions(config: Configuration): Promise<void>;
  runHermes(
    config: Configuration,
    endpoint: string,
    options: { signal: AbortSignal; runtimeKey: string },
  ): Promise<unknown>;
}
/** The shared host owns the optional solver. DSP browser workers never receive its configuration. */
export class BrowserAssistance {
  private configuration?: Configuration;
  private queue?: Queue;
  private runner?: Runner;
  private relay?: (
    socket: string,
    browserPath: string,
  ) => Promise<{ endpoint: string; close(): Promise<void> }>;
  private initialized?: Promise<void>;
  constructor(private storage: Storage) {
    const root = storage.config.stateRoot;
    if (!fs.existsSync(path.join(root, 'config/browser-assistance.json'))) return;
    assert(storage.config.runtimeBundle, 'browser_runtime_not_built', 503);
    const vendor = path.join(storage.config.runtimeBundle, 'assistance');
    this.runner = require(path.join(vendor, 'runner.js')) as Runner;
    const configuration = this.runner.loadConfiguration({
      local: root,
      live: path.resolve(storage.config.runtimeBundle, '../..'),
    });
    if (!configuration) return;
    this.configuration = configuration;
    this.queue = new (require(path.join(vendor, 'queue.js')).AssistanceQueue)(configuration);
    this.relay = require(path.join(vendor, 'relay.js')).browserRelay;
  }
  get enabled() {
    return Boolean(this.configuration);
  }
  async solve(dspId: string, run: string, browserPath: string, signal: AbortSignal) {
    assert(
      this.configuration && this.runner && this.queue && this.relay,
      'assistance_unavailable',
      409,
    );
    assert(
      /^\/devtools\/browser\/[A-Za-z0-9_-]{1,80}$/.test(browserPath),
      'browser_protocol_failed',
    );
    await (this.initialized ??= this.runner.reapSessions(this.configuration));
    const startedAt = new Date().toISOString();
    const receipt = path.join(this.storage.paths.dspArea(dspId, 'state'), 'paycom-assistance.json');
    const record = (phase: string) =>
      atomicPrivateWrite(
        receipt,
        JSON.stringify({ version: 1, startedAt, phase, updatedAt: new Date().toISOString() }),
      );
    try {
      await this.queue.run(
        dspId,
        async (signal) => {
          const relay = await this.relay!(path.join(run, 'cdp.sock'), browserPath);
          try {
            await this.runner!.runHermes(this.configuration!, relay.endpoint, {
              signal,
              runtimeKey: dspId,
            });
          } finally {
            await relay.close();
          }
        },
        { signal, onPhase: record },
      );
      record('verifying');
    } catch (error) {
      record('failed');
      throw error;
    }
  }
  async close() {
    await this.queue?.close();
  }
}
