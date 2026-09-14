import type { Storage } from '../storage/index.js';
import type { Job, JobStatus } from '../../shared/contracts/index.js';
import { id } from '../../shared/crypto.js';
import { assert } from '../../shared/errors.js';
interface JobRow {
  id: string;
  dsp_id: string;
  environment: Job['environment'];
  kind: Job['kind'];
  status: JobStatus;
  progress: number;
  message: string;
  attempt: number;
  max_attempts: number;
  available_at: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  release: string;
  actor_id: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  connection_revision: number;
}
export class Queue {
  constructor(readonly storage: Storage) {}
  private public(row: JobRow): Job {
    return {
      id: row.id,
      dspId: row.dsp_id,
      dspName:
        this.storage.platform.one<{ name: string }>('SELECT name FROM dsps WHERE id=?', row.dsp_id)
          ?.name ?? 'Unknown DSP',
      environment: row.environment,
      kind: row.kind,
      status: row.status,
      progress: row.progress,
      message: row.message,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      availableAt: new Date(row.available_at).toISOString(),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      release: row.release,
      actorId: row.actor_id,
    };
  }
  enqueue(dspId: string, actorId: string | null, key = id('request')) {
    const dsp = this.storage.platform.one<{ status: string; environment: string }>(
      'SELECT status,environment FROM dsps WHERE id=?',
      dspId,
    );
    assert(
      dsp?.status === 'active' && dsp.environment === this.storage.config.environment,
      'dsp_unavailable',
      409,
    );
    const connection = this.storage.dsp(dspId, (db) =>
      db.one<{ enabled: number; revision: number }>(
        "SELECT enabled,revision FROM connections WHERE provider='paycom'",
      ),
    );
    assert(connection?.enabled, 'connection_required', 409);
    const jobId = id('job'),
      now = Date.now();
    this.storage.jobs.transaction(() => {
      if (
        this.storage.jobs.one(
          'SELECT id FROM jobs WHERE dsp_id=? AND idempotency_key=?',
          dspId,
          key,
        )
      )
        return;
      assert(
        this.storage.jobs.one<{ count: number }>(
          "SELECT count(*) count FROM jobs WHERE dsp_id=? AND status IN ('queued','running','waiting_verification')",
          dspId,
        )!.count < 5,
        'queue_full',
        429,
      );
      this.storage.jobs.run(
        "INSERT INTO jobs(id,dsp_id,environment,kind,status,available_at,created_at,release,actor_id,connection_revision,idempotency_key) VALUES (?,?,?,'paycom.collect','queued',?,?,?,?,?,?)",
        jobId,
        dspId,
        this.storage.config.environment,
        now,
        new Date(now).toISOString(),
        this.storage.config.release,
        actorId,
        connection.revision,
        key,
      );
    });
    return this.public(
      this.storage.jobs.one<JobRow>(
        'SELECT * FROM jobs WHERE dsp_id=? AND idempotency_key=?',
        dspId,
        key,
      )!,
    );
  }
  list(dspId?: string): Job[] {
    return this.storage.jobs
      .all<JobRow>(
        `SELECT * FROM jobs ${dspId ? 'WHERE dsp_id=?' : ''} ORDER BY created_at DESC LIMIT 200`,
        ...(dspId ? [dspId] : []),
      )
      .map((row) => this.public(row));
  }
  get(jobId: string, dspId?: string) {
    const row = this.storage.jobs.one<JobRow>(
      `SELECT * FROM jobs WHERE id=? ${dspId ? 'AND dsp_id=?' : ''}`,
      ...(dspId ? [jobId, dspId] : [jobId]),
    );
    assert(row, 'job_not_found', 404);
    return this.public(row);
  }
  row(jobId: string) {
    const row = this.storage.jobs.one<JobRow>('SELECT * FROM jobs WHERE id=?', jobId);
    assert(row, 'job_not_found', 404);
    return row;
  }
  claim(owner: string, eligible: (dspId: string) => boolean = () => true): Job | null {
    return this.storage.jobs.transaction(() => {
      const count = this.storage.jobs.one<{ n: number }>(
        "SELECT count(*) n FROM jobs WHERE status IN ('running','waiting_verification')",
      )!.n;
      if (count >= this.storage.config.browserCapacity) return null;
      const row = this.storage.jobs
        .all<JobRow>(
          `SELECT * FROM jobs j WHERE j.status='queued' AND j.available_at<=? AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.dsp_id=j.dsp_id AND active.status IN ('running','waiting_verification')) ORDER BY (SELECT COALESCE(MAX(completed_at),'') FROM jobs previous WHERE previous.dsp_id=j.dsp_id),j.created_at LIMIT 200`,
          Date.now(),
        )
        .find((job) => eligible(job.dsp_id));
      if (!row) return null;
      const now = new Date().toISOString();
      this.storage.jobs.run(
        "UPDATE jobs SET status='running',attempt=attempt+1,started_at=?,lease_owner=?,lease_until=?,message='Starting collection' WHERE id=?",
        now,
        owner,
        Date.now() + this.storage.config.jobLeaseMs,
        row.id,
      );
      return this.get(row.id);
    });
  }
  heartbeat(jobId: string, owner: string) {
    const r = this.storage.jobs.run(
      "UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=? AND status IN ('running','waiting_verification')",
      Date.now() + this.storage.config.jobLeaseMs,
      jobId,
      owner,
    );
    assert(r.changes === 1, 'job_cancelled', 409);
  }
  progress(
    jobId: string,
    owner: string,
    progress: number,
    message: string,
    status: JobStatus = 'running',
  ) {
    this.storage.jobs.run(
      "UPDATE jobs SET progress=?,message=?,status=? WHERE id=? AND lease_owner=? AND status IN ('running','waiting_verification')",
      Math.min(99, Math.max(0, Math.floor(progress))),
      message,
      status,
      jobId,
      owner,
    );
  }
  finish(jobId: string, owner: string, error?: string) {
    this.storage.jobs.transaction(() => {
      const row = this.row(jobId);
      if (row.lease_owner !== owner || !['running', 'waiting_verification'].includes(row.status))
        return;
      const retry =
        error &&
        ['browser_lost', 'provider_timeout', 'provider_unavailable'].includes(error) &&
        row.attempt < row.max_attempts;
      this.storage.jobs.run(
        'UPDATE jobs SET status=?,progress=?,message=?,error=?,completed_at=?,available_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?',
        retry ? 'queued' : error ? 'failed' : 'succeeded',
        error ? row.progress : 100,
        retry ? 'Retry scheduled' : error ? 'Collection could not finish' : 'Collection completed',
        error ?? null,
        retry ? null : new Date().toISOString(),
        Date.now() + 30_000 * 2 ** row.attempt,
        jobId,
      );
    });
  }
  cancel(jobId: string, dspId: string) {
    this.get(jobId, dspId);
    this.storage.jobs.run(
      "UPDATE jobs SET status='cancelled',message='Cancelled',completed_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND dsp_id=? AND status IN ('queued','running','waiting_verification')",
      new Date().toISOString(),
      jobId,
      dspId,
    );
    return this.get(jobId, dspId);
  }
  recover() {
    return this.storage.jobs.run(
      `UPDATE jobs SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'queued' END,message='Recovered interrupted collection',error='worker_interrupted',available_at=?,lease_owner=NULL,lease_until=NULL WHERE status IN ('running','waiting_verification') AND lease_until<?`,
      Date.now(),
      Date.now(),
    ).changes;
  }
}
