#!/usr/bin/env node
'use strict';
// Local UI fixture. Core and DSP execution are simulated; no host changes or emails.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccessStore, AccessControlService } = require('../../core/accounts/src');
const { createPlatformUpdates } = require('../../core/accounts/src/platform-updates');
const { createDashboardServer } = require('../server/server');
async function main() {
  if (process.env.DISPATCH_UPDATES_UI_FIXTURE !== '1') throw new Error();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-updates-ui-')); fs.chmodSync(root, 0o700);
  const store = new AccessStore({ databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/access-control.sqlite3') });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: 'oci_container_v1' });
  const invite = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const password = 'synthetic preview password';
  const owner = await access.acceptNewUser({ token: invite.token, firstName: 'Platform', lastName: 'Owner', password, confirmPassword: password });
  for (const [index, name] of ['Northstar Delivery', 'Summit Logistics', 'Riverbend Delivery', 'Atlas Delivery', 'Horizon Logistics', 'Cedar Delivery'].entries()) {
    const dsp = access.createOrganization(owner.session, { idempotencyKey: `preview:updates:${index}`, ownerEmail: `dsp${index}@example.test`, name, stationCode: 'TST1', timezone: 'UTC' });
    store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(dsp.organization.id);
    store.updateOrganizationStatus(dsp.organization.id, 'active', Date.now());
  }
  const releaseOptions = { releases: { dispatch_preview_2: {} }, enabled: true,
    platformReleases: { dispatch_preview_2: { version: '0.0.2', publishedAt: '2026-09-05T00:00:00.000Z', core: {},
      changelog: [
        { kind: 'added', title: 'A dedicated Platform Owner workspace', description: 'Manage DSPs, updates and platform settings in one place.' },
        { kind: 'improved', title: 'Create a DSP with just an email address', description: 'Owners complete their DSP details after accepting the invitation.' },
        { kind: 'fixed', title: 'Clearer setup error messages', description: 'See what needs attention when a request cannot be completed.' },
      ] } } };
  const delivery = process.env.DISPATCH_RELEASE_DELIVERY_UI_FIXTURE === '1'
    ? require('../server/release-delivery').createReleaseDelivery(root) : null;
  if (delivery) {
    fs.mkdirSync(path.join(root, 'config'), { mode: 0o700 });
    require('../../core/installations/src/release-delivery-files').atomic(path.join(root, 'config/release-delivery-status.json'),
      { state: 'preparing', version: '0.0.2', retryable: false, changelog: releaseOptions.platformReleases.dispatch_preview_2.changelog });
  }
  const updates = createPlatformUpdates({ store, ...releaseOptions, delivery,
    loadCatalogs: delivery ? () => delivery.view()?.state === 'ready' ? releaseOptions : { releases: {}, platformReleases: {} } : null });
  const unavailable = async () => ({ ok: false, status: 'installation_not_ready', data: null, error: { code: 'installation_not_ready' } });
  const client = { workforce: { day: unavailable }, sync: { status: unavailable, runNow: unavailable }, system: { status: unavailable } };
  const server = createDashboardServer({ client, access, updates });
  const cleanup = () => server.close(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); });
  process.once('SIGTERM', cleanup); process.once('SIGINT', cleanup);
  await new Promise(resolve => server.listen(4328, '127.0.0.1', resolve));
  process.stdout.write(`Synthetic updates preview: http://127.0.0.1:4328\nFixture database: ${root}/access/access-control.sqlite3\n`);
}
main().catch(() => { process.stderr.write('updates_preview_failed\n'); process.exitCode = 1; });
