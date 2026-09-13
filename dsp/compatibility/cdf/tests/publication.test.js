'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stageCollection } = require('../src/artifacts');
const { CdfStore } = require('../src/store');

const fixtures = path.join(__dirname, "./fixtures");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cdf-publication-'));
  fs.chmodSync(root, 0o700);
  return {
    root,
    database: path.join(root, 'cdf.sqlite3'),
    artifactRoot: path.join(root, 'artifacts'),
    stagingRoot: path.join(root, '.staging'),
  };
}

function stage(paths, { runId, csvBytes, providerBytes }) {
  return stageCollection({
    stagingRoot: paths.stagingRoot,
    runId,
    attempt: 1,
    week: '2026-W20',
    station: 'TST1',
    companyId: 'fixture-company',
    dsp: 'fixture-dsp',
    collectedAt: '2026-08-29T12:00:00.000Z',
    csvBytes,
    providerBytes,
    providerStatus: 'ready',
  });
}

test('artifact publication is immutable, replayable, refresh-gated, and audited', () => {
  const paths = workspace();
  const csv = fs.readFileSync(path.join(fixtures, '2026-W20.csv'));
  const providers = fs.readFileSync(path.join(fixtures, '2026-W20-providers.json'));
  const store = new CdfStore(paths.database, paths);
  try {
    const first = store.publish(stage(paths, { runId: 'run_first', csvBytes: csv, providerBytes: providers }));
    assert.equal(first.disposition, 'published');
    assert.equal(first.audit.verified, true);
    const publicationDirectory = path.join(paths.artifactRoot, '2026-W20', first.collectionId);
    assert.equal(fs.statSync(paths.database).mode & 0o777, 0o600);
    assert.equal(fs.statSync(publicationDirectory).mode & 0o777, 0o700);
    for (const name of ['cdf-negative.csv', 'provider-links.json', 'manifest.json']) {
      assert.equal(fs.statSync(path.join(publicationDirectory, name)).mode & 0o777, 0o600);
    }
    const provenance = store.db.prepare(`SELECT run_id,attempt,collected_at,station,manifest_json
      FROM collections WHERE id=?`).get(first.collectionId);
    store.db.prepare("UPDATE active_collections SET week='2026-W21' WHERE week='2026-W20'").run();
    assert.deepEqual(store.audit('2026-W21'), {
      verified: false, code: 'week_not_loaded', week: '2026-W21',
    });
    store.db.prepare("UPDATE active_collections SET week='2026-W20' WHERE week='2026-W21'").run();
    assert.equal(store.audit('2026-W20').verified, true);
    store.db.prepare(`UPDATE collections SET run_id='tampered',attempt=2,
      collected_at='2026-08-30T00:00:00.000Z',station='ZZZ',manifest_json='{}' WHERE id=?`).run(first.collectionId);
    assert.equal(store.audit('2026-W20').verified, false);
    assert.throws(() => store.publish(stage(paths, { runId: 'run_corrupt_replay', csvBytes: csv, providerBytes: providers })),
      error => error.code === 'integrity_failed');
    store.db.prepare(`UPDATE collections SET run_id=?,attempt=?,collected_at=?,station=?,manifest_json=? WHERE id=?`).run(
      provenance.run_id, provenance.attempt, provenance.collected_at, provenance.station, provenance.manifest_json, first.collectionId,
    );
    assert.equal(store.audit('2026-W20').verified, true);
    const lateBytes = Buffer.from(csv.toString().replace('TBAFIXTURE1', 'TBADEADLINE'));
    let deadlineChecks = 0;
    assert.throws(() => store.publish(
      stage(paths, { runId: 'run_deadline_commit', csvBytes: lateBytes, providerBytes: providers }),
      {
        replace: true,
        assertCurrent: () => {
          deadlineChecks += 1;
          if (deadlineChecks === 3) throw Object.assign(new Error('deadline_exceeded'), { code: 'deadline_exceeded' });
        },
      },
    ), error => error.code === 'deadline_exceeded');
    assert.equal(store.audit('2026-W20').collectionId, first.collectionId);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM collections WHERE week=?').get('2026-W20').count, 1);
    const failedRefreshBytes = Buffer.from(csv.toString().replace('TBAFIXTURE1', 'TBAFAILED'));
    const originalAudit = store.audit;
    store.audit = () => ({ verified: false, code: 'integrity_failed' });
    try {
      assert.throws(() => store.publish(
        stage(paths, { runId: 'run_failed_audit', csvBytes: failedRefreshBytes, providerBytes: providers }),
        { replace: true },
      ), error => error.code === 'publication_verification_failed');
    } finally { store.audit = originalAudit; }
    assert.equal(store.audit('2026-W20').collectionId, first.collectionId);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM collections WHERE week=?').get('2026-W20').count, 1);
    const replay = store.publish(stage(paths, { runId: 'run_replay', csvBytes: csv, providerBytes: providers }));
    assert.equal(replay.disposition, 'no_change');
    const changed = Buffer.from(csv.toString().replace('TBAFIXTURE1', 'TBAFIXTURE2'));
    assert.throws(() => store.publish(stage(paths, { runId: 'run_blocked', csvBytes: changed, providerBytes: providers })),
      error => error.code === 'week_already_loaded');
    assert.equal(store.audit('2026-W20').collectionId, first.collectionId);
    const refreshed = store.publish(stage(paths, { runId: 'run_refresh', csvBytes: changed, providerBytes: providers }), { replace: true });
    assert.equal(refreshed.disposition, 'published');
    assert.notEqual(refreshed.collectionId, first.collectionId);
    assert.equal(store.audit('2026-W20').verified, true);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM collections WHERE week=?').get('2026-W20').count, 2);
    assert.equal(fs.readdirSync(paths.stagingRoot).length, 0);
  } finally {
    store.close();
    assert.equal(fs.existsSync(`${paths.database}-wal`), false);
    assert.equal(fs.existsSync(`${paths.database}-shm`), false);
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});
