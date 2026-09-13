'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { platformPaths } = require('../../shared/paths/platform-paths');
const { registrationToken } = require('../../shared/agent/protocol');
const { DirectoryRuntimeAgentBridge } = require('../../core/agent-bridge/src/directory-bridge');
const { DirectoryJournal } = require('./journal');
const { DirectoryHost } = require('../services/host');
const { DirectoryEgress } = require('../networking/egress');
const { loadNetworkPolicy } = require('../networking/network-policy');
const { inspectDsp, ensureDsp } = require('../storage/storage');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { withLock, fail } = require('./operations');

const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class DirectoryManager {
  constructor({ paths, installation, hub, host = new DirectoryHost(paths, installation), journal = new DirectoryJournal(paths),
    publishAuthority = () => {}, networkPolicy, networkPermitted = () => true, onNetworkEvent = () => {}, pluginBackend = null }) {
    this.paths = platformPaths(paths.platformRoot);
    this.host = host; this.hub = hub; this.journal = journal;
    this.pluginBackend = pluginBackend;
    if (typeof publishAuthority !== 'function') fail('directory_request_invalid');
    this.publishAuthority = publishAuthority;
    this.bridges = new Map();
    this.egress = new Map();
    this.assistance = new Map();
    this.assistanceConfiguration = require('../browser-assistance/runner').loadConfiguration(this.paths);
    this.assistanceQueue = this.assistanceConfiguration && !pluginBackend
      ? new (require('../browser-assistance/queue').AssistanceQueue)(this.assistanceConfiguration) : null;
    this.networkPolicy = networkPolicy || loadNetworkPolicy(this.paths);
    this.networkPermitted = networkPermitted;
    this.onNetworkEvent = onNetworkEvent;
  }

  checkedDsp(record) {
    const dsp = inspectDsp(this.paths, record.id);
    if (dsp.creationId !== record.creationId) fail('directory_identity_mismatch');
    return dsp;
  }

  credentials(record) {
    const dsp = this.checkedDsp(record);
    const file = path.join(dsp.root, 'secrets/runtime-agent/registration-token');
    let token;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1
            || (info.mode & 0o7777) !== 0o600 || info.size > 128) fail('directory_credentials_unsafe');
        token = registrationToken(fs.readFileSync(fd, 'utf8').trim());
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code !== 'ENOENT' || record.tokenHash) throw error;
      token = crypto.randomBytes(32).toString('base64url');
      atomic(file, token + '\n');
    }
    if (record.tokenHash && record.tokenHash !== tokenHash(token)) fail('directory_credentials_unsafe');
    record.tokenHash = tokenHash(token);
    this.journal.saveRecord(record);
    this.publishAuthority(record);
  }

  async bridge(record) {
    await this.pluginBackend?.request(record.id, 'dsp.prepare', {});
    if (this.bridges.has(record.id)) return;
    const dsp = this.checkedDsp(record);
    const bridge = new DirectoryRuntimeAgentBridge({ runtimeKey: record.id, dspRoot: dsp.root, upstreamSocket: this.hub.socketPath });
    const egress = new DirectoryEgress({ dspRoot: dsp.root, policy: this.networkPolicy,
      permitted: () => this.journal.record(record.id)?.desiredState === 'running' && this.networkPermitted(record.id),
      onEvent: event => this.onNetworkEvent(record.id, event) });
    const assistance = !this.pluginBackend && this.assistanceQueue ? new (require('../browser-assistance/service').DirectoryBrowserAssistance)({
      dspRoot: dsp.root, queue: this.assistanceQueue, configuration: this.assistanceConfiguration,
      permitted: () => this.journal.record(record.id)?.desiredState === 'running' && this.networkPermitted(record.id),
    }) : null;
    try { await egress.start(); await bridge.start(); await assistance?.start(); }
    catch (error) { await Promise.allSettled([egress.close(), bridge.close(), assistance?.close()]); throw error; }
    if (assistance) this.assistance.set(record.id, assistance);
    this.egress.set(record.id, egress);
    this.bridges.set(record.id, bridge);
  }

  async ready(id) {
    const deadline = Date.now() + 85000;
    while (Date.now() < deadline) {
      if (this.hub.connected(id)) {
        try { if ((await this.hub.invoke(id, 'health', {})).ok === true) return; } catch {}
      }
      await pause(200);
    }
    fail('directory_runtime_not_ready');
  }

  async apply(action, requestId, dspId) {
    return require('../releases/provisioning').withCreation(this.paths, action, assignRelease => withLock(this.paths, async lockFd => {
      if (require('../storage/manual-backups').interruptedRestore(this.paths)) fail('directory_restore_incomplete');
      require('../releases/guard').assertAvailable(this.paths, dspId);
      if (action === 'retire' && require('../../core/updates/configuration').loadConfiguration(this.paths)?.devDspId === dspId) fail('directory_dev_protected');
      const job = this.journal.request(action, requestId, dspId);
      if (job.status === 'complete') return this.view(job);
      const checkpoint = phase => { job.phase = phase; job.status = 'pending'; job.error = null; this.journal.save(job); };
      try {
        let record = this.journal.record(job.dspId);
        if (action === 'create') {
          if (record && record.creationId !== job.creationId) fail('directory_identity_mismatch');
          if (!record) record = this.journal.saveRecord({ version: 1, id: job.dspId,
            creationId: job.creationId, latestRequest: job.key, desiredState: 'running', tokenHash: null });
        } else if (!record) fail('directory_dsp_not_found');
        // A retry cannot undo a newer stop, restart or retirement request.
        if (![job.key, job.previousRequest].includes(record.latestRequest)) fail('directory_request_superseded');
        if (record.desiredState === 'retired' && action !== 'retire') fail('directory_dsp_retired');
        const stopping = ['stop', 'retire'].includes(action);
        record.latestRequest = job.key;
        record.desiredState = stopping ? (action === 'retire' ? 'retired' : 'stopped') : 'running';
        this.journal.saveRecord(record);
        checkpoint('storage');
        ensureDsp(this.paths, record.id, record.creationId);
        if (assignRelease) await assignRelease(record.id, lockFd);
        checkpoint('prepare');
        await this.host.prepare(record.id, lockFd);
        this.checkedDsp(record);
        if (stopping || action === 'restart') {
          await this.pluginBackend?.request(record.id, 'plugin.revoke', { pluginId: null });
          checkpoint('stop');
          await this.assistance.get(record.id)?.close();
          this.assistance.delete(record.id);
          await this.egress.get(record.id)?.close();
          this.egress.delete(record.id);
          await this.host.stop(record.id, lockFd);
          await this.bridges.get(record.id)?.close();
          this.bridges.delete(record.id);
        }
        if (!stopping) {
          checkpoint('credentials'); this.credentials(record);
          checkpoint('bridge'); await this.bridge(record);
          checkpoint('start'); await this.host.start(record.id, lockFd);
          checkpoint('verify'); await this.ready(record.id);
        }
        job.status = 'complete'; job.phase = stopping ? record.desiredState : 'ready'; job.error = null;
        this.journal.save(job);
        return this.view(job);
      } catch (error) {
        const code = error.code || error.message;
        job.status = 'failed'; job.error = /^directory_[a-z_]+$/.test(code || '') ? code : 'directory_operation_failed';
        this.journal.save(job);
        throw Object.assign(new Error(job.error, { cause: error }), { code: job.error });
      }
    }));
  }

  // Reconnect retained services after a controller restart. Stopped or retired
  // records remain stopped, including an interrupted stop that has been journaled.
  async recover(select = () => true) {
    if (this.assistanceConfiguration && !this.pluginBackend) await require('../browser-assistance/runner').reapSessions(this.assistanceConfiguration);
    return withLock(this.paths, async lockFd => {
      if (require('../storage/manual-backups').interruptedRestore(this.paths)) fail('directory_restore_incomplete');
      const records = this.journal.all().filter(record => select(record) && record.tokenHash && !require('../releases/guard').dspUpdating(this.paths, record.id));
      const results = await require('../../shared/async/bounded-map').boundedMap(records, 2, async record => {
        await this.host.prepare(record.id, lockFd);
        this.checkedDsp(record);
        if (record.desiredState === 'running') {
          this.credentials(record);
          await this.bridge(record);
          await this.host.start(record.id, lockFd);
          await this.ready(record.id);
        } else {
          await this.pluginBackend?.request(record.id, 'plugin.revoke', { pluginId: null });
          await this.host.stop(record.id, lockFd);
        }
      });
      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [{ id: records[index].id, code: result.reason?.code || result.reason?.message || 'directory_operation_failed' }] : []);
      return { recovered: records.length - failures.length, failures };
    });
  }

  view(job) { return { ok: job.status === 'complete', dspId: job.dspId, action: job.action, status: job.status, phase: job.phase }; }
  list() { return this.journal.all().map(record => ({ dspId: record.id, desiredState: record.desiredState, connected: this.hub.connected(record.id) })); }

  async close() {
    const results = await Promise.allSettled([...this.egress.values(), ...this.bridges.values(), ...this.assistance.values()].map(value => value.close()));
    await this.assistanceQueue?.close();
    this.egress.clear();
    this.bridges.clear();
    this.assistance.clear();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

module.exports = { DirectoryManager };
