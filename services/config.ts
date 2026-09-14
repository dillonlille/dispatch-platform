import path from 'node:path';
import os from 'node:os';
import { assert } from '../shared/errors.js';
import type { Environment } from '../shared/contracts/index.js';
export interface Config {
  stateRoot: string;
  environment: Environment;
  development: boolean;
  origin: string;
  host: string;
  port: number;
  release: string;
  providerMode: 'fixture' | 'native';
  browserCapacity: number;
  jobLeaseMs: number;
  browserExecutable?: string;
  runtimeBundle?: string;
  smtpUrl?: string;
  mailFrom?: string;
  previewOrigin?: string;
  previewKey?: string;
  allowDeployment: boolean;
}
export function configuration(overrides: Partial<Config> = {}): Config {
  const development = process.env.NODE_ENV !== 'production';
  const config: Config = {
    development,
    stateRoot:
      process.env.DISPATCH_STATE_ROOT ||
      path.join(os.tmpdir(), `dispatch-development-${process.getuid?.() ?? 'local'}`),
    environment: process.env.DISPATCH_ENVIRONMENT === 'preview' ? 'preview' : 'production',
    origin: process.env.DISPATCH_ORIGIN || 'http://127.0.0.1:5173',
    host: '127.0.0.1',
    port: Number(process.env.PORT || 5180),
    release: process.env.DISPATCH_RELEASE || 'development',
    providerMode: process.env.DISPATCH_PROVIDER_MODE === 'native' ? 'native' : 'fixture',
    browserCapacity: 2,
    jobLeaseMs: 120_000,
    browserExecutable: process.env.DISPATCH_BROWSER_EXECUTABLE,
    runtimeBundle: process.env.DISPATCH_RUNTIME_BUNDLE,
    smtpUrl: process.env.DISPATCH_SMTP_URL,
    mailFrom: process.env.DISPATCH_MAIL_FROM,
    previewOrigin: process.env.DISPATCH_PREVIEW_ORIGIN,
    previewKey: process.env.DISPATCH_PREVIEW_KEY,
    allowDeployment: process.env.DISPATCH_ENABLE_DEPLOYMENT === '1',
    ...overrides,
  };
  assert(
    path.isAbsolute(config.stateRoot) && config.stateRoot !== '/',
    'absolute_state_root_required',
  );
  const origin = new URL(config.origin);
  assert(
    origin.origin === config.origin && !origin.username && !origin.password,
    'canonical_origin_required',
  );
  assert(
    config.development || (origin.protocol === 'https:' && config.providerMode === 'native'),
    'production_configuration_required',
  );
  assert(
    Number.isInteger(config.browserCapacity) &&
      config.browserCapacity > 0 &&
      config.browserCapacity <= 16,
    'invalid_browser_capacity',
  );
  return Object.freeze(config);
}
