'use strict';
const fs = require('node:fs'), path = require('node:path');
const { AccessError } = require('../accounts/src/validation');
const { compareVersions } = require('./github');
function notes(directory) {
  try {
    const fd = fs.openSync(path.join(directory, 'release-notes.md'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (fs.fstatSync(fd).size > 100000) return 'Release notes unavailable.'; return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  } catch { return 'Release notes unavailable.'; }
}
function createUpdatesService({ releases, commands, store, devDspId, enabled = true }) {
  const fleet = () => store.db.prepare(`SELECT i.runtime_key id,o.name,i.status FROM installations i
    JOIN organizations o ON o.id=i.organization_id WHERE i.backend='directory_service_v1'
    AND i.status<>'decommissioned' ORDER BY i.runtime_key`).all();
  return {
    ownerOnly: true,
    command(session, input) {
      if (session.user.platformRole !== 'owner' || session.dspView) throw new AccessError('platform_forbidden', 403);
      if (!enabled || !commands.worker().available) throw new AccessError('release_worker_unavailable', 503);
      const actor = store.userById(session.user.id);
      if (actor?.platform_role !== 'owner' || actor.status !== 'active') throw new AccessError('platform_forbidden', 403);
      const targets = fleet().map(item => item.id);
      if (['update_dev', 'rollout', 'resume'].includes(input.action) && !targets.includes(devDspId)) throw new AccessError('release_dev_unavailable', 409);
      const job = commands.request(session.user.id, input, targets);
      if (!store.db.prepare('SELECT 1 FROM audit_events WHERE id=?').get(`aud_update_${job.id}`)) store.createAudit({ id: `aud_update_${job.id}`, actorUserId: session.user.id, organizationId: null,
        action: `platform.update.${job.action}`, targetType: 'release_update', targetId: job.id, result: 'succeeded', timestamp: job.createdAt });
      return { id: job.id, status: job.status };
    },
    view(selectedId = null) {
      const state = releases?.state(), jobs = commands?.list() || [], worker = commands?.worker() || { available: false, status: 'offline' };
      const rows = enabled ? fleet() : [], labels = new Map(rows.map(item => [item.id, item.name]));
      const selected = selectedId && /^(core|dsp)_([a-f0-9]{64})$/.exec(selectedId);
      if (selectedId && (!selected || !state?.releases[selected[1]][selected[2]])) throw new AccessError('release_not_found', 404);
      const busy = Boolean(state?.operation || jobs.some(job => ['queued', 'running'].includes(job.status)));
      const tracks = Object.fromEntries(['core', 'dsp'].map(product => {
        const releasesFor = state?.releases[product] || {}, latest = state?.latest[product];
        const digest = selected?.[1] === product ? selected[2] : latest;
        const item = releasesFor[digest], active = product === 'core' ? state?.active.core : state?.active.dsps[devDspId];
        const history = Object.values(releasesFor).sort((a, b) => compareVersions(b.version, a.version)).map(row => ({
          id: `${product}_${row.digest}`, digest: row.digest, version: row.version, publishedAt: row.publishedAt,
        }));
        const current = releasesFor[active];
        return [product, { latest, installedVersion: current?.version || null, installedDigest: active || null,
          release: item ? { id: `${product}_${item.digest}`, digest: item.digest, version: item.version,
            notes: item.notes || notes(item.directory), source: item.source, publishedAt: item.publishedAt, url: item.url } : null,
          history, tested: product === 'dsp' && Boolean(latest && state.tested === latest),
          canUpdate: enabled && worker.available && !busy && Boolean(latest) && (product === 'core'
            ? active !== latest && !['running', 'paused'].includes(state.rollout?.status)
            : !['running', 'paused'].includes(state.rollout?.status) && (!state.tested || state.tested !== latest || state.defaultDsp !== latest || rows.some(row => state.active.dsps[row.id] !== latest))),
        }];
      }));
      const rollout = state?.rollout;
      return { mode: 'independent', enabled, worker, busy, tracks,
        dev: { id: devDspId || null, name: labels.get(devDspId) || 'Dev DSP', available: labels.has(devDspId) },
        recoveryRequired: Boolean(state?.operation),
        operation: state?.operation ? { product: state.operation.product, phase: state.operation.phase,
          dspName: labels.get(state.operation.dspId) || null } : null,
        rollout: rollout ? { digest: rollout.digest, version: state.releases.dsp[rollout.digest]?.version,
          status: rollout.status, failure: rollout.failure, updated: rollout.next, total: rollout.targets.length,
          members: rollout.targets.map((id, index) => ({ name: labels.get(id) || 'Removed DSP',
            status: state.operation?.dspId === id ? 'updating' : index < rollout.next ? 'updated' : index === rollout.next && rollout.status === 'paused' ? 'paused' : 'queued' })) } : null,
        jobs: jobs.slice(-10).reverse().map(job => ({ id: job.id, action: job.action, product: job.product,
          status: job.status, failure: job.failure, createdAt: job.createdAt })),
      };
    },
  };
}
module.exports = { createUpdatesService };
