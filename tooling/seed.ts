import { Runtime } from '../services/runtime.js';
import { fixtureWorkforce } from '../integrations/paycom/fixture.js';
import { id } from '../shared/crypto.js';
import { assert } from '../shared/errors.js';
import fs from 'node:fs';
import path from 'node:path';
import { atomicPrivateWrite } from '../services/storage/paths.js';
export const demo = { email: 'owner@dispatch.test', password: 'Dispatch-demo-2026!' };
export async function seed(runtime: Runtime) {
  assert(
    runtime.config.development && runtime.config.providerMode === 'fixture',
    'fixtures_require_development',
  );
  const marker = path.join(runtime.storage.paths.platform, 'development-seeded');
  if (fs.existsSync(marker)) return;
  const existing = runtime.storage.platform.one<{ id: string }>(
    'SELECT id FROM users WHERE email=? AND platform_owner=1',
    demo.email,
  );
  assert(
    existing || !runtime.storage.platform.one('SELECT id FROM users LIMIT 1'),
    'fixture_state_not_empty',
  );
  const owner =
    existing ??
    (await runtime.accounts.createUser(demo.email, 'Platform owner', demo.password, true));
  const getDsp = (name: string, timezone: string, permanent = false) => {
    const row = runtime.storage.platform.one<{ id: string }>(
      'SELECT id FROM dsps WHERE name=?',
      name,
    );
    return row
      ? runtime.dsps.get(row.id)
      : runtime.dsps.create(name, timezone, owner.id, permanent);
  };
  const dev = getDsp('Dev DSP', 'America/Chicago', true),
    north = getDsp('Northline Logistics', 'America/Chicago');
  getDsp('Summit Delivery', 'America/Denver');
  const member =
    runtime.storage.platform.one<{ id: string }>(
      "SELECT id FROM users WHERE email='member@dispatch.test'",
    ) ?? (await runtime.accounts.createUser('member@dispatch.test', 'Jordan Ellis', demo.password));
  runtime.storage.platform.run(
    'INSERT OR IGNORE INTO memberships(id,user_id,dsp_id,role) VALUES (?,?,?,?)',
    id('mem'),
    member.id,
    north.id,
    'member',
  );
  for (const dsp of [dev, north]) {
    runtime.broker.vault.save(dsp.id, {
      clientCode: 'DEMO1',
      username: 'fixture-user',
      password: 'synthetic-password',
    });
    runtime.storage.dsp(dsp.id, (db) =>
      db.run(
        "UPDATE connections SET enabled=1,status='ready',account_label='DEMO1',verified_at=?",
        new Date().toISOString(),
      ),
    );
    runtime.runner.workforce.publish(dsp.id, fixtureWorkforce(dsp), () => {});
    runtime.audit.record(owner.id, dsp.id, 'development.fixtures_loaded');
  }
  atomicPrivateWrite(marker, 'synthetic fixtures initialized\n');
}
