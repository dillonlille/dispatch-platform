'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomic, privateJson } = require('../installations/src/release-delivery-files');
const { privateDirectory, acquireLock } = require('../../host/controller/operations');
const { AccessError, exact, idempotencyKey } = require('../accounts/src/validation');
const ACTIONS = ['refresh', 'update_core', 'update_dev', 'rollout', 'pause', 'resume', 'recover'];
class UpdateCommands {
  constructor(directory, clock = Date.now) {
    this.root = privateDirectory(directory); this.clock = clock;
    this.jobs = privateDirectory(path.join(directory, 'commands'));
  }
  list() {
    return fs.readdirSync(this.jobs).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => privateJson(path.join(this.jobs, name), process.geteuid())).sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  save(job) { atomic(path.join(this.jobs, `${job.id}.json`), job); }
  request(actor, input, targets = []) {
    exact(input, ['action', 'product', 'digest', 'idempotencyKey']); idempotencyKey(input.idempotencyKey);
    if (!ACTIONS.includes(input.action) || !['core', 'dsp'].includes(input.product)
        || !([null, undefined].includes(input.digest) || typeof input.digest === 'string' && /^[a-f0-9]{64}$/.test(input.digest))
        || ['update_core', 'update_dev', 'rollout'].includes(input.action) && !input.digest
        || input.action === 'update_core' && input.product !== 'core'
        || ['update_dev', 'rollout', 'pause', 'resume'].includes(input.action) && input.product !== 'dsp') throw new AccessError('invalid_input', 400);
    const id = crypto.createHash('sha256').update(`${actor}:${input.idempotencyKey}`).digest('hex');
    const intent = JSON.stringify({ action: input.action, product: input.product, digest: input.digest || null });
    const fd = acquireLock({ local: path.join(this.root, 'queue-lock') });
    try {
      const jobs = this.list(), prior = jobs.find(job => job.id === id);
      if (prior) {
        if (prior.intent !== intent) throw new AccessError('idempotency_conflict', 409);
        return prior;
      }
      if (jobs.length >= 10000) throw new AccessError('release_history_capacity', 409);
      if (jobs.some(job => ['queued', 'running'].includes(job.status)) && input.action !== 'pause') throw new AccessError('release_busy', 409);
      const job = { id, actor, intent, sequence: Math.max(0, ...jobs.map(job => job.sequence || 0)) + 1, ...JSON.parse(intent), targets: input.action === 'rollout' ? targets : [],
        status: 'queued', failure: null, createdAt: this.clock(), completedAt: null };
      this.save(job); return job;
    } finally { fs.closeSync(fd); }
  }
  heartbeat(status = 'ready') { atomic(path.join(this.root, 'worker.json'), { status, at: this.clock() }); }
  worker() {
    const value = privateJson(path.join(this.root, 'worker.json'), process.geteuid(), true);
    return { available: Boolean(value && this.clock() - value.at < 45000 && value.status !== 'stopped'), status: value?.status || 'offline' };
  }
}
module.exports = { UpdateCommands };
