'use strict';
const fs = require('node:fs');
const { AccessError, exact } = require('./validation');
const { VERSION } = require('../../../shared/release-version');
const MAX_BYTES = 128 * 1024;

// This file is generated inside the verified Core bundle, never served as a
// static asset. Older updaters can install it without a new sidecar contract.
function validatePopup(value, identity) {
  exact(value, ['schemaVersion', 'releaseId', 'version', 'sourceCommit', 'changelog', 'afterUpdating']);
  if (!identity || value.schemaVersion !== 1 || value.releaseId !== identity.releaseId
      || value.version !== identity.version || value.sourceCommit !== identity.sourceCommit
      || typeof value.version !== 'string' || !VERSION.test(value.version)
      || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value.releaseId) || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
      || !Array.isArray(value.changelog) || !value.changelog.length || value.changelog.length > 100
      || !Array.isArray(value.afterUpdating) || value.afterUpdating.length > 10
      || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw Error('release_popup_invalid');
  function row(item, change) {
    exact(item, [...(change ? ['kind'] : []), 'title', 'description', 'audience']);
    if (!['platform', 'dsp'].includes(item.audience)
        || change && !['added', 'improved', 'changed', 'fixed', 'removed'].includes(item.kind)
        || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160
        || typeof item.description !== 'string' || item.description.length > 600
        || /[\x00-\x1f\x7f]/.test(item.title + item.description)) throw Error('release_popup_invalid');
  }
  value.changelog.forEach(item => row(item, true));
  value.afterUpdating.forEach(item => row(item, false));
  return value;
}
function loadPopup(file, identity) {
  try {
    if (!identity || fs.statSync(file).size > MAX_BYTES) return null;
    return validatePopup(JSON.parse(fs.readFileSync(file, 'utf8')), identity);
  } catch { return null; } // Missing/invalid optional copy never blocks the dashboard.
}
function createReleasePopup({ store, release = null, clock = Date.now }) {
  if (release) validatePopup(release, release);
  const db = store.db;
  function available(session) {
    if (!release || session.dspView) return null;
    const platform = session.platformPermissions.includes('platform.organizations.read');
    if (!platform) {
      const membership = session.memberships.find(m => m.organizationId === session.activeOrganizationId
        && m.organization.status === 'active' && m.permissions.includes('organization.owner'));
      if (!membership) return null;
      const installed = db.prepare('SELECT release_id,status FROM installations WHERE organization_id=?').get(membership.organizationId);
      if (installed?.release_id !== release.releaseId || installed.status !== 'ready') return null;
    }
    // Gate on successful fleet rollout, not discovery/download or Core promotion.
    // Also bind to the running Core identity so a newer prepared version cannot leak in.
    const rollout = db.prepare(`SELECT c.release_json FROM platform_rollouts r
      JOIN platform_rollout_core c ON c.rollout_id=r.id
      WHERE r.release_id=? AND r.status='completed' AND c.status='succeeded'
      ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1`).get(release.releaseId);
    if (!rollout) return null;
    let metadata;
    try { metadata = JSON.parse(rollout.release_json); } catch { return null; }
    if (metadata.version !== release.version || metadata.sourceCommit !== release.sourceCommit
        || typeof metadata.publishedAt !== 'string' || !Number.isFinite(Date.parse(metadata.publishedAt))) return null;
    const visible = items => items.filter(item => platform || item.audience === 'dsp')
      .map(({ audience, ...item }) => item);
    const changelog = visible(release.changelog);
    if (!changelog.length) return null;
    return { releaseId: release.releaseId, version: release.version, publishedAt: metadata.publishedAt,
      changelog, afterUpdating: visible(release.afterUpdating) };
  }
  return {
    pending(session) {
      const current = available(session);
      return { release: current && !db.prepare('SELECT 1 FROM release_popup_dismissals WHERE user_id=? AND release_id=?')
        .get(session.user.id, current.releaseId) ? current : null };
    },
    dismiss(session, input) {
      exact(input, ['releaseId']);
      const current = available(session);
      if (!current || input.releaseId !== current.releaseId) throw new AccessError('release_popup_unavailable', 409);
      db.prepare('INSERT OR IGNORE INTO release_popup_dismissals(user_id,release_id,dismissed_at) VALUES(?,?,?)')
        .run(session.user.id, current.releaseId, clock());
      return { release: null };
    },
  };
}
module.exports = { validatePopup, loadPopup, createReleasePopup };
