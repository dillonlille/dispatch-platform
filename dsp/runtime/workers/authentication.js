'use strict';
const path = require('node:path');
const { CredentialVault, ensurePrivateDirectory } = require('../auth-broker/src/vault');
const { BrowserSessionManager } = require('../auth-broker/src/session-manager');
const { ChromeBrowserRuntime } = require('../auth-broker/src/browser-runtime');
const { AttemptGuard } = require('../auth-broker/src/attempt-guard');
const { AuthenticationDiagnostics } = require('../auth-broker/src/authentication-diagnostics');
const { acquireMaintenanceLock } = require('../auth-broker/src/maintenance-lock');

// This class runs inside the DSP authentication worker. Core passes connection
// references over the worker transport; it never imports or instantiates this
// class in its own process. The host supplies paths and the reviewed adapter.
class AuthenticationWorker {
  constructor({ paths, adapter, profile, pluginId, jobId, ttlMs = 90000, browserRuntime = null, assistance = null }) {
    if (typeof adapter?.authenticate !== 'function' || !/^[a-z][a-z0-9_-]{0,47}$/.test(profile)
        || !/^[a-z][a-z0-9_.-]{0,63}$/.test(pluginId) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(jobId)
        || !Number.isInteger(ttlMs) || ttlMs < 30000 || ttlMs > 300000) throw new TypeError('authentication_worker_invalid');
    Object.assign(this, { paths, adapter, profile, pluginId, jobId, ttlMs, browserRuntime, assistance });
    this.vault = null; this.sessions = null; this.session = null; this.releaseLock = null;
    this.controller = new AbortController(); this.pending = null; this.closing = null; this.closed = false;
  }
  async start({ signal } = {}) {
    if (this.pending || this.sessions || this.closed) throw new Error('authentication_worker_busy');
    const cancel = () => this.controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    this.pending = (async () => {
      if (this.controller.signal.aborted) throw new Error('acquisition_cancelled');
      ensurePrivateDirectory(this.paths.stateRoot);
      this.releaseLock = acquireMaintenanceLock(this.paths);
      this.vault = new CredentialVault(this.paths, { readOnly: true });
      const metadata = this.vault.status(this.profile);
      if (!metadata.configured || metadata.provider !== this.adapter.provider) throw new Error('profile_not_configured');
      const runtime = this.browserRuntime || new ChromeBrowserRuntime({ stateRoot: this.paths.browserSessions });
      if (runtime.reconcile) await runtime.reconcile();
      this.sessions = new BrowserSessionManager({ vault: this.vault, browserRuntime: runtime,
        adapters: { [this.adapter.provider]: this.adapter }, attemptGuard: new AttemptGuard(this.paths.attempts),
        diagnostics: new AuthenticationDiagnostics(path.join(this.paths.stateRoot, 'authentication-diagnostics.json')),
        browserAssistance: this.assistance, assistancePermitted: id => id === this.pluginId });
      this.session = await this.sessions.acquire({ profile: this.profile, collector: this.pluginId,
        runId: this.jobId, ttlSeconds: Math.ceil(this.ttlMs / 1000) }, { signal: this.controller.signal });
      if (this.controller.signal.aborted) throw new Error('acquisition_cancelled');
      return { ...this.session.browser };
    })();
    try { return await this.pending; }
    catch (error) {
      this.pending = null;
      await this.close();
      throw error;
    } finally { this.pending = null; signal?.removeEventListener('abort', cancel); }
  }
  renew() {
    if (!this.session || this.closed || this.controller.signal.aborted) throw new Error('lease_lost');
    this.sessions.renew(this.session.lease, Math.ceil(this.ttlMs / 1000));
    return { renewed: true };
  }
  async close() {
    if (this.closing) return this.closing;
    this.controller.abort(); this.closed = true;
    this.closing = (async () => {
      if (this.pending) await this.pending.catch(() => {});
      if (this.sessions) {
        await this.sessions.close();
        for (const lease of this.sessions.sessions.keys()) await this.sessions.release(lease, 'revoked');
        if (this.sessions.sessions.size) throw new Error('browser_cleanup_failed');
      }
      this.sessions = null; this.session = null;
      this.vault?.close(); this.vault = null;
      this.releaseLock?.(); this.releaseLock = null;
      return true;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}
module.exports = { AuthenticationWorker };
