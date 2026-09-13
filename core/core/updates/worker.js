'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { acquireLock } = require('../../host/controller/operations');
const { LocalReleases } = require('./local-releases');
const { UpdateCommands } = require('./commands');
const { PlatformGitHubReleases: GitHubReleases } = require('./platform-github');
const { rootFor, loadConfiguration } = require('./configuration');
const { coreHooks } = require('../../host/releases/core');
const { client } = require('./transport');
function authorizeOwner(paths, actorId) {
  const file = path.join(paths.local, 'state/access-control/access-control.sqlite3');
  require('../../host/storage/backup-files').checked(file, false);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const actor = db.prepare('SELECT platform_role,status FROM users WHERE id=?').get(actorId);
    if (actor?.platform_role !== 'owner' || actor.status !== 'active') throw new Error('release_actor_forbidden');
  } finally { db.close(); }
}
class UpdateWorker {
  constructor({ releases, commands, feed, invoke, authorize, clock = Date.now }) {
    Object.assign(this, { releases, commands, feed, invoke, authorize, clock });
    this.lastRefresh = 0; this.pending = null; this.closed = false;
  }
  async initialize() {
    for (const job of this.commands.list().filter(job => job.status === 'running')) {
      job.status = 'failed'; job.failure = 'release_interrupted'; job.completedAt = this.clock(); this.commands.save(job);
    }
    const state = this.releases.state();
    if (!state.operation && state.rollout?.status === 'running') await this.releases.pause();
    this.commands.heartbeat();
  }
  async execute(job) {
    await this.authorize(job.actor);
    if (['refresh', 'update_core', 'update_dev', 'rollout'].includes(job.action)) await this.feed.refresh(job.product);
    await this.authorize(job.actor);
    if (job.action === 'refresh') return;
    if (job.action === 'update_core') {
      if (['running', 'paused'].includes(this.releases.state().rollout?.status)) throw new Error('release_busy');
      return this.releases.updateCore(job.digest);
    }
    if (job.action === 'recover' && this.releases.state().operation?.product === 'core') return this.releases.recover();
    const input = { actor: job.actor };
    if (['update_dev', 'rollout'].includes(job.action)) input.digest = job.digest;
    if (job.action === 'rollout') input.targets = job.targets;
    await this.invoke(job.action, input);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  async run() {
    const job = this.commands.list().find(item => item.status === 'queued');
    if (job) {
      job.status = 'running'; this.commands.save(job);
      try { await this.execute(job); job.status = 'completed'; job.failure = null; }
      catch (error) { job.status = 'failed'; job.failure = /^release_[a-z_]+$/.test(error.message) ? error.message : 'release_operation_failed'; }
      job.completedAt = this.clock(); this.commands.save(job); return;
    }
    const state = this.releases.state();
    if (state.operation) return;
    if (state.rollout?.status === 'running') {
      try { await this.authorize(state.rollout.actor); await this.invoke('step', { actor: state.rollout.actor }); }
      catch { if (!this.releases.state().operation && this.releases.state().rollout?.status === 'running') await this.releases.pause(); }
      return;
    }
    if (this.clock() - this.lastRefresh >= 300000) {
      this.lastRefresh = this.clock();
      for (const product of ['core', 'dsp']) {
        try { await this.feed.refresh(product); }
        catch { this.commands.heartbeat('feed_unavailable'); }
      }
    }
  }
  async close() { this.closed = true; await this.pending; this.commands.heartbeat('stopped'); }
}
async function startWorker(paths, dependencies = {}) {
  const configuration = loadConfiguration(paths);
  if (!configuration) throw new Error('release_configuration_required');
  const directory = rootFor(paths), lock = acquireLock({ local: path.join(directory, 'worker-lock') }, 'controller');
  let releases;
  const commands = new UpdateCommands(directory);
  releases = new LocalReleases({ directory, devDspId: configuration.devDspId,
    hooks: coreHooks({ paths, configuration, releases: () => releases.state(), ...dependencies }) });
  const feed = new GitHubReleases({ directory: path.join(directory, 'downloads'), releases });
  const worker = new UpdateWorker({ releases, commands, feed, invoke: client(paths), authorize: actor => authorizeOwner(paths, actor) });
  try { await worker.initialize(); } catch (error) { fs.closeSync(lock); throw error; }
  const heartbeat = setInterval(() => commands.heartbeat(), 10000);
  let timer;
  const loop = () => { if (!worker.closed) worker.tick().catch(() => commands.heartbeat('unavailable')).finally(() => {
    if (!worker.closed) timer = setTimeout(loop, 1000);
  }); };
  loop();
  let closing;
  return { worker, close() { return closing ||= (async () => { clearTimeout(timer); clearInterval(heartbeat); await worker.close(); fs.closeSync(lock); })(); } };
}
module.exports = { UpdateWorker, startWorker, authorizeOwner };
