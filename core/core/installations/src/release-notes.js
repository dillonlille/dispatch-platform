'use strict';
// Optional presentation sidecar. The v1 installation manifest remains unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { privateJson, atomic } = require('./release-delivery-files');
const { githubAuthoring, markdown } = require('./github-release-notes');
const ICONS = new Set(['database', 'users', 'user-plus', 'copy', 'calendar-clock', 'chart-column',
  'shield', 'check-circle', 'trash', 'lock', 'send', 'refresh-cw', 'plus', 'pencil', 'trending-up', 'info']);
const KINDS = ['added', 'changed', 'improved', 'fixed', 'removed'];
const NAME = require('./release-formats').notes;
const LIMIT = 256 * 1024;
const fail = () => { throw Object.assign(new Error('release_notes_invalid'), { code: 'release_notes_invalid' }); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function text(value, max, empty = false, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())
    || (multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail();
}
function plainChangelog(changelog) {
  if (!Array.isArray(changelog) || changelog.length < 1 || changelog.length > 100) fail();
  return changelog.map(({ kind, title, description }) => {
    if (!KINDS.includes(kind)) fail();
    text(title, 160); text(description, 600, true);
    return { kind, title, description };
  });
}
function presentation(value) {
  exact(value, ['groups', 'changelog', 'afterUpdating']);
  if (!Array.isArray(value.groups) || !value.groups.length || value.groups.length > 20
    || !Array.isArray(value.afterUpdating) || value.afterUpdating.length > 10) fail();
  const plain = plainChangelog(value.changelog);
  const ids = new Set();
  for (const group of value.groups) {
    exact(group, ['id', 'title', 'icon']);
    if (typeof group.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(group.id) || ids.has(group.id) || !ICONS.has(group.icon)) fail();
    ids.add(group.id); text(group.title, 80);
  }
  for (const change of value.changelog) {
    exact(change, ['kind', 'title', 'description', 'group', 'icon', 'details']);
    if (!ids.has(change.group) || !ICONS.has(change.icon)) fail();
    text(change.details, 4000, true, true);
  }
  if (value.groups.some(group => !value.changelog.some(change => change.group === group.id))) fail();
  for (const action of value.afterUpdating) {
    exact(action, ['title', 'description']); text(action.title, 160); text(action.description, 600);
  }
  // Preparation status carries the legacy copy as well as the rich notes. Keep
  // that entire receipt within the existing private-JSON reader's 256 KiB cap.
  if (Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(JSON.stringify(plain)) > LIMIT - 2048) fail();
  return value;
}
function releaseNotes(value, release) {
  exact(value, ['schemaVersion', 'releaseId', 'sourceCommit', 'groups', 'changelog', 'afterUpdating']);
  if (value.schemaVersion !== 1 || value.releaseId !== release.releaseId || value.sourceCommit !== release.sourceCommit
    || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value.releaseId) || !/^[a-f0-9]{40}$/.test(value.sourceCommit)) fail();
  const notes = presentation({ groups: value.groups, changelog: value.changelog, afterUpdating: value.afterUpdating });
  if (JSON.stringify(plainChangelog(notes.changelog)) !== JSON.stringify(plainChangelog(release.changelog))) fail();
  return value;
}
function authoring(input) {
  const { input: content, github } = githubAuthoring(input);
  return { ...authoringContent(content), ...(github ? { github } : {}) };
}
function authoringContent(input) {
  if (Array.isArray(input)) {
    for (const change of input) exact(change, ['kind', 'title', 'description']);
    return { changelog: plainChangelog(input), notes: null };
  }
  // Audience and concise popup copy are build inputs only. Strip them before
  // producing the v1 notes sidecar so existing release watchers remain compatible.
  const curated = input?.changelog?.some(change => Object.hasOwn(change, 'audience') || Object.hasOwn(change, 'popup'));
  if (!curated) {
    const notes = presentation(input);
    return { changelog: plainChangelog(notes.changelog), notes };
  }
  exact(input, ['groups', 'changelog', 'afterUpdating']);
  if (!Array.isArray(input.afterUpdating)) fail();
  const audience = value => { if (!['platform', 'dsp'].includes(value)) fail(); return value; };
  const changelog = input.changelog.map(change => {
    exact(change, ['kind', 'title', 'description', 'group', 'icon', 'details', 'audience', ...(Object.hasOwn(change, 'popup') ? ['popup'] : [])]);
    audience(change.audience);
    if (change.popup) {
      exact(change.popup, ['title', 'description']); text(change.popup.title, 160); text(change.popup.description, 600, true);
    } else if (Object.hasOwn(change, 'popup')) fail();
    const { audience: scope, popup, ...original } = change;
    return original;
  });
  const afterUpdating = input.afterUpdating.map(action => {
    exact(action, ['title', 'description', 'audience']); audience(action.audience);
    const { audience: scope, ...original } = action;
    return original;
  });
  const notes = presentation({ groups: input.groups, changelog, afterUpdating });
  const popup = {
    changelog: input.changelog.map(change => ({ kind: change.kind, title: change.popup?.title || change.title,
      description: change.popup?.description ?? change.description, audience: change.audience })),
    afterUpdating: input.afterUpdating.map(({ title, description, audience }) => ({ title, description, audience })),
  };
  return { changelog: plainChangelog(notes.changelog), notes, popup };
}
function saveReleaseNotes(localRoot, notes, release) {
  releaseNotes(notes, release);
  const directory = path.join(localRoot, 'config/release-notes');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid()
    || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(directory) !== directory) fail();
  const file = path.join(directory, `${notes.releaseId}.json`);
  const prior = privateJson(file, process.geteuid(), true);
  if (prior && JSON.stringify(prior) !== JSON.stringify(notes)) fail();
  if (!prior) atomic(file, notes);
}
function loadReleaseNotes(localRoot, releaseId, release) {
  try {
    if (!/^[a-z][a-z0-9_.-]{2,95}$/.test(releaseId)) return null;
    const notes = privateJson(path.join(localRoot, 'config/release-notes', `${releaseId}.json`), process.geteuid(), true);
    return notes ? releaseNotes(notes, { ...release, releaseId }) : null;
  } catch { return null; } // A presentation failure must not hide valid installation controls.
}
module.exports = { NAME, LIMIT, presentation, releaseNotes, authoring, markdown, loadReleaseNotes, saveReleaseNotes };
