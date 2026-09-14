import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { configuration } from '../services/config.js';
import { acquireLock } from '../services/storage/lock.js';
import { Paths } from '../services/storage/paths.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const releaseFile = path.join(here, '../release.json');
const config = configuration({
  version: fs.existsSync(releaseFile)
    ? JSON.parse(fs.readFileSync(releaseFile, 'utf8')).version
    : undefined,
  release: fs.existsSync(releaseFile)
    ? JSON.parse(fs.readFileSync(releaseFile, 'utf8')).digest
    : process.env.DISPATCH_RELEASE || 'development',
  runtimeBundle: process.env.DISPATCH_RUNTIME_BUNDLE || path.resolve(here, '../services/runtime'),
});
const locks: (() => void)[] = [];
const unlock = () => {
  for (const release of locks.reverse()) release();
};
let closing = false;
try {
  const paths = new Paths(config.stateRoot, config.standalone);
  if (config.standalone && !fs.existsSync(path.join(paths.platform, 'accounts.sqlite')))
    throw new Error('Platform accounts are missing. Run explicit bootstrap before starting.');
  locks.push(acquireLock(paths.environment(config.environment), 'api'));
  if (config.environment === 'production' && process.env.DISPATCH_FIXTURE_PREVIEW === '1')
    locks.push(acquireLock(paths.environment('preview'), 'api'));
  const { app } = await createApp(config, {
    dashboardRoot: path.resolve(here, '../dashboard'),
    startWorkers: true,
    fixturePreview: process.env.DISPATCH_FIXTURE_PREVIEW === '1',
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    unlock();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(
    `Dispatch ${config.environment} listening at http://${config.host}:${config.port}\n`,
  );
} catch (error) {
  unlock();
  throw error;
}
