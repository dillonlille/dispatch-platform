#!/usr/bin/env node
'use strict';
// Disposable UI acceptance only. Provider transport is synthetic; it never authenticates Paycom.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccessStore, AccessControlService } = require('../../core/accounts/src');
const { createOwnerPaycomSetup } = require('../../core/accounts/src/owner-paycom-setup');
const { success, failure } = require('../../shared/contracts/src');
const { createDashboardServer } = require('../server/server');
async function main() {
  if (process.env.DISPATCH_ONBOARDING_UI_FIXTURE !== '1') throw new Error('explicit_fixture_opt_in_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-onboarding-ui-')); fs.chmodSync(root, 0o700);
  let store;
  try {
  store = new AccessStore({ databaseRoot: path.join(root, 'access'), database: path.join(root, 'access', 'access-control.sqlite3') });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: 'oci_container_v1' });
  const platformInvite = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const password = 'synthetic preview password';
  const platform = await access.acceptNewUser({ token: platformInvite.token, firstName: 'Platform', lastName: 'Tester', password, confirmPassword: password });
  const dsp = access.createOrganization(platform.session, { idempotencyKey: 'preview:create:paycom', name: 'Paycom Preview DSP',
    abbreviation: 'PREVIEW', stationCode: 'TST1', timezone: 'America/Chicago', ownerEmail: 'dsp@example.test' });
  await access.acceptNewUser({ token: dsp.token, firstName: 'DSP', lastName: 'Tester', password, confirmPassword: password });
  store.updateInstallationControl({ organizationId: dsp.organization.id, expectedStatus: 'pending', expectedRevision: 1,
    status: 'waiting_for_provider_auth', revision: 2, currentJobId: null, timestamp: Date.now() });
  const unavailable = async () => failure('installation_not_ready');
  const client = { workforce: { day: unavailable }, sync: { status: unavailable, runNow: unavailable }, system: { status: unavailable } };
  const paycomSetup = createOwnerPaycomSetup({ store, access,
    invoke: async () => success('succeeded', { configured: true }),
  });
  const server = createDashboardServer({ client, access, paycomSetup });
  const cleanup = () => server.close(() => { store.close(); fs.rmSync(root, { recursive: true }); process.exit(0); });
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4327, '127.0.0.1', resolve);
  });
  process.stdout.write('Synthetic onboarding UI: http://127.0.0.1:4327\n');
  } catch (error) {
    store?.close(); fs.rmSync(root, { recursive: true, force: true }); throw error;
  }
}
main().catch(() => { process.stderr.write('onboarding_ui_fixture_failed\n'); process.exitCode = 1; });
