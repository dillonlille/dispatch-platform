'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalStringify, exactKeys, fail, sha256, validateCsv, validateProviderJson,
} = require('./validation');
const { periodFromWeek } = require('./periods');

const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATION_RE = /^[A-Z0-9]{2,12}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_NAMES = Object.freeze(['cdf-negative.csv', 'manifest.json', 'provider-links.json']);

function privateDirectory(directory, { create = true } = {}) {
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved)) {
    if (!create) fail('unsafe_storage');
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  const info = fs.lstatSync(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || fs.realpathSync(resolved) !== resolved || (info.mode & 0o077) !== 0) fail('unsafe_storage');
  return resolved;
}

function privateFile(file, { create = false } = {}) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) && create) {
    const descriptor = fs.openSync(resolved, 'wx', 0o600);
    fs.closeSync(descriptor);
  }
  const info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || fs.realpathSync(resolved) !== resolved || (info.mode & 0o177) !== 0) fail('unsafe_storage');
  return resolved;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeExclusive(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function validateManifest(value) {
  if (!exactKeys(value, [
    'contractVersion', 'week', 'station', 'companyId', 'dsp', 'collectedAt', 'runId', 'attempt',
    'collectionDigest', 'source', 'providerLinks', 'manifestSha256',
  ]) || value.contractVersion !== 1 || !RUN_RE.test(value.runId)
      || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 512
      || typeof value.collectedAt !== 'string' || Number.isNaN(Date.parse(value.collectedAt))
      || !STATION_RE.test(value.station) || !SOURCE_ID_RE.test(value.companyId) || !SOURCE_ID_RE.test(value.dsp)
      || !SHA_RE.test(value.collectionDigest)
      || !SHA_RE.test(value.manifestSha256)) fail('manifest_invalid');
  periodFromWeek(value.week);
  if (!exactKeys(value.source, ['name', 'schema', 'sha256', 'bytes', 'rowCount', 'columnCount'])
      || value.source.name !== 'cdf-negative.csv' || typeof value.source.schema !== 'string'
      || !SHA_RE.test(value.source.sha256) || !Number.isInteger(value.source.bytes) || value.source.bytes < 1
      || !Number.isInteger(value.source.rowCount) || value.source.rowCount < 0
      || !Number.isInteger(value.source.columnCount) || value.source.columnCount < 1) fail('manifest_invalid');
  if (!exactKeys(value.providerLinks, ['name', 'status', 'sha256', 'bytes', 'rowCount'])
      || value.providerLinks.name !== 'provider-links.json' || !['ready', 'degraded'].includes(value.providerLinks.status)
      || !SHA_RE.test(value.providerLinks.sha256) || !Number.isInteger(value.providerLinks.bytes) || value.providerLinks.bytes < 1
      || !Number.isInteger(value.providerLinks.rowCount) || value.providerLinks.rowCount < 0
      || (value.providerLinks.status === 'degraded' && value.providerLinks.rowCount !== 0)) fail('manifest_invalid');
  const unsigned = { ...value };
  delete unsigned.manifestSha256;
  if (sha256(Buffer.from(canonicalStringify(unsigned))) !== value.manifestSha256) fail('manifest_invalid');
  const identity = {
    contractVersion: value.contractVersion,
    week: value.week,
    station: value.station,
    companyId: value.companyId,
    dsp: value.dsp,
    source: value.source,
    providerLinks: value.providerLinks,
  };
  if (sha256(Buffer.from(canonicalStringify(identity))) !== value.collectionDigest) fail('manifest_invalid');
  return value;
}

function stageCollection({ stagingRoot, runId, attempt, week, station, companyId, dsp, collectedAt, csvBytes, providerBytes, providerStatus }) {
  if (!RUN_RE.test(runId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 512
      || !STATION_RE.test(station) || !SOURCE_ID_RE.test(companyId) || !SOURCE_ID_RE.test(dsp)
      || typeof collectedAt !== 'string' || Number.isNaN(Date.parse(collectedAt))
      || !['ready', 'degraded'].includes(providerStatus)) fail('candidate_invalid');
  const source = validateCsv(csvBytes, week);
  const providerLinks = validateProviderJson(providerBytes, week);
  if (providerStatus === 'degraded' && providerLinks.rowCount !== 0) fail('candidate_invalid');
  const identity = {
    contractVersion: 1,
    week,
    station,
    companyId,
    dsp,
    source: { name: 'cdf-negative.csv', ...source },
    providerLinks: { name: 'provider-links.json', status: providerStatus, ...providerLinks },
  };
  const collectionDigest = sha256(Buffer.from(canonicalStringify(identity)));
  const unsigned = {
    contractVersion: 1,
    week,
    station,
    companyId,
    dsp,
    collectedAt,
    runId,
    attempt,
    collectionDigest,
    source: identity.source,
    providerLinks: identity.providerLinks,
  };
  const manifest = validateManifest({
    ...unsigned,
    manifestSha256: sha256(Buffer.from(canonicalStringify(unsigned))),
  });
  const root = privateDirectory(stagingRoot);
  const directory = path.join(root, `${runId}.attempt-${attempt}.${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    writeExclusive(path.join(directory, 'cdf-negative.csv'), csvBytes);
    writeExclusive(path.join(directory, 'provider-links.json'), providerBytes);
    writeExclusive(path.join(directory, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest)}\n`));
    fsyncDirectory(directory);
    return { directory, manifest };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function readPublished(directory) {
  directory = privateDirectory(directory, { create: false });
  const names = fs.readdirSync(directory).sort();
  if (names.length !== ARTIFACT_NAMES.length || names.some((name, index) => name !== ARTIFACT_NAMES[index])) fail('artifact_set_invalid');
  const csvFile = privateFile(path.join(directory, 'cdf-negative.csv'));
  const providerFile = privateFile(path.join(directory, 'provider-links.json'));
  const manifestFile = privateFile(path.join(directory, 'manifest.json'));
  let manifest;
  try { manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8'))); }
  catch (error) { if (error?.code) throw error; fail('manifest_invalid'); }
  const csvBytes = fs.readFileSync(csvFile);
  const providerBytes = fs.readFileSync(providerFile);
  const source = validateCsv(csvBytes, manifest.week);
  const providerLinks = validateProviderJson(providerBytes, manifest.week);
  if (source.sha256 !== manifest.source.sha256 || source.bytes !== manifest.source.bytes
      || source.rowCount !== manifest.source.rowCount || source.columnCount !== manifest.source.columnCount
      || source.schema !== manifest.source.schema || providerLinks.sha256 !== manifest.providerLinks.sha256
      || providerLinks.bytes !== manifest.providerLinks.bytes || providerLinks.rowCount !== manifest.providerLinks.rowCount) {
    fail('artifact_identity_mismatch');
  }
  return { manifest, source, providerLinks };
}

function cleanupStage(stage, stagingRoot) {
  const root = privateDirectory(stagingRoot, { create: false });
  const directory = path.resolve(stage.directory);
  if (path.dirname(directory) !== root || directory === root || fs.realpathSync(directory) !== directory) fail('stage_cleanup_failed');
  fs.rmSync(directory, { recursive: true, force: false });
  fsyncDirectory(root);
}

function cleanupOrphanStages(stagingRoot) {
  const root = privateDirectory(stagingRoot);
  let removed = false;
  for (const name of fs.readdirSync(root)) {
    const match = name.match(/^([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\.attempt-([1-9][0-9]*)\.([a-f0-9]{16})$/);
    const directory = path.join(root, name);
    let info;
    try { info = fs.lstatSync(directory); } catch { fail('stage_cleanup_failed'); }
    if (!match || Number(match[2]) > 512 || !info.isDirectory() || info.isSymbolicLink()
        || info.uid !== process.geteuid() || (info.mode & 0o077) !== 0
        || path.dirname(path.resolve(directory)) !== root || fs.realpathSync(directory) !== path.resolve(directory)) {
      fail('stage_cleanup_failed');
    }
    fs.rmSync(directory, { recursive: true, force: false });
    removed = true;
  }
  if (removed) fsyncDirectory(root);
  return removed;
}

module.exports = {
  RUN_RE, STATION_RE, SOURCE_ID_RE, SHA_RE, ARTIFACT_NAMES, privateDirectory, privateFile,
  fsyncDirectory, validateManifest, stageCollection, readPublished, cleanupStage, cleanupOrphanStages,
};
