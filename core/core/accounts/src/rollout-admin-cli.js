'use strict';

// Server-local operator capability, protected by the same filesystem ownership
// checks as owner-admin. No browser session or credentials are created.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveLocalRuntimePaths } = require('../../../shared/paths/runtime-paths');
const { VERSION } = require('../../../shared/release-version');
const { AccessStore } = require('./store');
const { createPlatformUpdates } = require('./platform-updates');
const { loadPrivateOciReleaseCatalog } = require('../../installations/src/release-catalog');
const { loadPlatformReleaseCatalog } = require('../../installations/src/platform-release-catalog');

const usage = 'dispatch-access-admin rollout-status|rollout-start|rollout-pause|rollout-resume --local-root PATH --version VERSION --commit SHA [--canary-organization ID]';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function parse(argv) {
  const [action, ...args] = argv;
  if (!['rollout-status', 'rollout-start', 'rollout-pause', 'rollout-resume'].includes(action)) fail('invalid_input');
  const input = { action };
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--canary-organization': 'canaryOrganizationId', '--local-root': 'localRoot', '--version': 'version', '--commit': 'commit' }[args[i]];
    if (!key || input[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid_input');
    input[key] = args[i + 1];
  }
  if (!input.localRoot || !path.isAbsolute(input.localRoot) || path.resolve(input.localRoot) !== input.localRoot
      || !input.version || input.version.length > 80 || !VERSION.test(input.version) || !/^[a-f0-9]{40}$/.test(input.commit || '')) fail('invalid_input');
  if (input.canaryOrganizationId !== undefined && (input.action !== 'rollout-start' || !/^[a-z][a-z0-9_-]{2,95}$/.test(input.canaryOrganizationId))) fail('invalid_input');
  return input;
}
function operate(store, updates, catalogs, input) {
  // Bind commands to the requested identity, including resume/pause, inside the
  // same transaction that changes state so another rollout cannot race the guard.
  const operation = () => {
    const row = store.db.prepare(`SELECT r.*,c.release_json FROM platform_rollouts r
      JOIN platform_rollout_core c ON c.rollout_id=r.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get();
    const current = row && JSON.parse(row.release_json);
    const matching = current?.version === input.version && current?.sourceCommit === input.commit;
    const candidates = Object.entries(catalogs.platformReleases).filter(([, release]) => release.version === input.version);
    if (candidates.some(([, release]) => release.sourceCommit !== input.commit)) fail('release_identity_mismatch');
    if (current?.version === input.version && !matching) fail('release_identity_mismatch');
    const prepared = candidates.find(([id, release]) => release.sourceCommit === input.commit && catalogs.releases[id]);
    let status = matching ? row.status : prepared ? 'ready' : 'not_prepared';
    if (input.action !== 'rollout-status') {
      const owner = store.db.prepare("SELECT id FROM users WHERE platform_role='owner' AND status='active' ORDER BY created_at,id LIMIT 1").get();
      if (!owner) fail('platform_owner_required');
      const session = { user: { id: owner.id } };
      if (input.action === 'rollout-start') {
        if (matching && input.canaryOrganizationId) {
          const selected = store.db.prepare('SELECT organization_id FROM platform_rollout_members WHERE rollout_id=? AND position=0').get(row.id);
          if (selected?.organization_id !== input.canaryOrganizationId) fail('rollout_canary_mismatch');
        }
        if (row && row.status !== 'completed' && !matching) fail('rollout_in_progress');
        // A repeated start observes the existing rollout, including a paused one.
        // Only an explicit resume after diagnosis may retry failed work.
        if (!matching) {
          if (!prepared) fail('release_not_prepared');
          updates.command(session, { action: 'start', releaseId: prepared[0],
            ...(input.canaryOrganizationId ? { canaryOrganizationId: input.canaryOrganizationId } : {}),
            idempotencyKey: `operator:${crypto.createHash('sha256').update(`${input.version}:${input.commit}`).digest('hex')}` });
        }
      } else {
        if (!matching) fail('rollout_target_mismatch');
        if (row.status !== 'completed') {
          if (!prepared && input.action === 'rollout-resume') fail('release_not_prepared');
          updates.command(session, { action: input.action.slice('rollout-'.length) });
        }
      }
    }
    const view = updates.view();
    const target = view.rollout?.version === input.version && (matching || prepared) ? view.rollout : null;
    if (target) {
      status = target.status;
      if (target.status === 'running' && target.phase === 'dsps' && target.core.status === 'succeeded' && target.updated === target.total) target.phase = 'cleanup';
    }
    const timings = [];
    if (target && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operation_stage_timings'").get()) {
      const active = store.db.prepare('SELECT id FROM platform_rollouts WHERE release_id=? ORDER BY created_at DESC LIMIT 1').get(target.release);
      if (active) timings.push(...store.db.prepare(`SELECT job_id,attempt,stage,started_at,finished_at,duration_ms,status,failure_code FROM operation_stage_timings
        WHERE job_id=? OR job_id IN (SELECT job_id FROM platform_rollout_members WHERE rollout_id=?)
        OR job_id IN (SELECT id FROM platform_backup_requests WHERE json_extract(input_json,'$.rolloutId')=?)
        OR job_id IN (SELECT job_id FROM platform_backup_requests WHERE json_extract(input_json,'$.rolloutId')=?)
        ORDER BY started_at DESC LIMIT 200`).all(active.id, active.id, active.id, active.id).reverse());
    }
    return { ok: true, version: input.version, sourceCommit: input.commit, status,
      releaseId: target?.release || prepared?.[0] || null,
      timings, rollout: target, activeReleaseId: view.rollout?.status !== 'completed' ? view.rollout?.release || null : null };
  };
  if (input.action !== 'rollout-status') return store.transaction(operation);
  // A deferred read transaction gives one consistent WAL snapshot without
  // competing with the backup and rollout workers for the writer lock.
  store.db.exec('BEGIN');
  try { const result = operation(); store.db.exec('COMMIT'); return result; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
async function main(argv, { write = value => process.stdout.write(value), wake = require('./worker-wakeup').wake } = {}) {
  if (argv.length === 2 && argv[1] === '--help') { write(`${usage}\n`); return 0; }
  let store;
  try {
    const input = parse(argv);
    const paths = resolveLocalRuntimePaths({ localRoot: input.localRoot });
    if (paths.accessControl.database !== path.join(input.localRoot, 'data/access-control/access-control.sqlite3')) fail('runtime_path_mismatch');
    if (!fs.existsSync(paths.accessControl.database)) fail('access_not_initialized');
    const releases = loadPrivateOciReleaseCatalog(path.join(input.localRoot, 'config/oci-releases.json'));
    const platformReleases = loadPlatformReleaseCatalog(path.join(input.localRoot, 'config/platform-releases.json'), releases);
    store = new AccessStore(paths.accessControl, { readOnly: input.action === 'rollout-status' });
    const updates = createPlatformUpdates({ store, releases, platformReleases, enabled: true });
    const result = operate(store, updates, { releases, platformReleases }, input);
    if (input.action !== 'rollout-status' && result.status === 'running') {
      wake(['reconcile', 'core'], { databaseRoot: paths.accessControl.databaseRoot, localRoot: input.localRoot });
    }
    write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const safe = new Set(['invalid_input', 'runtime_path_mismatch', 'access_not_initialized', 'unsafe_access_storage',
      'access_schema_incompatible', 'platform_owner_required', 'release_identity_mismatch', 'release_not_prepared',
      'rollout_in_progress', 'rollout_target_mismatch', 'update_unavailable', 'installation_operation_in_progress',
      'native_migration_required', 'rollout_canary_mismatch', 'rollout_canary_unavailable', 'platform_release_invalid', 'runtime_boundary_violation']);
    write(`${JSON.stringify({ ok: false, status: safe.has(error.code) ? error.code : 'rollout_admin_failed' })}\n`);
    return 1;
  } finally { store?.close(); }
}
module.exports = { main, parse, operate };
