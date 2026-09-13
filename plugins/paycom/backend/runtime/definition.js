'use strict';

const crypto = require('node:crypto');
const { PAYCOM_PROFILE_ID, PAYCOM_SOURCE_ID, PAYCOM_SYNC_ID, PAYCOM_COLLECTION_SCOPE, managedPaycomFirstPublicationRequest } = require('dispatch-protocol/paycom-activation');
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('dispatch-protocol/paths/runtime-paths');
const { serverInstallationManifest } = require('dispatch-protocol/contracts/src');
const { validateSpec } = require('dispatch-runtime-kit/collection-manager/src/validation');

const PAYCOM_SPEC_RELATIVE_PATH = 'plugins/paycom/backend/config/collection-manager.json';
const PAYCOM_EXECUTABLE_RELATIVE_PATH = 'plugins/paycom/backend/bin/dispatch-paycom-collector';
const MANAGED_PAYCOM_CATALOG = Object.freeze({
  pluginVersion: '0.18.8',
  specificationSha256: 'e80bb94afb06b90f80908341c9b11622f166fdeb05152fcf288fba719efbd73e',
  executableSha256: '1a7653b184ec9b986a1449f212657fb5ff254e6246625200b9715ac3b67b70ef',
  sourceTreeSha256: '0616622c895f3eb6654cf69a1894a672e9797d880208a1ed1d8fc7bd2b8e6c57',
});
const PAYCOM_FIRST_PUBLICATION_TASKS = Object.freeze({
  'paycom-period-roster': Object.freeze({ taskId: 'roster', method: 'roster.period', publication: 'roster' }),
  'paycom-period-timecards-from-roster': Object.freeze({
    taskId: 'timecards', method: 'timecards.from-published-roster', publication: 'timecards',
  }),
  'paycom-period-timecards-audit': Object.freeze({
    taskId: 'timecards-audit', method: 'timecards.audit', publication: null,
  }),
  'paycom-period-resource-links': Object.freeze({
    taskId: 'links', method: 'resource-links.period', publication: 'resourceLinks',
  }),
  'paycom-period-resource-links-audit': Object.freeze({
    taskId: 'links-audit', method: 'resource-links.audit', publication: null,
  }),
});

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function canonicalProjectRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) fail();
  let info;
  let canonical;
  try {
    info = fs.lstatSync(value);
    canonical = fs.realpathSync(value);
  } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== value) fail();
  for (let current = value; ; current = path.dirname(current)) {
    const currentInfo = fs.lstatSync(current);
    if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()
        || ![0, process.geteuid()].includes(currentInfo.uid) || (currentInfo.mode & 0o022) !== 0) fail();
    if (path.dirname(current) === current) break;
  }
  return value;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ownedSourceFile(projectRoot, relative, { executable = false } = {}) {
  const selected = path.resolve(projectRoot, relative);
  if (!selected.startsWith(`${projectRoot}${path.sep}`)) fail();
  let info;
  let canonical;
  try {
    info = fs.lstatSync(selected);
    canonical = fs.realpathSync(selected);
  } catch { fail(); }
  if (!info.isFile() || info.isSymbolicLink() || ![0, process.geteuid()].includes(info.uid)
      || info.nlink !== 1 || (info.mode & 0o022) !== 0 || executable && (info.mode & 0o111) === 0
      || canonical !== selected) fail();
  for (let current = path.dirname(selected); current !== projectRoot; current = path.dirname(current)) {
    const directory = fs.lstatSync(current);
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || ![0, process.geteuid()].includes(directory.uid) || (directory.mode & 0o022) !== 0) fail();
  }
  return selected;
}

function releaseSourceFiles(projectRoot) {
  const relatives = [
    'plugins/paycom/backend/package.json',
    'plugins/paycom/backend/dispatch-plugin.yaml',
    PAYCOM_SPEC_RELATIVE_PATH,
    PAYCOM_EXECUTABLE_RELATIVE_PATH,
    'plugins/paycom/backend/bin/dispatch-paycom-activation-evidence',
    'plugins/paycom/backend/bin/dispatch-paycom-publication-continuity',
  ];
  const visit = relative => {
    const directory = path.join(projectRoot, relative);
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { fail(); }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) relatives.push(child);
      else fail();
    }
  };
  visit('plugins/paycom/backend/src');
  return relatives.sort();
}

function releaseSourceDigest(projectRoot) {
  const hash = crypto.createHash('sha256');
  for (const relative of releaseSourceFiles(projectRoot)) {
    const file = ownedSourceFile(projectRoot, relative, {
      executable: relative === PAYCOM_EXECUTABLE_RELATIVE_PATH
        || relative === 'plugins/paycom/backend/bin/dispatch-paycom-activation-evidence'
        || relative === 'plugins/paycom/backend/bin/dispatch-paycom-publication-continuity',
    });
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readDefinition(projectRoot) {
  const file = ownedSourceFile(projectRoot, PAYCOM_SPEC_RELATIVE_PATH);
  if (fileSha256(file) !== MANAGED_PAYCOM_CATALOG.specificationSha256) fail();
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function verifyManagedPaycomSource(projectRoot = PROJECT_ROOT) {
  const root = canonicalProjectRoot(projectRoot);
  if (releaseSourceDigest(root) !== MANAGED_PAYCOM_CATALOG.sourceTreeSha256) fail();
  if (fileSha256(ownedSourceFile(root, PAYCOM_SPEC_RELATIVE_PATH)) !== MANAGED_PAYCOM_CATALOG.specificationSha256
      || fileSha256(ownedSourceFile(root, PAYCOM_EXECUTABLE_RELATIVE_PATH, { executable: true })) !== MANAGED_PAYCOM_CATALOG.executableSha256) fail();
  return root;
}

function managedPaycomDefinition(manifestValue, authorityValue, { projectRoot = PROJECT_ROOT, container = false } = {}) {
  if (typeof container !== 'boolean') fail();
  const manifest = serverInstallationManifest(manifestValue, authorityValue);
  const root = verifyManagedPaycomSource(projectRoot);
  const definition = readDefinition(root);
  const collector = definition.collectors?.find(item => item?.id === 'paycom');
  const source = definition.sources?.find(item => item?.id === PAYCOM_SOURCE_ID);
  const sync = definition.syncs?.find(item => item?.id === PAYCOM_SYNC_ID);
  if (definition.collectors?.length !== 1 || definition.sources?.length !== 1
      || !collector || !source || !sync || collector.version !== MANAGED_PAYCOM_CATALOG.pluginVersion
      || collector.command !== '${DISPATCH_PROJECT_ROOT}/plugins/paycom/backend/bin/dispatch-paycom-collector'
      || source.collector !== 'paycom' || source.authProfile !== PAYCOM_PROFILE_ID
      || sync.plan !== 'paycom-current-workforce-sync') fail();
  const executable = ownedSourceFile(root, PAYCOM_EXECUTABLE_RELATIVE_PATH, { executable: true });
  if (fileSha256(executable) !== MANAGED_PAYCOM_CATALOG.executableSha256) fail();
  collector.command = container ? `/opt/dispatch/${PAYCOM_EXECUTABLE_RELATIVE_PATH}` : executable;
  source.config.timezone = manifest.organization.timezone;
  validateSpec(definition);
  const encoded = JSON.stringify(definition);
  const digest = crypto.createHash('sha256').update(encoded).digest('hex');
  return deepFreeze({
    profileId: PAYCOM_PROFILE_ID,
    sourceId: PAYCOM_SOURCE_ID,
    syncId: PAYCOM_SYNC_ID,
    specification: definition,
    digest,
  });
}

module.exports = {
  PAYCOM_PROFILE_ID,
  PAYCOM_SOURCE_ID,
  PAYCOM_SYNC_ID,
  PAYCOM_COLLECTION_SCOPE,
  PAYCOM_SPEC_RELATIVE_PATH,
  PAYCOM_EXECUTABLE_RELATIVE_PATH,
  MANAGED_PAYCOM_CATALOG,
  PAYCOM_FIRST_PUBLICATION_TASKS,
  managedPaycomDefinition,
  managedPaycomFirstPublicationRequest,
  verifyManagedPaycomSource,
};
