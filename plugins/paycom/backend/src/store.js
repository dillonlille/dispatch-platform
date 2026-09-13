'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { validateTimecardRecord } = require('./timecard-dom');
const { isCapturedTimecardUrl, isCanonicalTimecardUrl, parsePeriodKey, periodFromEnd,
  previousPeriod, nextPeriod, ANCHOR_START } = require('./timecard-period');
const { rosterProfileSha256, rosterSummarySha256, timecardBusinessSha256 } = require('./fingerprints');
const { TIMECARD_SUMMARY, ROUTE_VERSION, validateResourceLinkCandidate } = require('./resource-links');
const { validateBusinessDelta, computeBusinessDelta } = require('./sync-delta');

const KINDS = new Set(['pay_periods', 'roster', 'timecards', 'resource_links']);
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[a-f0-9-]{36}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_STAGE_BYTES = 134_217_728;
const NO_CHANGE_HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_COMPACTION_DELETE = 100;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function canonicalRows(candidate) {
  const rows = [...candidate.rows];
  const key = candidate.kind === 'pay_periods' ? row => row.key : row => row.employeeCode.toUpperCase();
  return rows.sort((left, right) => key(left).localeCompare(key(right)));
}
function contentSha256(candidate) {
  return sha256(Buffer.from(canonicalStringify({
    kind: candidate.kind,
    target: candidate.target,
    ...(candidate.periodKey ? { periodKey: candidate.periodKey } : {}),
    metadata: candidate.metadata,
    rows: canonicalRows(candidate),
  })));
}

function privateDirectory(directory, { create = true } = {}) {
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved)) {
    if (!create) fail('unsafe_storage');
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  const info = fs.lstatSync(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || fs.realpathSync(resolved) !== resolved) fail('unsafe_storage');
  if ((info.mode & 0o077) !== 0) fail('unsafe_storage');
  return resolved;
}

function privateFile(file, { create = false } = {}) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) && create) {
    const descriptor = fs.openSync(resolved, 'wx', 0o600);
    fs.closeSync(descriptor);
  }
  const info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1 || fs.realpathSync(resolved) !== resolved) fail('unsafe_storage');
  if ((info.mode & 0o177) !== 0) fail('unsafe_storage');
  return resolved;
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const MIRROR_COUNT_KEYS = [
  'rosterAddedCount', 'rosterProfileChangedCount', 'rosterSummaryChangedCount',
  'rosterRecordChangedCount', 'timecardAddedCount', 'timecardChangedCount',
  'retainedMissingCount', 'becameUnknownCount', 'returnedFromUnknownCount', 'unknownEmployeeCount',
  'deactivatedCount', 'reactivatedCount', 'activeEmployeeCount',
];
const PERSISTENCE_COUNT_KEYS = [
  'timecardCount', 'dateRowCount', 'selectedTimecardCount', 'persistedSelectedTimecardCount',
  'selectedMismatchCount', 'punchCount', 'inDayPunchCount', 'inDayTimecardCount',
  'outLunchPunchCount', 'inLunchPunchCount', 'outDayPunchCount', 'unclassifiedPunchCount',
];
const PERSISTENCE_KEYS = [
  'verified', 'code', 'date', 'timecardPublicationId', 'publicationCollectedAt',
  ...PERSISTENCE_COUNT_KEYS,
];

function validateTimecardPersistence(value) {
  if (!exactKeys(value, PERSISTENCE_KEYS) || value.verified !== true || value.code !== 'verified'
      || typeof value.date !== 'string' || !DATE_RE.test(value.date)
      || typeof value.timecardPublicationId !== 'string' || !UUID_RE.test(value.timecardPublicationId)
      || typeof value.publicationCollectedAt !== 'string' || Number.isNaN(Date.parse(value.publicationCollectedAt))
      || PERSISTENCE_COUNT_KEYS.some(key => !Number.isInteger(value[key]) || value[key] < 0)
      || value.dateRowCount !== value.timecardCount
      || value.persistedSelectedTimecardCount + value.selectedMismatchCount !== value.selectedTimecardCount
      || value.inDayTimecardCount > value.inDayPunchCount
      || value.inDayPunchCount + value.outLunchPunchCount + value.inLunchPunchCount
        + value.outDayPunchCount + value.unclassifiedPunchCount !== value.punchCount) fail('invalid_request');
  return value;
}

function validTimezone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

function validateSyncOutcome(value) {
  const baseKeys = ['mode', 'disposition', 'publicationStatus', 'wouldPublish', 'mirror', 'publications'];
  const optionalKeys = ['businessDate', 'businessTimezone', 'delta', 'persistence'];
  const shapeValid = plain(value)
    && baseKeys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => baseKeys.includes(key) || optionalKeys.includes(key));
  const hasBusinessDate = Object.hasOwn(value, 'businessDate');
  const hasBusinessTimezone = Object.hasOwn(value, 'businessTimezone');
  if (!shapeValid || hasBusinessDate !== hasBusinessTimezone
      || (hasBusinessDate && (!DATE_RE.test(value.businessDate) || !validTimezone(value.businessTimezone)))
      || !['shadow', 'additions_edits_preview', 'additions_edits'].includes(value.mode)
      || !['no_change', 'published'].includes(value.disposition)
      || !['shadow', 'baseline_required', 'preview', 'ready'].includes(value.publicationStatus)
      || typeof value.wouldPublish !== 'boolean'
      || (value.mirror !== null && (!exactKeys(value.mirror, MIRROR_COUNT_KEYS)
        || MIRROR_COUNT_KEYS.some(key => !Number.isInteger(value.mirror[key]) || value.mirror[key] < 0)))
      || (value.publications !== null && (!exactKeys(value.publications, [
        'rosterPublicationId', 'timecardPublicationId', 'resourceLinkPublicationId',
      ]) || Object.values(value.publications).some(id => typeof id !== 'string' || !UUID_RE.test(id))))) {
    fail('invalid_request');
  }
  if (Object.hasOwn(value, 'delta')) validateBusinessDelta(value.delta);
  if (Object.hasOwn(value, 'persistence')) validateTimecardPersistence(value.persistence);
  if ((value.mode === 'shadow' && (value.publicationStatus !== 'shadow' || value.wouldPublish
        || value.mirror !== null || value.publications !== null))
      || (value.publicationStatus === 'baseline_required' && (!['additions_edits_preview', 'additions_edits'].includes(value.mode)
        || value.disposition !== 'no_change' || value.wouldPublish || value.mirror !== null || value.publications !== null))
      || (value.publicationStatus === 'preview' && (value.mode !== 'additions_edits_preview'
        || value.disposition !== 'no_change' || value.mirror === null || value.publications !== null))
      || (Object.hasOwn(value, 'persistence')
        && (value.mode !== 'additions_edits' || value.publicationStatus !== 'ready'))
      || (Object.hasOwn(value, 'delta')
        && (!hasBusinessDate || value.mode !== 'additions_edits' || value.publicationStatus !== 'ready'))
      || (value.disposition === 'published' && (value.mode !== 'additions_edits' || !value.wouldPublish
        || value.publicationStatus !== 'ready' || value.mirror === null || value.publications === null))) {
    fail('invalid_request');
  }
  return value;
}

function isoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('candidate_invalid');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail('candidate_invalid');
  return date;
}

function validatePeriods(candidate) {
  if (!Array.isArray(candidate.rows) || candidate.rows.length < 1 || candidate.rows.length > 64) fail('candidate_invalid');
  const seen = new Set();
  for (const row of candidate.rows) {
    if (!exactKeys(row, ['start', 'end', 'key', 'relation']) || !['previous', 'current', 'next'].includes(row.relation)) fail('candidate_invalid');
    const period = parsePeriodKey(row.key);
    if (period.start !== row.start || period.end !== row.end || seen.has(row.key)) fail('candidate_invalid');
    seen.add(row.key);
  }
  if (candidate.rows.filter(row => row.relation === 'current').length !== 1) fail('candidate_invalid');
}

function validateRoster(candidate) {
  if (!Array.isArray(candidate.rows) || candidate.rows.length < 1 || candidate.rows.length > 5000) fail('candidate_invalid');
  const seen = new Set();
  for (const row of candidate.rows) {
    if (!plain(row) || typeof row.employeeCode !== 'string' || !/^[A-Za-z0-9]{4}$/.test(row.employeeCode)
        || typeof row.employeeName !== 'string' || !row.employeeName.trim() || row.employeeName.length > 300
        || typeof row.isActive !== 'boolean' || typeof row.isActiveDriver !== 'boolean'
        || (row.lifecycleStatus !== undefined && !['active', 'inactive', 'unknown'].includes(row.lifecycleStatus))
        || seen.has(row.employeeCode.toUpperCase())) fail('candidate_invalid');
    seen.add(row.employeeCode.toUpperCase());
  }
}

function validateTimecards(candidate) {
  const period = parsePeriodKey(candidate.periodKey);
  if (candidate.metadata.periodStart !== period.start || candidate.metadata.periodEnd !== period.end) fail('candidate_invalid');
  if (candidate.target !== period.end || !Array.isArray(candidate.rows) || candidate.rows.length < 1 || candidate.rows.length > 5000) fail('candidate_invalid');
  const seen = new Set();
  for (const row of candidate.rows) {
    const legacy = exactKeys(row, ['employeeCode', 'employeeName', 'record', 'sourceSha256']);
    const semantic = exactKeys(row, ['employeeCode', 'employeeName', 'record', 'sourceSha256', 'businessSha256', 'observedAt']);
    if ((!legacy && !semantic)
        || typeof row.employeeCode !== 'string' || !/^[A-Z0-9]{4}$/.test(row.employeeCode)
        || typeof row.employeeName !== 'string' || !row.employeeName.trim() || row.employeeName.length > 300
        || !/^[a-f0-9]{64}$/.test(row.sourceSha256) || seen.has(row.employeeCode.toUpperCase())) fail('candidate_invalid');
    const sourceUrlValid = legacy
      ? isCapturedTimecardUrl(row.record?.sourceUrl, { employeeCode: row.employeeCode, period })
      : isCanonicalTimecardUrl(row.record?.sourceUrl, { employeeCode: row.employeeCode, period });
    if (!sourceUrlValid) fail('candidate_invalid');
    if (semantic && (!/^[a-f0-9]{64}$/.test(row.businessSha256)
        || row.businessSha256 !== timecardBusinessSha256(row.record)
        || typeof row.observedAt !== 'string' || Number.isNaN(Date.parse(row.observedAt)))) fail('candidate_invalid');
    validateTimecardRecord(row.record, { employeeCode: row.employeeCode, period, sourceUrl: row.record?.sourceUrl });
    seen.add(row.employeeCode.toUpperCase());
  }
}

function validateCandidate(candidate) {
  if (!plain(candidate) || !KINDS.has(candidate.kind) || !RUN_RE.test(candidate.runId)
      || !Number.isInteger(candidate.attempt) || candidate.attempt < 1 || candidate.attempt > 10
      || typeof candidate.collectedAt !== 'string' || Number.isNaN(Date.parse(candidate.collectedAt))
      || !plain(candidate.metadata) || !Array.isArray(candidate.rows)) fail('candidate_invalid');
  const targetDate = isoDate(candidate.target);
  if (['roster', 'resource_links'].includes(candidate.kind) && targetDate.getUTCDay() !== 6) fail('candidate_invalid');
  if (candidate.kind === 'pay_periods') validatePeriods(candidate);
  else if (candidate.kind === 'roster') validateRoster(candidate);
  else if (candidate.kind === 'timecards') {
    if (typeof candidate.periodKey !== 'string') fail('candidate_invalid');
    validateTimecards(candidate);
  } else {
    if (typeof candidate.periodKey !== 'string') fail('candidate_invalid');
    try { validateResourceLinkCandidate(candidate); } catch { fail('candidate_invalid'); }
  }
  return candidate;
}

function validateWorkforcePreviewMembership(rosterRows, timecardRows, resourceLinkRows) {
  const expected = new Map(rosterRows.filter(row => row.isActive === true)
    .map(row => [row.employeeCode.toUpperCase(), row.employeeName]));
  const timecards = new Map(timecardRows.map(row => [row.employeeCode, row.employeeName]));
  const links = new Set(resourceLinkRows.map(row => row.employeeCode));
  if (expected.size < 1 || expected.size !== timecards.size || expected.size !== links.size
      || [...expected].some(([code, name]) => timecards.get(code) !== name || !links.has(code))) {
    fail('membership_mismatch');
  }
}

function stageCandidate(stagingRoot, candidate) {
  validateCandidate(candidate);
  const bytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
  if (bytes.length > MAX_STAGE_BYTES) fail('candidate_too_large');
  const root = privateDirectory(stagingRoot);
  if (!RUN_RE.test(candidate.runId)) fail('candidate_invalid');
  const directory = path.join(root, `${candidate.runId}.attempt-${candidate.attempt}`);
  if (fs.existsSync(directory)) cleanupStage({ directory }, root);
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    const temporary = path.join(directory, '.candidate.tmp');
    const destination = path.join(directory, 'candidate.json');
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, destination);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return { directory, file: destination, bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    // A failed write never reaches the caller's publication finally block.
    cleanupStage({ directory }, root);
    throw error;
  }
}

function readStaged(stage) {
  privateDirectory(stage.directory, { create: false });
  privateFile(stage.file);
  const bytes = fs.readFileSync(stage.file);
  if (bytes.length > MAX_STAGE_BYTES || sha256(bytes) !== stage.sha256 || !bytes.toString('utf8').endsWith('\n')) fail('candidate_invalid');
  let candidate;
  try { candidate = JSON.parse(bytes.subarray(0, bytes.length - 1).toString('utf8')); } catch { fail('candidate_invalid'); }
  return validateCandidate(candidate);
}

function cleanupStage(stage, stagingRoot) {
  const root = privateDirectory(stagingRoot, { create: false });
  const directory = path.resolve(stage.directory);
  if (path.dirname(directory) !== root || directory === root) fail('stage_cleanup_failed');
  try {
    privateDirectory(directory, { create: false });
    fs.rmSync(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
    const rootFd = fs.openSync(root, 'r');
    try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
    try { fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  } catch { fail('stage_cleanup_failed'); }
  fail('stage_cleanup_failed');
}

function cleanupRunStages(stagingRoot, runId) {
  if (!RUN_RE.test(runId)) fail('invalid_request');
  try { fs.lstatSync(stagingRoot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const root = privateDirectory(stagingRoot, { create: false });
  const prefix = `${runId}.attempt-`;
  // Collection Manager serializes attempts of a run. Remove only that run's
  // staging, including an interrupted earlier attempt or a committed replay.
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(prefix) && /^(?:[1-9]|10)$/.test(name.slice(prefix.length))) {
      cleanupStage({ directory: path.join(root, name) }, root);
    }
  }
}

function ensurePaycomSchema(db, { readOnly = false } = {}) {
  let version = db.prepare('SELECT version FROM schema_meta').get()?.version;
  if (version === 5) return;
  if (readOnly || ![1, 2, 3, 4].includes(version)) fail('schema_invalid');
  if (version === 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS resource_link_publications(
          id TEXT PRIMARY KEY,
          resource_type TEXT NOT NULL CHECK(resource_type='paycom.timecard.summary'),
          target TEXT NOT NULL,
          period_key TEXT NOT NULL,
          run_id TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          roster_publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
          roster_content_sha256 TEXT NOT NULL,
          route_version INTEGER NOT NULL CHECK(route_version=1),
          content_sha256 TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          UNIQUE(resource_type,target,content_sha256)
        );
        CREATE TABLE IF NOT EXISTS resource_links(
          publication_id TEXT NOT NULL REFERENCES resource_link_publications(id) ON DELETE CASCADE,
          employee_code TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          PRIMARY KEY(publication_id,employee_code)
        );
        CREATE TABLE IF NOT EXISTS active_resource_link_publications(
          resource_type TEXT NOT NULL,
          target TEXT NOT NULL,
          publication_id TEXT NOT NULL UNIQUE REFERENCES resource_link_publications(id) ON DELETE CASCADE,
          activated_at TEXT NOT NULL,
          PRIMARY KEY(resource_type,target)
        );
        CREATE INDEX IF NOT EXISTS resource_link_publications_by_type_target
          ON resource_link_publications(resource_type,target,collected_at DESC);
        DROP TABLE schema_meta;
        CREATE TABLE schema_meta(version INTEGER NOT NULL CHECK(version=2));
        INSERT INTO schema_meta(version) VALUES(2);
      `);
      db.exec('COMMIT');
      version = 2;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  if (version === 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        ALTER TABLE timecards ADD COLUMN business_sha256 TEXT;
        ALTER TABLE timecards ADD COLUMN observed_at TEXT;
        CREATE TABLE paycom_sync_state(
          source_id TEXT NOT NULL,
          target TEXT NOT NULL,
          last_run_id TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          employee_count INTEGER NOT NULL,
          pending_removal_sha256 TEXT,
          pending_removal_count INTEGER NOT NULL DEFAULT 0,
          last_receipt_json TEXT NOT NULL,
          PRIMARY KEY(source_id,target)
        );
        CREATE TABLE paycom_sync_employees(
          source_id TEXT NOT NULL,
          target TEXT NOT NULL,
          employee_code TEXT NOT NULL,
          profile_sha256 TEXT NOT NULL,
          summary_sha256 TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          missing_observations INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(source_id,target,employee_code)
        );
        CREATE INDEX paycom_sync_employees_by_target
          ON paycom_sync_employees(source_id,target,last_observed_at);
        DROP TABLE schema_meta;
        CREATE TABLE schema_meta(version INTEGER NOT NULL CHECK(version=3));
        INSERT INTO schema_meta(version) VALUES(3);
      `);
      db.exec('COMMIT');
      version = 3;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  if (version === 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        ALTER TABLE paycom_sync_state ADD COLUMN last_full_reconciled_at TEXT;
        ALTER TABLE paycom_sync_state ADD COLUMN full_reconcile_anchor_at TEXT;
        UPDATE paycom_sync_state SET full_reconcile_anchor_at=checked_at WHERE full_reconcile_anchor_at IS NULL;
        ALTER TABLE paycom_sync_employees ADD COLUMN timecard_business_sha256 TEXT;
        ALTER TABLE paycom_sync_employees ADD COLUMN last_timecard_observed_at TEXT;
        ALTER TABLE paycom_sync_employees ADD COLUMN last_full_verified_at TEXT;
        DROP TABLE schema_meta;
        CREATE TABLE schema_meta(version INTEGER NOT NULL CHECK(version=4));
        INSERT INTO schema_meta(version) VALUES(4);
      `);
      db.exec('COMMIT');
      version = 4;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  if (version === 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE paycom_sync_change_history(
          run_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          target TEXT NOT NULL,
          business_date TEXT NOT NULL,
          business_timezone TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK(disposition IN('published','no_change')),
          delta_json TEXT NOT NULL,
          persistence_json TEXT NOT NULL
        );
        CREATE INDEX paycom_sync_change_history_by_source_target
          ON paycom_sync_change_history(source_id,target,observed_at DESC,run_id DESC);
        DROP TABLE schema_meta;
        CREATE TABLE schema_meta(version INTEGER NOT NULL CHECK(version=5));
        INSERT INTO schema_meta(version) VALUES(5);
      `);
      db.exec('COMMIT');
      version = 5;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}

class PaycomStore {
  constructor(file, { readOnly = false } = {}) {
    this.file = path.resolve(file);
    privateDirectory(path.dirname(this.file), { create: !readOnly });
    if (!fs.existsSync(this.file) && readOnly) fail('not_initialized');
    if (!fs.existsSync(this.file)) privateFile(this.file, { create: true });
    else privateFile(this.file);
    this.db = new DatabaseSync(this.file, { readOnly });
    if (readOnly) {
      this.db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      ensurePaycomSchema(this.db, { readOnly: true });
    } else {
      this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL CHECK(version=1));
      INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
      CREATE TABLE IF NOT EXISTS publications(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('pay_periods','roster','timecards')),
        target TEXT NOT NULL, run_id TEXT NOT NULL, collected_at TEXT NOT NULL,
        content_sha256 TEXT NOT NULL, row_count INTEGER NOT NULL, metadata_json TEXT NOT NULL,
        UNIQUE(kind,target,content_sha256)
      );
      CREATE TABLE IF NOT EXISTS active_publications(
        kind TEXT NOT NULL, target TEXT NOT NULL, publication_id TEXT NOT NULL UNIQUE REFERENCES publications(id),
        activated_at TEXT NOT NULL, PRIMARY KEY(kind,target)
      );
      CREATE TABLE IF NOT EXISTS publication_fences(
        run_id TEXT PRIMARY KEY, max_attempt INTEGER NOT NULL CHECK(max_attempt >= 1)
      );
      CREATE TABLE IF NOT EXISTS pay_periods(
        publication_id TEXT NOT NULL REFERENCES publications(id), period_start TEXT NOT NULL,
        period_end TEXT NOT NULL, period_key TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY(publication_id,period_key)
      );
      CREATE TABLE IF NOT EXISTS roster_employees(
        publication_id TEXT NOT NULL REFERENCES publications(id), employee_code TEXT NOT NULL,
        employee_name TEXT NOT NULL, is_active INTEGER NOT NULL, is_active_driver INTEGER NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(publication_id,employee_code)
      );
      CREATE TABLE IF NOT EXISTS timecards(
        publication_id TEXT NOT NULL REFERENCES publications(id), employee_code TEXT NOT NULL,
        employee_name TEXT NOT NULL, period_total_hours REAL NOT NULL, missing_days INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(publication_id,employee_code)
      );
      CREATE INDEX IF NOT EXISTS publications_by_kind_target ON publications(kind,target,collected_at DESC);
      `);
      ensurePaycomSchema(this.db);
    }
    privateFile(this.file);
  }

  validateBoundTimecardMembership(candidate) {
    if (candidate.kind !== 'timecards' || candidate.metadata.mode === 'historical_period_membership') return null;
    if (!['full', 'incremental', 'published_roster', 'sync_merge'].includes(candidate.metadata.mode)) fail('membership_mismatch');
    const roster = this.active('roster', candidate.target);
    if (!roster || candidate.metadata.rosterPublicationId !== roster.id
        || candidate.metadata.rosterContentSha256 !== roster.content_sha256) fail('membership_mismatch');
    const expected = this.db.prepare(`SELECT employee_code employeeCode,employee_name employeeName
      FROM roster_employees WHERE publication_id=? AND is_active=1 ORDER BY employee_code`).all(roster.id);
    const actual = [...candidate.rows].sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
    if (expected.length !== actual.length || expected.some((row, index) => row.employeeCode !== actual[index].employeeCode
        || row.employeeName !== actual[index].employeeName)) fail('membership_mismatch');
    return { rosterPublicationId: roster.id, activeEmployees: expected.length, timecards: actual.length };
  }

  validateResourceLinkMembership(candidate) {
    const roster = this.active('roster', candidate.target);
    if (!roster || candidate.metadata.rosterPublicationId !== roster.id
        || candidate.metadata.rosterContentSha256 !== roster.content_sha256) fail('membership_mismatch');
    const expected = this.db.prepare(`SELECT employee_code employeeCode FROM roster_employees
      WHERE publication_id=? AND is_active=1 ORDER BY employee_code`).all(roster.id);
    const actual = [...candidate.rows].sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
    if (expected.length !== actual.length
        || expected.some((row, index) => row.employeeCode !== actual[index].employeeCode)) fail('membership_mismatch');
    return { rosterPublicationId: roster.id, activeEmployees: expected.length, links: actual.length };
  }

  auditResourceLinkPublication(publicationId, { databaseChecks = true } = {}) {
    const publication = this.db.prepare('SELECT * FROM resource_link_publications WHERE id=?').get(publicationId);
    if (!publication) return { verified: false, code: 'not_loaded', publicationId };
    const metadata = {
      resourceType: publication.resource_type,
      periodStart: publication.period_key.slice(0, 10),
      periodEnd: publication.period_key.slice(11),
      rosterPublicationId: publication.roster_publication_id,
      rosterContentSha256: publication.roster_content_sha256,
      routeVersion: publication.route_version,
    };
    const rows = this.db.prepare(`SELECT employee_code employeeCode,canonical_url canonicalUrl
      FROM resource_links WHERE publication_id=? ORDER BY employee_code`).all(publication.id)
      .map(row => ({ employeeCode: row.employeeCode, canonicalUrl: row.canonicalUrl }));
    const candidate = {
      kind: 'resource_links', target: publication.target, periodKey: publication.period_key,
      runId: publication.run_id, attempt: 1, collectedAt: publication.collected_at, metadata, rows,
    };
    let projectionValid = true;
    try { validateResourceLinkCandidate(candidate); } catch { projectionValid = false; }
    const calculatedContentSha256 = projectionValid ? contentSha256(candidate) : null;
    const roster = this.db.prepare(`SELECT p.id,p.content_sha256 FROM active_publications a
      JOIN publications p ON p.id=a.publication_id WHERE a.kind='roster' AND a.target=?`).get(publication.target);
    const rosterValid = roster?.id === publication.roster_publication_id
      && roster?.content_sha256 === publication.roster_content_sha256;
    const quick = databaseChecks ? this.db.prepare('PRAGMA quick_check').get()?.quick_check : 'ok';
    const foreignKeyErrors = databaseChecks ? this.db.prepare('PRAGMA foreign_key_check').all().length : 0;
    const verified = quick === 'ok' && foreignKeyErrors === 0 && projectionValid && rosterValid
      && rows.length === publication.row_count && calculatedContentSha256 === publication.content_sha256;
    return {
      verified, code: verified ? 'verified' : 'integrity_failed',
      kind: 'resource_links', resourceType: publication.resource_type, target: publication.target,
      publicationId: publication.id, rosterPublicationId: publication.roster_publication_id,
      rowCount: rows.length, contentSha256: publication.content_sha256, calculatedContentSha256,
      collectedAt: publication.collected_at, quickCheck: quick, foreignKeyErrors, projectionValid, rosterValid,
    };
  }

  publishResourceLinks(candidate, contentHash, { transaction = true } = {}) {
    if (typeof transaction !== 'boolean') fail('invalid_request');
    let existing;
    let wasActive = false;
    let publicationId;
    let membership;
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const fence = this.db.prepare('SELECT max_attempt FROM publication_fences WHERE run_id=?').get(candidate.runId);
      if (fence && candidate.attempt < fence.max_attempt) fail('stale_collection_attempt');
      this.db.prepare(`INSERT INTO publication_fences(run_id,max_attempt) VALUES(?,?)
        ON CONFLICT(run_id) DO UPDATE SET max_attempt=MAX(max_attempt,excluded.max_attempt)`).run(candidate.runId, candidate.attempt);
      membership = this.validateResourceLinkMembership(candidate);
      existing = this.db.prepare(`SELECT id FROM resource_link_publications
        WHERE resource_type=? AND target=? AND content_sha256=?`)
        .get(candidate.metadata.resourceType, candidate.target, contentHash);
      const active = this.db.prepare(`SELECT publication_id FROM active_resource_link_publications
        WHERE resource_type=? AND target=?`).get(candidate.metadata.resourceType, candidate.target);
      wasActive = Boolean(existing && active?.publication_id === existing.id);
      publicationId = existing?.id || crypto.randomUUID();
      if (!existing) {
        this.db.prepare('INSERT INTO resource_link_publications VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          publicationId, candidate.metadata.resourceType, candidate.target, candidate.periodKey,
          candidate.runId, candidate.collectedAt, candidate.metadata.rosterPublicationId,
          candidate.metadata.rosterContentSha256, candidate.metadata.routeVersion, contentHash, candidate.rows.length,
        );
        const insert = this.db.prepare('INSERT INTO resource_links VALUES(?,?,?)');
        for (const row of candidate.rows) insert.run(publicationId, row.employeeCode, row.canonicalUrl);
      }
      const verified = this.auditResourceLinkPublication(publicationId, { databaseChecks: false });
      if (!verified.verified || verified.rowCount !== candidate.rows.length
          || verified.contentSha256 !== contentHash) fail('publication_verification_failed');
      this.db.prepare(`INSERT INTO active_resource_link_publications(resource_type,target,publication_id,activated_at)
        VALUES(?,?,?,?) ON CONFLICT(resource_type,target) DO UPDATE SET
        publication_id=excluded.publication_id,activated_at=excluded.activated_at`)
        .run(candidate.metadata.resourceType, candidate.target, publicationId, candidate.collectedAt);
      const rollback = this.db.prepare(`SELECT id FROM resource_link_publications
        WHERE resource_type=? AND target=? AND id<>? ORDER BY collected_at DESC,id DESC`)
        .all(candidate.metadata.resourceType, candidate.target, publicationId);
      const remove = this.db.prepare('DELETE FROM resource_link_publications WHERE id=?');
      for (const row of rollback.slice(1)) remove.run(row.id);
      if (transaction) this.db.exec('COMMIT');
    } catch (error) {
      if (transaction) try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return {
      disposition: wasActive ? 'no_change' : existing ? 'reactivated' : 'published',
      publicationId, rowCount: candidate.rows.length, contentSha256: contentHash, membership,
    };
  }

  publish(stage, { transaction = true } = {}) {
    if (typeof transaction !== 'boolean') fail('invalid_request');
    const candidate = readStaged(stage);
    const contentHash = contentSha256(candidate);
    if (candidate.kind === 'resource_links') return this.publishResourceLinks(candidate, contentHash, { transaction });
    let existing;
    let wasActive = false;
    let publicationId;
    let membership = null;
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const fence = this.db.prepare('SELECT max_attempt FROM publication_fences WHERE run_id=?').get(candidate.runId);
      if (fence && candidate.attempt < fence.max_attempt) fail('stale_collection_attempt');
      this.db.prepare(`INSERT INTO publication_fences(run_id,max_attempt) VALUES(?,?)
        ON CONFLICT(run_id) DO UPDATE SET max_attempt=MAX(max_attempt,excluded.max_attempt)`).run(candidate.runId, candidate.attempt);
      membership = this.validateBoundTimecardMembership(candidate);
      existing = this.db.prepare('SELECT id FROM publications WHERE kind=? AND target=? AND content_sha256=?')
        .get(candidate.kind, candidate.target, contentHash);
      const active = this.db.prepare('SELECT publication_id FROM active_publications WHERE kind=? AND target=?')
        .get(candidate.kind, candidate.target);
      wasActive = Boolean(existing && active?.publication_id === existing.id);
      publicationId = existing?.id || crypto.randomUUID();
      if (!existing) {
        this.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?,?)').run(
          publicationId, candidate.kind, candidate.target, candidate.runId, candidate.collectedAt,
          contentHash, candidate.rows.length, JSON.stringify(candidate.metadata),
        );
        if (candidate.kind === 'pay_periods') {
          const insert = this.db.prepare('INSERT INTO pay_periods VALUES(?,?,?,?,?)');
          for (const row of candidate.rows) insert.run(publicationId, row.start, row.end, row.key, row.relation);
        } else if (candidate.kind === 'roster') {
          const insert = this.db.prepare('INSERT INTO roster_employees VALUES(?,?,?,?,?,?)');
          for (const row of candidate.rows) insert.run(publicationId, row.employeeCode, row.employeeName, Number(row.isActive), Number(row.isActiveDriver), JSON.stringify(row));
        } else {
          const insert = this.db.prepare(`INSERT INTO timecards(
            publication_id,employee_code,employee_name,period_total_hours,missing_days,
            source_sha256,record_json,business_sha256,observed_at
          ) VALUES(?,?,?,?,?,?,?,?,?)`);
          for (const row of candidate.rows) insert.run(
            publicationId, row.employeeCode, row.employeeName, row.record.periodTotalHours,
            row.record.days.filter(day => day.missingPunch).length, row.sourceSha256, JSON.stringify(row.record),
            row.businessSha256 || null, row.observedAt || null,
          );
        }
      }
      const verified = this.auditPublication(publicationId, { databaseChecks: false });
      if (!verified.verified || verified.rowCount !== candidate.rows.length || verified.contentSha256 !== contentHash) fail('publication_verification_failed');
      this.db.prepare(`INSERT INTO active_publications(kind,target,publication_id,activated_at) VALUES(?,?,?,?)
        ON CONFLICT(kind,target) DO UPDATE SET publication_id=excluded.publication_id,activated_at=excluded.activated_at`)
        .run(candidate.kind, candidate.target, publicationId, candidate.collectedAt);
      if (candidate.kind === 'roster') {
        this.db.prepare(`DELETE FROM active_resource_link_publications WHERE target=? AND publication_id IN(
          SELECT id FROM resource_link_publications WHERE roster_publication_id<>?
        )`).run(candidate.target, publicationId);
      }
      const rollback = this.db.prepare('SELECT id FROM publications WHERE kind=? AND target=? AND id<>? ORDER BY collected_at DESC,id DESC').all(candidate.kind, candidate.target, publicationId);
      const childTable = candidate.kind === 'pay_periods' ? 'pay_periods' : candidate.kind === 'roster' ? 'roster_employees' : 'timecards';
      const removeRows = this.db.prepare(`DELETE FROM ${childTable} WHERE publication_id=?`);
      const removePublication = this.db.prepare('DELETE FROM publications WHERE id=?');
      for (const row of rollback.slice(1)) {
        removeRows.run(row.id);
        removePublication.run(row.id);
      }
      if (transaction) this.db.exec('COMMIT');
    } catch (error) {
      if (transaction) try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return {
      disposition: wasActive ? 'no_change' : existing ? 'reactivated' : 'published',
      publicationId, rowCount: candidate.rows.length, contentSha256: contentHash,
      ...(membership ? { membership } : {}),
    };
  }

  publishWorkforceSync({
    runId, attempt, collectedAt, coverageDate, businessTimezone, period, sourceSha256, sourceFormat,
    sourceEmployees, mirrorPlan, observation, stagingRoot, base, preview = false,
  }) {
    const businessDate = coverageDate === undefined
      ? (typeof collectedAt === 'string' ? collectedAt.slice(0, 10) : '')
      : coverageDate;
    const persistenceDate = businessDate;
    const baseKeys = [
      'rosterPublicationId', 'rosterContentSha256', 'timecardPublicationId',
      'timecardContentSha256', 'resourceLinkPublicationId', 'resourceLinkContentSha256',
    ];
    const bootstrap = base === null;
    const baseValid = bootstrap || exactKeys(base, baseKeys)
      && UUID_RE.test(base.rosterPublicationId) && SHA256_RE.test(base.rosterContentSha256)
      && UUID_RE.test(base.timecardPublicationId) && SHA256_RE.test(base.timecardContentSha256)
      && ((base.resourceLinkPublicationId === null && base.resourceLinkContentSha256 === null)
        || (UUID_RE.test(base.resourceLinkPublicationId) && SHA256_RE.test(base.resourceLinkContentSha256)));
    if (!RUN_RE.test(runId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 10
        || typeof collectedAt !== 'string' || Number.isNaN(Date.parse(collectedAt))
        || typeof persistenceDate !== 'string' || !DATE_RE.test(persistenceDate)
        || !validTimezone(businessTimezone)
        || !period || typeof period.start !== 'string' || typeof period.end !== 'string' || typeof period.key !== 'string'
        || persistenceDate < period.start || persistenceDate > period.end
        || !SHA256_RE.test(sourceSha256) || typeof sourceFormat !== 'string'
        || !Array.isArray(sourceEmployees) || !mirrorPlan || typeof mirrorPlan.hasChanges !== 'boolean'
        || !Array.isArray(mirrorPlan.rosterRows) || !Array.isArray(mirrorPlan.timecardRows)
        || !Array.isArray(mirrorPlan.resourceLinkRows) || !plain(mirrorPlan.counts)
        || !plain(observation) || observation.runId !== runId || observation.target !== period.end
        || observation.observedAt !== collectedAt || observation.sourceSha256 !== sourceSha256
        || canonicalStringify(observation.employees) !== canonicalStringify(sourceEmployees)
        || typeof stagingRoot !== 'string' || !baseValid || typeof preview !== 'boolean') fail('candidate_invalid');
    const replay = this.shadowReceiptForRun(observation.sourceId, observation.target, runId);
    if (replay?.syncOutcome) {
      const outcome = validateSyncOutcome(replay.syncOutcome);
      return {
        disposition: outcome.disposition,
        wouldPublish: outcome.wouldPublish,
        businessDate: outcome.businessDate || businessDate,
        businessTimezone: outcome.businessTimezone || businessTimezone,
        counts: outcome.mirror,
        observation: replay,
        ...(outcome.delta ? { delta: outcome.delta } : {}),
        ...(outcome.persistence ? { persistence: outcome.persistence } : {}),
        ...(outcome.publications || {}),
      };
    }
    const publishCandidate = candidate => {
      const stage = stageCandidate(stagingRoot, candidate);
      try { return this.publish(stage, { transaction: false }); }
      finally { cleanupStage(stage, stagingRoot); }
    };
    const previewCandidate = candidate => {
      const stage = stageCandidate(stagingRoot, candidate);
      try {
        const validated = readStaged(stage);
        return { candidate: validated, contentSha256: contentSha256(validated) };
      } finally { cleanupStage(stage, stagingRoot); }
    };
    let rosterResult = null;
    let timecardResult = null;
    let linkResult = null;
    let observationResult;
    let outcome;
    let delta = null;
    let persistence = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentRoster = this.active('roster', period.end);
      const currentTimecards = this.active('timecards', period.end);
      const priorTimecardRows = this.activeTimecards(period.end)?.rows || [];
      const currentLinks = this.activeResourceLinks(TIMECARD_SUMMARY, period.end)?.publication || null;
      if (bootstrap ? Boolean(currentRoster || currentTimecards || currentLinks)
          : !currentRoster || currentRoster.id !== base.rosterPublicationId
          || currentRoster.content_sha256 !== base.rosterContentSha256
          || !currentTimecards || currentTimecards.id !== base.timecardPublicationId
          || currentTimecards.content_sha256 !== base.timecardContentSha256
          || (currentLinks?.id || null) !== base.resourceLinkPublicationId
          || (currentLinks?.content_sha256 || null) !== base.resourceLinkContentSha256) {
        fail('publication_base_changed');
      }
      if (bootstrap && (observation.sourceCompleteness !== 'authoritative' || !mirrorPlan.hasChanges)) {
        fail('roster_source_not_authoritative');
      }
      if (bootstrap && !preview) publishCandidate({
        kind: 'pay_periods', target: businessDate, runId, attempt, collectedAt,
        metadata: { timezone: businessTimezone, basis: 'biweekly_anchor', anchorStart: ANCHOR_START },
        rows: [
          { ...previousPeriod(period), relation: 'previous' },
          { ...period, relation: 'current' },
          { ...nextPeriod(period), relation: 'next' },
        ].map(({ start, end, key, relation }) => ({ start, end, key, relation })),
      });
      const fence = this.db.prepare('SELECT max_attempt FROM publication_fences WHERE run_id=?').get(runId);
      if (fence && attempt < fence.max_attempt) fail('stale_collection_attempt');
      this.db.prepare(`INSERT INTO publication_fences(run_id,max_attempt) VALUES(?,?)
        ON CONFLICT(run_id) DO UPDATE SET max_attempt=MAX(max_attempt,excluded.max_attempt)`).run(runId, attempt);
      if (mirrorPlan.hasChanges || preview) {
        const rosterCandidate = {
          kind: 'roster', target: period.end, runId, attempt, collectedAt,
          metadata: {
            periodKey: period.key,
            sourceSha256,
            sourceFormat,
            employeeCount: sourceEmployees.length,
            activeEmployeeCount: sourceEmployees.filter(row => row.isActive).length,
            activeDriverCount: sourceEmployees.filter(row => row.isActiveDriver).length,
            mode: 'sync_merge',
            absencePolicy: 'retain',
            retainedMissingCount: mirrorPlan.counts.retainedMissingCount,
          },
          rows: mirrorPlan.rosterRows,
        };
        if (preview) {
          const inspected = previewCandidate(rosterCandidate);
          rosterResult = { publicationId: crypto.randomUUID(), contentSha256: inspected.contentSha256 };
        } else rosterResult = publishCandidate(rosterCandidate);
        const timecardCandidate = {
          kind: 'timecards', target: period.end, periodKey: period.key, runId, attempt, collectedAt,
          metadata: {
            periodStart: period.start,
            periodEnd: period.end,
            rosterPublicationId: rosterResult.publicationId,
            rosterContentSha256: rosterResult.contentSha256,
            mode: 'sync_merge',
          },
          rows: mirrorPlan.timecardRows,
        };
        const linkCandidate = {
          kind: 'resource_links', target: period.end, periodKey: period.key, runId, attempt, collectedAt,
          metadata: {
            resourceType: TIMECARD_SUMMARY,
            periodStart: period.start,
            periodEnd: period.end,
            rosterPublicationId: rosterResult.publicationId,
            rosterContentSha256: rosterResult.contentSha256,
            routeVersion: ROUTE_VERSION,
          },
          rows: mirrorPlan.resourceLinkRows,
        };
        if (preview) {
          previewCandidate(timecardCandidate);
          previewCandidate(linkCandidate);
          validateWorkforcePreviewMembership(
            rosterCandidate.rows, timecardCandidate.rows, linkCandidate.rows,
          );
        } else {
          timecardResult = publishCandidate(timecardCandidate);
          linkResult = publishCandidate(linkCandidate);
        }
      }
      const publications = !preview && rosterResult ? {
        rosterPublicationId: rosterResult.publicationId,
        timecardPublicationId: timecardResult.publicationId,
        resourceLinkPublicationId: linkResult.publicationId,
      } : null;
      if (!preview) {
        delta = computeBusinessDelta(priorTimecardRows, mirrorPlan.timecardRows, mirrorPlan.counts);
        persistence = this.auditTimecardPersistence(period.end, persistenceDate, observation.timecardRows);
        if (!persistence.verified) fail('integrity_failed');
      }
      outcome = validateSyncOutcome({
        mode: preview ? 'additions_edits_preview' : 'additions_edits',
        disposition: !preview && mirrorPlan.hasChanges ? 'published' : 'no_change',
        publicationStatus: preview ? 'preview' : 'ready',
        wouldPublish: mirrorPlan.hasChanges,
        mirror: { ...mirrorPlan.counts },
        publications,
        ...(!preview ? { businessDate, businessTimezone, delta } : {}),
        ...(persistence ? { persistence } : {}),
      });
      observationResult = this.observeWorkforceShadow({ ...observation, syncOutcome: outcome }, { transaction: false });
      if (!preview) {
        this.db.prepare(`INSERT INTO paycom_sync_change_history(
          run_id,source_id,target,business_date,business_timezone,observed_at,disposition,delta_json,persistence_json
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          runId, observation.sourceId, period.end, businessDate, businessTimezone, collectedAt,
          outcome.disposition, JSON.stringify(delta), JSON.stringify(persistence),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    if (!preview) {
      try {
        const cutoff = new Date(Date.parse(collectedAt) - NO_CHANGE_HISTORY_RETENTION_MS).toISOString();
        this.compactSyncChangeHistory(cutoff, MAX_HISTORY_COMPACTION_DELETE);
      } catch {}
    }
    return {
      disposition: outcome.disposition,
      wouldPublish: outcome.wouldPublish,
      businessDate: outcome.businessDate || businessDate,
      businessTimezone: outcome.businessTimezone || businessTimezone,
      counts: outcome.mirror,
      observation: observationResult,
      ...(outcome.delta ? { delta: outcome.delta } : {}),
      ...(outcome.persistence ? { persistence: outcome.persistence } : {}),
      ...(outcome.publications || {}),
    };
  }

  previewWorkforceSync(input) {
    if (!plain(input) || Object.hasOwn(input, 'preview')) fail('candidate_invalid');
    return this.publishWorkforceSync({ ...input, preview: true });
  }

  active(kind, target = null) {
    if (!KINDS.has(kind) || kind === 'resource_links') fail('invalid_query');
    const sql = target
      ? 'SELECT p.* FROM active_publications a JOIN publications p ON p.id=a.publication_id WHERE a.kind=? AND a.target=?'
      : 'SELECT p.* FROM active_publications a JOIN publications p ON p.id=a.publication_id WHERE a.kind=? ORDER BY p.target DESC LIMIT 1';
    return target ? this.db.prepare(sql).get(kind, target) : this.db.prepare(sql).get(kind);
  }

  activeResourceLinks(resourceType = TIMECARD_SUMMARY, target = null) {
    if (resourceType !== TIMECARD_SUMMARY) fail('invalid_query');
    const sql = target
      ? `SELECT p.* FROM active_resource_link_publications a JOIN resource_link_publications p
          ON p.id=a.publication_id WHERE a.resource_type=? AND a.target=?`
      : `SELECT p.* FROM active_resource_link_publications a JOIN resource_link_publications p
          ON p.id=a.publication_id WHERE a.resource_type=? ORDER BY p.target DESC LIMIT 1`;
    const publication = target ? this.db.prepare(sql).get(resourceType, target) : this.db.prepare(sql).get(resourceType);
    if (!publication) return null;
    const rows = this.db.prepare(`SELECT employee_code employeeCode,canonical_url canonicalUrl
      FROM resource_links WHERE publication_id=? ORDER BY employee_code`).all(publication.id)
      .map(row => ({ employeeCode: row.employeeCode, canonicalUrl: row.canonicalUrl }));
    if (rows.length !== publication.row_count) fail('resource_links_invalid');
    return { publication, rows };
  }

  auditResourceLinks(resourceType = TIMECARD_SUMMARY, target = null) {
    const active = this.activeResourceLinks(resourceType, target);
    if (!active) return { verified: false, code: 'not_loaded', resourceType, target };
    return this.auditResourceLinkPublication(active.publication.id);
  }

  activeRoster(target = null) {
    const publication = this.active('roster', target);
    if (!publication) fail('roster_not_loaded');
    const employees = this.db.prepare('SELECT employee_code employeeCode,employee_name employeeName,is_active isActive,is_active_driver isActiveDriver,record_json recordJson FROM roster_employees WHERE publication_id=? ORDER BY employee_code').all(publication.id)
      .map(row => ({ ...JSON.parse(row.recordJson), isActive: Boolean(row.isActive), isActiveDriver: Boolean(row.isActiveDriver) }));
    if (employees.length !== publication.row_count) fail('roster_invalid');
    return { publication, employees };
  }

  activeTimecards(periodEnd) {
    isoDate(periodEnd);
    const publication = this.active('timecards', periodEnd);
    if (!publication) return null;
    const rows = this.db.prepare(`SELECT employee_code employeeCode,employee_name employeeName,
      source_sha256 sourceSha256,business_sha256 businessSha256,observed_at observedAt,record_json recordJson
      FROM timecards WHERE publication_id=? ORDER BY employee_code`).all(publication.id)
      .map(row => ({
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        sourceSha256: row.sourceSha256,
        record: JSON.parse(row.recordJson),
        ...(row.businessSha256 ? { businessSha256: row.businessSha256, observedAt: row.observedAt } : {}),
      }));
    if (rows.length !== publication.row_count) fail('timecards_invalid');
    return { publication, rows };
  }

  activeWorkforce(target = null) {
    this.db.exec('BEGIN');
    try {
      const roster = this.activeRoster(target);
      const periodEnd = roster.publication.target;
      const timecards = this.activeTimecards(periodEnd);
      const resourceLinks = this.activeResourceLinks(TIMECARD_SUMMARY, periodEnd);
      let timecardMetadata = null;
      try { timecardMetadata = timecards ? JSON.parse(timecards.publication.metadata_json) : null; } catch {}
      if (!timecards || !resourceLinks || !timecardMetadata
          || timecardMetadata.rosterPublicationId !== roster.publication.id
          || timecardMetadata.rosterContentSha256 !== roster.publication.content_sha256
          || resourceLinks.publication.roster_publication_id !== roster.publication.id
          || resourceLinks.publication.roster_content_sha256 !== roster.publication.content_sha256) {
        fail('workforce_inconsistent');
      }
      this.db.exec('COMMIT');
      return { roster, timecards, resourceLinks };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  auditPublication(publicationId, { databaseChecks = true } = {}) {
    const publication = this.db.prepare('SELECT * FROM publications WHERE id=?').get(publicationId);
    if (!publication) return { verified: false, code: 'not_loaded', publicationId };
    const kind = publication.kind;
    let rows = [];
    let metadata;
    let calculatedContentSha256 = null;
    let projectionValid = true;
    try {
      metadata = JSON.parse(publication.metadata_json);
      if (kind === 'pay_periods') {
        rows = this.db.prepare('SELECT period_start start,period_end end,period_key key,relation FROM pay_periods WHERE publication_id=? ORDER BY period_key').all(publication.id)
          .map(row => ({ start: row.start, end: row.end, key: row.key, relation: row.relation }));
      } else if (kind === 'roster') {
        rows = this.db.prepare('SELECT employee_code,employee_name,is_active,is_active_driver,record_json FROM roster_employees WHERE publication_id=? ORDER BY employee_code').all(publication.id).map(row => {
          const record = JSON.parse(row.record_json);
          if (row.employee_code !== record.employeeCode || row.employee_name !== record.employeeName
              || Boolean(row.is_active) !== record.isActive || Boolean(row.is_active_driver) !== record.isActiveDriver) projectionValid = false;
          return record;
        });
      } else {
        rows = this.db.prepare(`SELECT employee_code employeeCode,employee_name employeeName,
          period_total_hours periodTotalHours,missing_days missingDays,source_sha256 sourceSha256,
          business_sha256 businessSha256,observed_at observedAt,record_json recordJson
          FROM timecards WHERE publication_id=? ORDER BY employee_code`).all(publication.id)
          .map(row => {
            const record = JSON.parse(row.recordJson);
            if (row.employeeCode !== record.employeeCode || row.periodTotalHours !== record.periodTotalHours
                || row.missingDays !== record.days.filter(day => day.missingPunch).length
                || (row.businessSha256 && row.businessSha256 !== timecardBusinessSha256(record))) projectionValid = false;
            return {
              employeeCode: row.employeeCode,
              employeeName: row.employeeName,
              record,
              sourceSha256: row.sourceSha256,
              ...(row.businessSha256 ? { businessSha256: row.businessSha256, observedAt: row.observedAt } : {}),
            };
          });
      }
      if (kind === 'timecards') {
        validateTimecards({ kind, target: publication.target, metadata, rows, periodKey: `${metadata.periodStart}_${metadata.periodEnd}` });
      }
      calculatedContentSha256 = contentSha256({
        kind, target: publication.target, metadata, rows,
        ...(kind === 'timecards' ? { periodKey: `${metadata.periodStart}_${metadata.periodEnd}` } : {}),
      });
    } catch { projectionValid = false; }
    const count = rows.length;
    const quick = databaseChecks ? this.db.prepare('PRAGMA quick_check').get()?.quick_check : 'ok';
    const foreignKeyErrors = databaseChecks ? this.db.prepare('PRAGMA foreign_key_check').all().length : 0;
    const verified = quick === 'ok' && foreignKeyErrors === 0 && projectionValid && count === publication.row_count
      && calculatedContentSha256 === publication.content_sha256;
    return {
      verified,
      code: verified ? 'verified' : 'integrity_failed',
      kind, target: publication.target, publicationId: publication.id, rowCount: count,
      contentSha256: publication.content_sha256, calculatedContentSha256, collectedAt: publication.collected_at,
      quickCheck: quick, foreignKeyErrors, projectionValid,
    };
  }

  auditPayPeriodTarget(periodEnd) {
    isoDate(periodEnd);
    const publication = this.active('pay_periods');
    if (!publication) return { verified: false, code: 'not_loaded', target: periodEnd };
    const audit = this.auditPublication(publication.id);
    const period = this.db.prepare(`SELECT period_end,relation FROM pay_periods
      WHERE publication_id=? AND period_end=?`).get(publication.id, periodEnd);
    const verified = audit.verified && period?.relation === 'current';
    return {
      verified,
      code: verified ? 'verified' : audit.verified ? 'target_mismatch' : audit.code,
      target: periodEnd,
      publicationId: publication.id,
      runId: publication.run_id,
      contentSha256: publication.content_sha256,
      collectedAt: publication.collected_at,
    };
  }

  audit(kind, target = null) {
    const publication = this.active(kind, target);
    if (!publication) return { verified: false, code: 'not_loaded', kind, target };
    return this.auditPublication(publication.id);
  }

  auditTimecards(periodEnd) {
    isoDate(periodEnd);
    const roster = this.active('roster', periodEnd);
    const timecards = this.active('timecards', periodEnd);
    if (!roster || !timecards) {
      return { verified: false, code: !roster ? 'roster_not_loaded' : 'timecards_not_loaded', periodEnd };
    }
    const rosterAudit = this.auditPublication(roster.id, { databaseChecks: false });
    const timecardAudit = this.auditPublication(timecards.id);
    let metadata = null;
    try { metadata = JSON.parse(timecards.metadata_json); } catch {}
    const rosterBindingValid = Boolean(metadata
      && ['full', 'incremental', 'published_roster', 'sync_merge'].includes(metadata.mode)
      && metadata.periodEnd === periodEnd
      && metadata.rosterPublicationId === roster.id
      && metadata.rosterContentSha256 === roster.content_sha256);
    const expected = this.db.prepare(`SELECT employee_code employeeCode,employee_name employeeName
      FROM roster_employees WHERE publication_id=? AND is_active=1 ORDER BY employee_code`).all(roster.id);
    const actual = this.db.prepare(`SELECT employee_code employeeCode,employee_name employeeName
      FROM timecards WHERE publication_id=? ORDER BY employee_code`).all(timecards.id);
    const expectedByCode = new Map(expected.map(row => [row.employeeCode, row.employeeName]));
    const actualByCode = new Map(actual.map(row => [row.employeeCode, row.employeeName]));
    const missingCount = expected.reduce((count, row) => count + Number(!actualByCode.has(row.employeeCode)), 0);
    const unexpectedCount = actual.reduce((count, row) => count + Number(!expectedByCode.has(row.employeeCode)), 0);
    const identityMismatchCount = actual.reduce((count, row) => count
      + Number(expectedByCode.has(row.employeeCode) && expectedByCode.get(row.employeeCode) !== row.employeeName), 0);
    const verified = rosterAudit.verified && timecardAudit.verified && rosterBindingValid
      && missingCount === 0 && unexpectedCount === 0 && identityMismatchCount === 0
      && expected.length === actual.length;
    const code = verified ? 'verified'
      : !rosterAudit.verified || !timecardAudit.verified ? 'integrity_failed' : 'membership_mismatch';
    return {
      verified, code, periodEnd,
      rosterPublicationId: roster.id, timecardPublicationId: timecards.id,
      activeEmployees: expected.length, timecards: actual.length,
      missingCount, unexpectedCount, duplicateCount: 0, identityMismatchCount,
      rosterBindingValid, rosterProjectionValid: rosterAudit.projectionValid,
      timecardProjectionValid: timecardAudit.projectionValid,
      quickCheck: timecardAudit.quickCheck, foreignKeyErrors: timecardAudit.foreignKeyErrors,
    };
  }

  auditTimecardPersistence(periodEnd, date, observedRows = []) {
    isoDate(periodEnd);
    isoDate(date);
    const period = periodFromEnd(periodEnd);
    if (!period.dates.includes(date) || !Array.isArray(observedRows) || observedRows.length > 5000) fail('invalid_query');
    const audit = this.auditTimecards(periodEnd);
    if (!audit.verified) return { verified: false, code: audit.code, date };
    const active = this.activeTimecards(periodEnd);
    const activeByCode = new Map(active.rows.map(row => [row.employeeCode, row]));
    const observedCodes = new Set();
    let persistedSelectedTimecardCount = 0;
    for (const row of observedRows) {
      if (typeof row?.employeeCode !== 'string' || observedCodes.has(row.employeeCode)) fail('invalid_query');
      observedCodes.add(row.employeeCode);
      const persisted = activeByCode.get(row.employeeCode);
      let matches = Boolean(persisted && persisted.employeeName === row.employeeName);
      try {
        matches = matches
          && timecardBusinessSha256(row.record) === row.businessSha256
          && timecardBusinessSha256(persisted.record) === row.businessSha256;
      } catch { matches = false; }
      persistedSelectedTimecardCount += Number(matches);
    }
    let dateRowCount = 0;
    let punchCount = 0;
    let inDayPunchCount = 0;
    let inDayTimecardCount = 0;
    let outLunchPunchCount = 0;
    let inLunchPunchCount = 0;
    let outDayPunchCount = 0;
    let unclassifiedPunchCount = 0;
    for (const row of active.rows) {
      const day = row.record.days.find(item => item.date === date);
      if (!day) continue;
      dateRowCount += 1;
      let hasInDay = false;
      for (const punch of day.punches) {
        punchCount += 1;
        if (punch.kind === 'IN DAY') { inDayPunchCount += 1; hasInDay = true; }
        else if (punch.kind === 'OUT LUNCH') outLunchPunchCount += 1;
        else if (punch.kind === 'IN LUNCH') inLunchPunchCount += 1;
        else if (punch.kind === 'OUT DAY') outDayPunchCount += 1;
        else unclassifiedPunchCount += 1;
      }
      inDayTimecardCount += Number(hasInDay);
    }
    const result = {
      verified: dateRowCount === active.rows.length
        && persistedSelectedTimecardCount === observedRows.length,
      code: dateRowCount === active.rows.length
        && persistedSelectedTimecardCount === observedRows.length ? 'verified' : 'integrity_failed',
      date,
      timecardPublicationId: active.publication.id,
      publicationCollectedAt: active.publication.collected_at,
      timecardCount: active.rows.length,
      dateRowCount,
      selectedTimecardCount: observedRows.length,
      persistedSelectedTimecardCount,
      selectedMismatchCount: observedRows.length - persistedSelectedTimecardCount,
      punchCount,
      inDayPunchCount,
      inDayTimecardCount,
      outLunchPunchCount,
      inLunchPunchCount,
      outDayPunchCount,
      unclassifiedPunchCount,
    };
    if (result.verified) validateTimecardPersistence(result);
    return result;
  }

  reconcileCurrent(periodEnd) {
    isoDate(periodEnd);
    const roster = this.active('roster');
    const timecards = this.active('timecards', periodEnd);
    if (!roster || !timecards) return { verified: false, code: !roster ? 'roster_not_loaded' : 'timecards_not_loaded', periodEnd };
    if (roster.target !== periodEnd) return { verified: false, code: 'roster_period_mismatch', periodEnd, rosterTarget: roster.target };
    const rosterCodes = new Set(this.db.prepare('SELECT employee_code FROM roster_employees WHERE publication_id=? AND is_active=1').all(roster.id).map(row => row.employee_code));
    const timecardCodes = new Set(this.db.prepare('SELECT employee_code FROM timecards WHERE publication_id=?').all(timecards.id).map(row => row.employee_code));
    const missing = [...rosterCodes].filter(code => !timecardCodes.has(code)).sort();
    const unexpected = [...timecardCodes].filter(code => !rosterCodes.has(code)).sort();
    return {
      verified: missing.length === 0 && unexpected.length === 0,
      code: missing.length === 0 && unexpected.length === 0 ? 'verified' : 'membership_mismatch',
      periodEnd, rosterPublicationId: roster.id, timecardPublicationId: timecards.id,
      activeEmployees: rosterCodes.size, timecards: timecardCodes.size,
      missing: missing.slice(0, 100), unexpected: unexpected.slice(0, 100),
      omitted: Math.max(0, missing.length - 100) + Math.max(0, unexpected.length - 100),
    };
  }

  planWorkforceShadow({
    sourceId, target, observedAt, employees, reconcileBatchSize, fullReconcileMinutes, fullCollection = false,
  }) {
    if (typeof fullCollection !== 'boolean' || typeof sourceId !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(sourceId)
        || !DATE_RE.test(target) || typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))
        || !Array.isArray(employees) || employees.length < 1 || employees.length > 5000
        || !Number.isInteger(reconcileBatchSize) || reconcileBatchSize < 1 || reconcileBatchSize > 500
        || !Number.isInteger(fullReconcileMinutes) || fullReconcileMinutes < 60 || fullReconcileMinutes > 10_080) {
      fail('invalid_request');
    }
    const current = new Map();
    for (const employee of employees) {
      if (typeof employee?.employeeCode !== 'string' || !/^[A-Za-z0-9]{4}$/.test(employee.employeeCode)
          || typeof employee.employeeName !== 'string' || !employee.employeeName.trim()
          || typeof employee.isActive !== 'boolean') fail('api_invalid');
      const code = employee.employeeCode.toUpperCase();
      if (current.has(code)) fail('api_invalid');
      current.set(code, {
        employeeCode: code,
        employeeName: employee.employeeName,
        isActive: employee.isActive,
        profileSha256: rosterProfileSha256(employee),
        summarySha256: rosterSummarySha256(employee),
      });
    }
    const priorRows = this.db.prepare(`SELECT employee_code employeeCode,profile_sha256 profileSha256,
      summary_sha256 summarySha256,last_timecard_observed_at lastTimecardObservedAt
      FROM paycom_sync_employees WHERE source_id=? AND target=?`).all(sourceId, target);
    const prior = new Map(priorRows.map(row => [row.employeeCode, row]));
    const baseline = prior.size === 0;
    const obvious = new Set();
    for (const [code, value] of current) {
      const previous = prior.get(code);
      if (!previous) {
        if (!baseline && value.isActive) obvious.add(code);
      } else if (value.isActive && (previous.profileSha256 !== value.profileSha256
          || previous.summarySha256 !== value.summarySha256)) obvious.add(code);
    }
    const state = this.db.prepare(`SELECT last_full_reconciled_at lastFullReconciledAt,
      full_reconcile_anchor_at fullReconcileAnchorAt
      FROM paycom_sync_state WHERE source_id=? AND target=?`).get(sourceId, target);
    const reference = state?.lastFullReconciledAt || state?.fullReconcileAnchorAt || null;
    const fullReconciliation = fullCollection || Boolean(reference
      && Date.parse(observedAt) - Date.parse(reference) >= fullReconcileMinutes * 60_000);
    const selected = new Set(fullReconciliation
      ? [...current.values()].filter(value => value.isActive).map(value => value.employeeCode)
      : obvious);
    let rotationCount = 0;
    if (!fullReconciliation) {
      const rotation = [...current.values()]
        .filter(value => value.isActive && !obvious.has(value.employeeCode))
        .sort((left, right) => {
          const leftTime = prior.get(left.employeeCode)?.lastTimecardObservedAt || '';
          const rightTime = prior.get(right.employeeCode)?.lastTimecardObservedAt || '';
          return leftTime.localeCompare(rightTime) || left.employeeCode.localeCompare(right.employeeCode);
        })
        .slice(0, reconcileBatchSize);
      for (const value of rotation) selected.add(value.employeeCode);
      rotationCount = rotation.length;
    }
    return {
      baseline,
      fullReconciliation,
      obviousCandidateCount: obvious.size,
      rotationCount,
      selectedEmployees: [...selected].sort().map(code => ({
        employeeCode: code,
        employeeName: current.get(code).employeeName,
      })),
    };
  }

  observeWorkforceShadow({
    sourceId, target, runId, observedAt, sourceSha256, employees,
    sourceCompleteness = 'observation_only',
    timecardRows = null, reconcileBatchSize = null, fullReconcileMinutes = null,
    syncOutcome = null, fullCollection = false,
  }, { transaction = true } = {}) {
    if (typeof transaction !== 'boolean') fail('invalid_request');
    if (syncOutcome !== null) validateSyncOutcome(syncOutcome);
    if (typeof sourceId !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(sourceId)
        || !RUN_RE.test(runId) || !DATE_RE.test(target)
        || typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))
        || !/^[a-f0-9]{64}$/.test(sourceSha256)
        || !Array.isArray(employees) || employees.length < 1 || employees.length > 5000
        || !['authoritative', 'observation_only'].includes(sourceCompleteness)
        || (timecardRows !== null && (!Array.isArray(timecardRows)
          || !Number.isInteger(reconcileBatchSize) || reconcileBatchSize < 1 || reconcileBatchSize > 500
          || !Number.isInteger(fullReconcileMinutes) || fullReconcileMinutes < 60 || fullReconcileMinutes > 10_080))) {
      fail('invalid_request');
    }
    const current = new Map();
    for (const employee of employees) {
      if (typeof employee?.employeeCode !== 'string' || !/^[A-Za-z0-9]{4}$/.test(employee.employeeCode)) fail('api_invalid');
      const code = employee.employeeCode.toUpperCase();
      if (current.has(code)) fail('api_invalid');
      current.set(code, {
        code,
        profileSha256: rosterProfileSha256(employee),
        summarySha256: rosterSummarySha256(employee),
      });
    }
    let receipt;
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.db.prepare('SELECT * FROM paycom_sync_state WHERE source_id=? AND target=?').get(sourceId, target);
      if (state?.last_run_id === runId) {
        receipt = JSON.parse(state.last_receipt_json);
        if (transaction) this.db.exec('COMMIT');
        return receipt;
      }
      let selection = null;
      const timecardsByCode = new Map();
      if (timecardRows !== null) {
        selection = this.planWorkforceShadow({
          sourceId, target, observedAt, employees, reconcileBatchSize, fullReconcileMinutes, fullCollection,
        });
        for (const row of timecardRows) {
          if (typeof row?.employeeCode !== 'string' || !/^[A-Z0-9]{4}$/.test(row.employeeCode)
              || typeof row.employeeName !== 'string' || !row.employeeName.trim()
              || row.record?.employeeCode !== row.employeeCode || row.record?.periodEnd !== target
              || !/^[a-f0-9]{64}$/.test(row.businessSha256)
              || row.businessSha256 !== timecardBusinessSha256(row.record)
              || typeof row.observedAt !== 'string' || Number.isNaN(Date.parse(row.observedAt))
              || timecardsByCode.has(row.employeeCode)) fail('timecards_invalid');
          try {
            const period = parsePeriodKey(row.record.periodKey);
            validateTimecardRecord(row.record, {
              employeeCode: row.employeeCode, period, sourceUrl: row.record.sourceUrl,
            });
          } catch { fail('timecards_invalid'); }
          timecardsByCode.set(row.employeeCode, row);
        }
        const expected = selection.selectedEmployees;
        if (expected.length !== timecardsByCode.size || expected.some(employee => {
          const row = timecardsByCode.get(employee.employeeCode);
          return !row || row.employeeName !== employee.employeeName;
        })) fail('membership_mismatch');
      }
      const priorRows = this.db.prepare(`SELECT employee_code employeeCode,profile_sha256 profileSha256,
        summary_sha256 summarySha256,missing_observations missingObservations,
        timecard_business_sha256 timecardBusinessSha256
        FROM paycom_sync_employees WHERE source_id=? AND target=?`).all(sourceId, target);
      const prior = new Map(priorRows.map(row => [row.employeeCode, row]));
      const baseline = prior.size === 0;
      let addedCount = 0;
      let profileChangedCount = 0;
      let summaryChangedCount = 0;
      const changedEmployees = new Set();
      for (const [code, value] of current) {
        const previous = prior.get(code);
        if (!previous) {
          if (!baseline) {
            addedCount += 1;
            changedEmployees.add(code);
          }
        } else {
          const profileChanged = previous.profileSha256 !== value.profileSha256;
          const summaryChanged = previous.summarySha256 !== value.summarySha256;
          profileChangedCount += Number(profileChanged);
          summaryChangedCount += Number(summaryChanged);
          if (profileChanged || summaryChanged) changedEmployees.add(code);
        }
      }
      const missing = priorRows.filter(row => !current.has(row.employeeCode));
      const pendingRemovalSha256 = null;
      const pendingRemovalCount = 0;
      const clearMissing = this.db.prepare(`UPDATE paycom_sync_employees SET missing_observations=0
        WHERE source_id=? AND target=? AND employee_code=?`);
      for (const row of missing) clearMissing.run(sourceId, target, row.employeeCode);
      const upsert = this.db.prepare(`INSERT INTO paycom_sync_employees(
        source_id,target,employee_code,profile_sha256,summary_sha256,last_observed_at,missing_observations
      ) VALUES(?,?,?,?,?,?,0) ON CONFLICT(source_id,target,employee_code) DO UPDATE SET
        profile_sha256=excluded.profile_sha256,summary_sha256=excluded.summary_sha256,
        last_observed_at=excluded.last_observed_at,missing_observations=0`);
      for (const value of current.values()) {
        upsert.run(sourceId, target, value.code, value.profileSha256, value.summarySha256, observedAt);
      }
      let timecardAddedCount = 0;
      let timecardChangedCount = 0;
      let timecardUnchangedCount = 0;
      let timecardBaselineCount = 0;
      if (selection) {
        const updateTimecard = this.db.prepare(`UPDATE paycom_sync_employees SET
          timecard_business_sha256=?,last_timecard_observed_at=?,
          last_full_verified_at=CASE WHEN ?=1 THEN ? ELSE last_full_verified_at END
          WHERE source_id=? AND target=? AND employee_code=?`);
        for (const [code, row] of timecardsByCode) {
          const previous = prior.get(code);
          if (!previous) {
            if (baseline) timecardBaselineCount += 1;
            else timecardAddedCount += 1;
          } else if (!previous.timecardBusinessSha256) timecardBaselineCount += 1;
          else if (previous.timecardBusinessSha256 !== row.businessSha256) timecardChangedCount += 1;
          else timecardUnchangedCount += 1;
          updateTimecard.run(
            row.businessSha256, row.observedAt, Number(selection.fullReconciliation), row.observedAt,
            sourceId, target, code,
          );
        }
      }
      const candidateCount = changedEmployees.size;
      receipt = {
        baseline,
        absencePolicy: 'retain',
        sourceCompleteness,
        observedCount: current.size,
        addedCount,
        profileChangedCount,
        summaryChangedCount,
        missingCount: missing.length,
        candidateCount,
        ...(selection ? {
          selectedTimecardCount: timecardsByCode.size,
          obviousCandidateCount: selection.obviousCandidateCount,
          rotationCount: selection.rotationCount,
          fullReconciliation: selection.fullReconciliation,
          timecardAddedCount,
          timecardChangedCount,
          timecardUnchangedCount,
          timecardBaselineCount,
        } : {}),
        ...(syncOutcome ? { syncOutcome } : {}),
      };
      this.db.prepare(`INSERT INTO paycom_sync_state(
        source_id,target,last_run_id,checked_at,source_sha256,employee_count,
        pending_removal_sha256,pending_removal_count,last_receipt_json,
        last_full_reconciled_at,full_reconcile_anchor_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,target) DO UPDATE SET
        last_run_id=excluded.last_run_id,checked_at=excluded.checked_at,source_sha256=excluded.source_sha256,
        employee_count=excluded.employee_count,pending_removal_sha256=excluded.pending_removal_sha256,
        pending_removal_count=excluded.pending_removal_count,last_receipt_json=excluded.last_receipt_json,
        last_full_reconciled_at=COALESCE(excluded.last_full_reconciled_at,paycom_sync_state.last_full_reconciled_at),
        full_reconcile_anchor_at=CASE WHEN excluded.last_full_reconciled_at IS NOT NULL
          THEN excluded.full_reconcile_anchor_at ELSE paycom_sync_state.full_reconcile_anchor_at END`)
        .run(sourceId, target, runId, observedAt, sourceSha256, current.size,
          pendingRemovalSha256, pendingRemovalCount, JSON.stringify(receipt),
          selection?.fullReconciliation ? observedAt : null, observedAt);
      if (transaction) this.db.exec('COMMIT');
    } catch (error) {
      if (transaction) try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return receipt;
  }

  shadowReceiptForRun(sourceId, target, runId) {
    if (typeof sourceId !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(sourceId)
        || !DATE_RE.test(target) || !RUN_RE.test(runId)) fail('invalid_query');
    const row = this.db.prepare(`SELECT last_receipt_json receiptJson FROM paycom_sync_state
      WHERE source_id=? AND target=? AND last_run_id=?`).get(sourceId, target, runId);
    return row ? JSON.parse(row.receiptJson) : null;
  }

  syncState(sourceId, target) {
    if (typeof sourceId !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(sourceId) || !DATE_RE.test(target)) fail('invalid_query');
    const state = this.db.prepare(`SELECT checked_at checkedAt,employee_count employeeCount,
      pending_removal_count pendingRemovalCount,last_full_reconciled_at lastFullReconciledAt,
      full_reconcile_anchor_at fullReconcileAnchorAt,last_receipt_json receiptJson
      FROM paycom_sync_state WHERE source_id=? AND target=?`).get(sourceId, target);
    if (!state) return null;
    return {
      checkedAt: state.checkedAt,
      employeeCount: state.employeeCount,
      pendingRemovalCount: state.pendingRemovalCount,
      lastFullReconciledAt: state.lastFullReconciledAt,
      fullReconcileAnchorAt: state.fullReconcileAnchorAt,
      receipt: JSON.parse(state.receiptJson),
    };
  }

  compactSyncChangeHistory(beforeObservedAt, maxDelete = MAX_HISTORY_COMPACTION_DELETE) {
    if (typeof beforeObservedAt !== 'string' || Number.isNaN(Date.parse(beforeObservedAt))
        || new Date(beforeObservedAt).toISOString() !== beforeObservedAt
        || !Number.isInteger(maxDelete) || maxDelete < 1 || maxDelete > 1000) fail('invalid_query');
    const candidates = this.db.prepare(`SELECT run_id runId,source_id sourceId,target,business_date businessDate
      FROM paycom_sync_change_history WHERE disposition='no_change' AND observed_at<?
      ORDER BY observed_at DESC,run_id DESC LIMIT 5000`).all(beforeObservedAt);
    const kept = new Set();
    const deletions = [];
    for (const row of candidates) {
      const key = `${row.sourceId}:${row.target}:${row.businessDate}`;
      if (!kept.has(key)) { kept.add(key); continue; }
      deletions.push(row.runId);
      if (deletions.length >= maxDelete) break;
    }
    const remove = this.db.prepare('DELETE FROM paycom_sync_change_history WHERE run_id=?');
    let deleted = 0;
    for (const runId of deletions) deleted += remove.run(runId).changes;
    return { scanned: candidates.length, deleted };
  }

  syncChangeHistory(sourceId, target, limit = 50, offset = 0) {
    if (typeof sourceId !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(sourceId)
        || !DATE_RE.test(target) || !Number.isInteger(limit) || limit < 1 || limit > 100
        || !Number.isInteger(offset) || offset < 0) fail('invalid_query');
    const rows = this.db.prepare(`SELECT run_id runId,business_date businessDate,
      business_timezone businessTimezone,observed_at observedAt,disposition,delta_json deltaJson,
      persistence_json persistenceJson FROM paycom_sync_change_history
      WHERE source_id=? AND target=? ORDER BY observed_at DESC,run_id DESC LIMIT ? OFFSET ?`)
      .all(sourceId, target, limit, offset).map(row => ({
        runId: row.runId,
        target,
        businessDate: row.businessDate,
        businessTimezone: row.businessTimezone,
        observedAt: row.observedAt,
        disposition: row.disposition,
        delta: validateBusinessDelta(JSON.parse(row.deltaJson)),
        persistence: validateTimecardPersistence(JSON.parse(row.persistenceJson)),
      }));
    const total = this.db.prepare(`SELECT COUNT(*) count FROM paycom_sync_change_history
      WHERE source_id=? AND target=?`).get(sourceId, target).count;
    return { items: rows, total, limit, offset, hasMore: offset + rows.length < total };
  }

  close() { this.db.close(); }
}

module.exports = {
  PaycomStore, validateCandidate, stageCandidate, readStaged, cleanupStage, cleanupRunStages,
  privateDirectory, privateFile, sha256, contentSha256,
};
