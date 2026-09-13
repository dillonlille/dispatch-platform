'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, fail } = require('./operations');

const ACTIONS = Object.freeze(['create', 'start', 'stop', 'restart', 'retire']);

// Call mutations while holding the platform operation lock. Request intent is
// fsynced before any DSP or service mutation; failed requests retain their phase
// and resource identity so retry can reconcile them without making another DSP.
class DirectoryJournal {
  constructor(paths) {
    this.root = privateDirectory(path.join(paths.local, 'state/directory'));
    this.requests = privateDirectory(path.join(this.root, 'requests'));
    this.records = privateDirectory(path.join(this.root, 'dsps'));
  }

  request(action, requestId, id) {
    if (!ACTIONS.includes(action) || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(requestId)) fail('directory_request_invalid');
    if (action !== 'create' || id !== undefined) validateDspId(id);
    if (id) require('../storage/deletion-state').assertRetained({ local: path.resolve(this.root, '../..') }, id);
    const key = crypto.createHash('sha256').update(requestId).digest('hex');
    const file = path.join(this.requests, `${key}.json`);
    const prior = privateJson(file, process.geteuid(), true);
    if (prior) {
      if (prior.key !== key || prior.action !== action || (id && prior.dspId !== id)) fail('directory_request_conflict');
      return this.validateRequest(prior);
    }
    const record = id ? this.record(id) : null;
    if (action !== 'create' && !record) fail('directory_dsp_not_found');
    if (action === 'create' && record) fail('directory_identity_mismatch');
    const job = { version: 1, key, action, dspId: id || `dsp_${crypto.randomBytes(16).toString('hex')}`,
      creationId: `create_${crypto.randomBytes(16).toString('hex')}`, previousRequest: record?.latestRequest || null,
      status: 'pending', phase: 'reserved', error: null };
    atomic(file, job);
    return job;
  }

  validateRequest(job) {
    if (!job || job.version !== 1 || !/^[a-f0-9]{64}$/.test(job.key) || !ACTIONS.includes(job.action)
        || !['pending', 'failed', 'complete'].includes(job.status)
        || !['reserved', 'storage', 'prepare', 'stop', 'credentials', 'bridge', 'start', 'verify', 'ready', 'stopped', 'retired'].includes(job.phase)
        || job.previousRequest !== null && !/^[a-f0-9]{64}$/.test(job.previousRequest)
        || job.error !== null && !/^directory_[a-z_]+$/.test(job.error)
        || !/^create_[a-f0-9]{32}$/.test(job.creationId)) fail('directory_journal_unsafe');
    validateDspId(job.dspId);
    return job;
  }

  save(job) { atomic(path.join(this.requests, `${this.validateRequest(job).key}.json`), job); }

  record(id) {
    if (require('../storage/deletion-state').deleted({ local: path.resolve(this.root, '../..') }, validateDspId(id))) return null;
    const value = privateJson(path.join(this.records, `${validateDspId(id)}.json`), process.geteuid(), true);
    if (value) this.validateRecord(value, id);
    return value;
  }

  validateRecord(value, id = value?.id) {
    validateDspId(id);
    if (!value || value.version !== 1 || value.id !== id || !/^create_[a-f0-9]{32}$/.test(value.creationId)
        || !['running', 'stopped', 'retired'].includes(value.desiredState)
        || !/^[a-f0-9]{64}$/.test(value.latestRequest)
        || value.tokenHash !== null && !/^[a-f0-9]{64}$/.test(value.tokenHash)) fail('directory_journal_unsafe');
    return value;
  }

  saveRecord(record) {
    this.validateRecord(record);
    atomic(path.join(this.records, `${record.id}.json`), record);
    return this.record(record.id);
  }

  all() {
    return fs.readdirSync(this.records).sort().map(name => {
      if (!/^dsp_[a-f0-9]{32}\.json$/.test(name)) fail('directory_journal_unsafe');
      return this.record(name.slice(0, -5));
    }).filter(Boolean);
  }

  authorityCatalog() {
    return {
      resolve: id => {
        const record = this.record(id);
        return record?.desiredState === 'running' && record.tokenHash
          ? { digest: record.tokenHash, generation: 1 } : null;
      },
      count: () => this.all().filter(record => record.desiredState === 'running' && record.tokenHash).length,
    };
  }
}

module.exports = { DirectoryJournal, ACTIONS };
