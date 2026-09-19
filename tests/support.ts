// Test files import the shared server fixture from here; tooling imports the same module directly.
export * from '../tooling/fixture-server.js';
import assert from 'node:assert/strict';
import type { fixture } from '../tooling/fixture-server.js';

/** Seed an older release's queued job to check cancellation, metrics and fairness. */
export function seedQueuedJob(
  f: Pick<Awaited<ReturnType<typeof fixture>>, 'database'>,
  sourceId: string,
  id: string,
) {
  f.database('data/preview/jobs.sqlite', (db) => {
    const inserted = db
      .prepare(
        `INSERT INTO jobs
      (id,dsp_id,environment,kind,status,available_at,created_at,release,actor_id,connection_revision,idempotency_key,request)
      SELECT ?,dsp_id,environment,kind,'queued',?,?,release,actor_id,connection_revision,?,request
      FROM jobs WHERE id=?`,
      )
      .run(id, Date.now(), new Date().toISOString(), id, sourceId);
    assert.equal(Number(inserted.changes), 1);
  });
  return { id };
}
