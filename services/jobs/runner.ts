import type { Storage } from '../storage/index.js';
import type { Accounts, DspRow } from '../accounts/index.js';
import { publicDsp } from '../accounts/index.js';
import type { Audit } from '../audit/index.js';
import type { AuthBroker } from '../auth-broker/index.js';
import { Queue } from './queue.js';
import { nextOccurrence, Schedules } from './schedule.js';
import { WorkforceStore } from '../../integrations/paycom/workforce.js';
import { AppError, assert, safeError } from '../../shared/errors.js';
import { id } from '../../shared/crypto.js';
import type { Job } from '../../shared/contracts/index.js';
export class Runner {
  readonly queue: Queue;
  readonly schedules: Schedules;
  readonly workforce: WorkforceStore;
  private owner = id('worker');
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private active = new Map<string, Promise<void>>();
  constructor(
    readonly storage: Storage,
    readonly broker: AuthBroker,
    readonly audit: Audit,
  ) {
    this.queue = new Queue(storage);
    this.schedules = new Schedules(storage);
    this.workforce = new WorkforceStore(storage);
  }
  start() {
    this.queue.recover();
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
    void this.tick();
  }
  guard(job: Job) {
    const row = this.queue.row(job.id);
    assert(
      row.lease_owner === this.owner && ['running', 'waiting_verification'].includes(row.status),
      'job_cancelled',
      409,
    );
    const dsp = this.storage.platform.one<DspRow>('SELECT * FROM dsps WHERE id=?', job.dspId);
    assert(
      dsp?.status === 'active' && dsp.environment === this.storage.config.environment,
      'dsp_unavailable',
      409,
    );
    if (job.actorId) {
      const actor = this.storage.platform.one<{ status: string; platform_owner: number }>(
        'SELECT status,platform_owner FROM users WHERE id=?',
        job.actorId,
      );
      const role = this.storage.platform.one<{ role: string }>(
        'SELECT role FROM memberships WHERE user_id=? AND dsp_id=?',
        job.actorId,
        job.dspId,
      )?.role;
      assert(
        actor?.status === 'active' &&
          (actor.platform_owner || role === 'owner' || role === 'manager'),
        'permission_denied',
        403,
      );
    }
    const connection = this.storage.dsp(job.dspId, (db) =>
      db.one<{ enabled: number; revision: number }>(
        "SELECT enabled,revision FROM connections WHERE provider='paycom'",
      ),
    );
    assert(
      connection?.enabled && connection.revision === row.connection_revision,
      'connection_changed',
      409,
    );
    return publicDsp(dsp);
  }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      this.queue.recover();
      const dsps = this.storage.platform.all<DspRow>(
        "SELECT * FROM dsps WHERE status='active' AND environment=?",
        this.storage.config.environment,
      );
      for (const row of dsps) {
        const schedule = this.schedules.get(row.id);
        if (!schedule.enabled) continue;
        const next = schedule.nextRun ?? nextOccurrence(schedule.localTime, schedule.timezone);
        if (!schedule.nextRun)
          this.storage.dsp(row.id, (db) => db.run('UPDATE schedules SET next_run=?', next));
        if (next > new Date().toISOString()) continue;
        try {
          this.queue.enqueue(row.id, null, `schedule:${next}`);
          this.storage.dsp(row.id, (db) =>
            db.run(
              'UPDATE schedules SET next_run=?',
              nextOccurrence(schedule.localTime, schedule.timezone),
            ),
          );
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
      while (this.active.size < this.storage.config.browserCapacity) {
        const job = this.queue.claim(this.owner, (dspId) => {
          const session = this.broker.browsers.sessions.get(dspId);
          return session
            ? session.status === 'ready' || session.status === 'challenge'
            : this.broker.browsers.health().active < this.storage.config.browserCapacity;
        });
        if (!job) break;
        const task = this.execute(job).finally(() => this.active.delete(job.id));
        this.active.set(job.id, task);
      }
    } finally {
      this.ticking = false;
    }
  }
  private async execute(job: Job) {
    const heartbeat = setInterval(
      () => {
        try {
          this.guard(job);
          this.queue.heartbeat(job.id, this.owner);
        } catch {
          void this.broker.browsers.revoke(job.dspId);
        }
      },
      Math.min(5000, this.storage.config.jobLeaseMs / 3),
    );
    try {
      const dsp = this.guard(job),
        session = await this.broker.ensure(dsp);
      if (session.status === 'challenge') {
        this.queue.progress(
          job.id,
          this.owner,
          5,
          'Waiting for owner verification',
          'waiting_verification',
        );
        await new Promise<void>((resolve, reject) => {
          const event = (value: { type: string }) => {
            if (value.type === 'ready') {
              cleanup();
              resolve();
            }
          };
          const closed = () => {
            cleanup();
            reject(new AppError('verification_expired', 409));
          };
          const cleanup = () => {
            session.off('event', event);
            session.off('closed', closed);
          };
          session.on('event', event);
          session.on('closed', closed);
        });
      }
      this.guard(job);
      this.queue.progress(job.id, this.owner, 10, 'Collecting workforce');
      const data = await session.collect((progress, message) => {
        this.guard(job);
        this.queue.progress(job.id, this.owner, progress, message);
      });
      this.guard(job);
      this.workforce.publish(job.dspId, data, () => this.guard(job));
      this.queue.finish(job.id, this.owner);
      this.audit.record(job.actorId, job.dspId, 'collection.completed');
    } catch (error) {
      this.queue.finish(job.id, this.owner, safeError(error));
      this.audit.record(job.actorId, job.dspId, 'collection.failed', safeError(error));
    } finally {
      clearInterval(heartbeat);
      await this.broker.browsers.revoke(job.dspId);
    }
  }
  async cancel(jobId: string, dspId: string) {
    const job = this.queue.cancel(jobId, dspId);
    if (this.active.has(jobId)) await this.broker.browsers.revoke(dspId);
    return job;
  }
  async revokeDsp(dspId: string) {
    for (const job of this.queue.list(dspId))
      if (['queued', 'running', 'waiting_verification'].includes(job.status))
        this.queue.cancel(job.id, dspId);
    await this.broker.browsers.revoke(dspId);
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.broker.browsers.close();
    await Promise.allSettled(this.active.values());
  }
}
