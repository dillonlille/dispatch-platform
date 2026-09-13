'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  cleanupStage, fsyncDirectory, privateDirectory, privateFile, readPublished,
} = require('./artifacts');
const { fail } = require('./validation');
const { periodFromWeek } = require('./periods');

const SCHEMA_VERSION = 1;

class CdfStore {
  constructor(database, { artifactRoot, stagingRoot, readOnly = false } = {}) {
    this.database = path.resolve(database);
    this.artifactRoot = path.resolve(artifactRoot);
    this.stagingRoot = path.resolve(stagingRoot);
    privateDirectory(path.dirname(this.database), { create: !readOnly });
    if (!fs.existsSync(this.database) && readOnly) fail('not_initialized');
    if (!fs.existsSync(this.database)) privateFile(this.database, { create: true });
    else privateFile(this.database);
    if (readOnly) {
      privateDirectory(this.artifactRoot, { create: false });
      privateDirectory(this.stagingRoot, { create: false });
    } else {
      privateDirectory(this.artifactRoot);
      privateDirectory(this.stagingRoot);
    }
    this.db = new DatabaseSync(this.database, { readOnly });
    if (readOnly) {
      this.db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('SELECT version FROM schema_meta').get()?.version;
      if (version !== SCHEMA_VERSION) fail('schema_invalid');
    } else {
      this.db.exec(`
        PRAGMA foreign_keys=ON;
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL CHECK(version=1));
        INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
        CREATE TABLE IF NOT EXISTS collections(
          id TEXT PRIMARY KEY,
          week TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK(attempt >= 1),
          collected_at TEXT NOT NULL,
          station TEXT NOT NULL,
          company_id TEXT NOT NULL,
          dsp TEXT NOT NULL,
          manifest_sha256 TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          provider_sha256 TEXT NOT NULL,
          source_bytes INTEGER NOT NULL CHECK(source_bytes >= 1),
          source_row_count INTEGER NOT NULL CHECK(source_row_count >= 0),
          source_column_count INTEGER NOT NULL CHECK(source_column_count >= 1),
          provider_bytes INTEGER NOT NULL CHECK(provider_bytes >= 1),
          provider_row_count INTEGER NOT NULL CHECK(provider_row_count >= 0),
          provider_status TEXT NOT NULL CHECK(provider_status IN('ready','degraded')),
          artifact_relative TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          UNIQUE(week,id)
        );
        CREATE TABLE IF NOT EXISTS active_collections(
          week TEXT PRIMARY KEY,
          collection_id TEXT NOT NULL UNIQUE REFERENCES collections(id),
          activated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS collections_by_week_time ON collections(week,collected_at DESC);
      `);
      const version = this.db.prepare('SELECT version FROM schema_meta').get()?.version;
      if (version !== SCHEMA_VERSION) fail('schema_invalid');
    }
    privateFile(this.database);
  }

  active(week) {
    periodFromWeek(week);
    return this.db.prepare(`
      SELECT c.*,a.week active_week,a.activated_at FROM active_collections a
      JOIN collections c ON c.id=a.collection_id AND c.week=a.week WHERE a.week=?
    `).get(week) || null;
  }

  publish(stage, { replace = false, assertCurrent = () => {} } = {}) {
    if (typeof replace !== 'boolean' || typeof assertCurrent !== 'function') fail('invalid_request');
    const staged = readPublished(stage.directory);
    assertCurrent();
    let { manifest } = staged;
    const active = this.active(manifest.week);
    if (active?.id === manifest.collectionDigest) {
      cleanupStage(stage, this.stagingRoot);
      const audit = this.audit(manifest.week);
      if (!audit.verified) fail(audit.code);
      assertCurrent();
      return { disposition: 'no_change', collectionId: active.id, audit };
    }
    if (active && !replace) {
      cleanupStage(stage, this.stagingRoot);
      fail('week_already_loaded');
    }
    const weekRoot = path.join(this.artifactRoot, manifest.week);
    const weekRootExisted = fs.existsSync(weekRoot);
    privateDirectory(weekRoot);
    if (!weekRootExisted) fsyncDirectory(this.artifactRoot);
    const destination = path.join(weekRoot, manifest.collectionDigest);
    let moved = false;
    if (fs.existsSync(destination)) {
      const existing = readPublished(destination);
      if (existing.manifest.collectionDigest !== manifest.collectionDigest) fail('artifact_identity_mismatch');
      manifest = existing.manifest;
      cleanupStage(stage, this.stagingRoot);
    } else {
      if (fs.lstatSync(stage.directory).dev !== fs.lstatSync(weekRoot).dev) fail('staging_not_same_filesystem');
      fs.renameSync(stage.directory, destination);
      fsyncDirectory(weekRoot);
      fsyncDirectory(this.stagingRoot);
      moved = true;
    }
    const relative = path.relative(this.artifactRoot, destination).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) fail('artifact_path_invalid');
    let inserted = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertion = this.db.prepare(`INSERT OR IGNORE INTO collections(
        id,week,run_id,attempt,collected_at,station,company_id,dsp,manifest_sha256,source_sha256,provider_sha256,
        source_bytes,source_row_count,source_column_count,provider_bytes,provider_row_count,
        provider_status,artifact_relative,manifest_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        manifest.collectionDigest, manifest.week, manifest.runId, manifest.attempt, manifest.collectedAt,
        manifest.station, manifest.companyId, manifest.dsp, manifest.manifestSha256, manifest.source.sha256, manifest.providerLinks.sha256,
        manifest.source.bytes, manifest.source.rowCount, manifest.source.columnCount,
        manifest.providerLinks.bytes, manifest.providerLinks.rowCount, manifest.providerLinks.status,
        relative, JSON.stringify(manifest),
      );
      inserted = Number(insertion.changes) === 1;
      const found = this.db.prepare(`SELECT id,run_id,attempt,collected_at,station,company_id,dsp,
        manifest_sha256,source_sha256,provider_sha256,manifest_json,
        source_bytes,source_row_count,source_column_count,provider_bytes,provider_row_count,
        provider_status,artifact_relative FROM collections WHERE id=? AND week=?`).get(manifest.collectionDigest, manifest.week);
      if (!found || found.run_id !== manifest.runId || found.attempt !== manifest.attempt
          || found.collected_at !== manifest.collectedAt || found.station !== manifest.station
          || found.company_id !== manifest.companyId || found.dsp !== manifest.dsp
          || found.manifest_sha256 !== manifest.manifestSha256
          || found.source_sha256 !== manifest.source.sha256 || found.provider_sha256 !== manifest.providerLinks.sha256
          || found.source_bytes !== manifest.source.bytes || found.source_row_count !== manifest.source.rowCount
          || found.source_column_count !== manifest.source.columnCount || found.provider_bytes !== manifest.providerLinks.bytes
          || found.provider_row_count !== manifest.providerLinks.rowCount || found.provider_status !== manifest.providerLinks.status
          || found.artifact_relative !== relative || found.manifest_json !== JSON.stringify(manifest)) fail('publication_failed');
      assertCurrent();
      this.db.prepare(`INSERT INTO active_collections(week,collection_id,activated_at) VALUES(?,?,?)
        ON CONFLICT(week) DO UPDATE SET collection_id=excluded.collection_id,activated_at=excluded.activated_at`)
        .run(manifest.week, manifest.collectionDigest, new Date().toISOString());
      assertCurrent();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      if (moved) {
        fs.rmSync(destination, { recursive: true, force: true });
        fsyncDirectory(weekRoot);
      }
      throw error;
    }
    const audit = this.audit(manifest.week);
    if (!audit.verified) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.db.prepare('SELECT collection_id FROM active_collections WHERE week=?').get(manifest.week);
        if (current?.collection_id === manifest.collectionDigest) {
          if (active) {
            this.db.prepare('UPDATE active_collections SET collection_id=?,activated_at=? WHERE week=?')
              .run(active.id, active.activated_at, manifest.week);
          } else this.db.prepare('DELETE FROM active_collections WHERE week=?').run(manifest.week);
        }
        if (inserted) this.db.prepare('DELETE FROM collections WHERE id=?').run(manifest.collectionDigest);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      if (moved) {
        fs.rmSync(destination, { recursive: true, force: true });
        fsyncDirectory(weekRoot);
      }
      fail('publication_verification_failed');
    }
    return { disposition: 'published', collectionId: manifest.collectionDigest, audit };
  }

  audit(week) {
    periodFromWeek(week);
    const active = this.active(week);
    if (!active) return { verified: false, code: 'week_not_loaded', week };
    const relative = active.artifact_relative;
    const directory = path.resolve(this.artifactRoot, relative);
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)
        || path.relative(this.artifactRoot, directory).startsWith('..')) {
      return { verified: false, code: 'artifact_path_invalid', week };
    }
    try {
      const artifacts = readPublished(directory);
      const manifest = artifacts.manifest;
      const quick = this.db.prepare('PRAGMA quick_check').get()?.quick_check;
      const foreignKeyErrors = this.db.prepare('PRAGMA foreign_key_check').all().length;
      const candidateFree = fs.readdirSync(this.stagingRoot).length === 0;
      const matches = active.active_week === week && active.week === week
        && manifest.collectionDigest === active.id && manifest.week === week
        && manifest.runId === active.run_id && manifest.attempt === active.attempt
        && manifest.collectedAt === active.collected_at && manifest.station === active.station
        && manifest.companyId === active.company_id && manifest.dsp === active.dsp
        && manifest.manifestSha256 === active.manifest_sha256
        && manifest.source.sha256 === active.source_sha256
        && manifest.providerLinks.sha256 === active.provider_sha256
        && manifest.source.bytes === active.source_bytes
        && manifest.source.rowCount === active.source_row_count
        && manifest.source.columnCount === active.source_column_count
        && manifest.providerLinks.bytes === active.provider_bytes
        && manifest.providerLinks.rowCount === active.provider_row_count
        && manifest.providerLinks.status === active.provider_status
        && active.artifact_relative === `${manifest.week}/${manifest.collectionDigest}`
        && active.manifest_json === JSON.stringify(manifest);
      const verified = quick === 'ok' && foreignKeyErrors === 0 && candidateFree && matches;
      return {
        verified,
        code: verified ? 'verified' : 'integrity_failed',
        week,
        collectionId: active.id,
        rowCount: active.source_row_count,
        columnCount: active.source_column_count,
        providerLinkCount: active.provider_row_count,
        providerLinks: active.provider_status,
        quickCheck: quick,
        foreignKeyErrors,
        candidateFree,
      };
    } catch {
      return { verified: false, code: 'artifact_invalid', week };
    }
  }

  health() {
    const quick = this.db.prepare('PRAGMA quick_check').get()?.quick_check;
    const foreignKeyErrors = this.db.prepare('PRAGMA foreign_key_check').all().length;
    const weeks = this.db.prepare('SELECT week FROM active_collections ORDER BY week').all().map(row => row.week);
    const failed = weeks.map(week => this.audit(week)).filter(result => !result.verified);
    const candidateFree = fs.readdirSync(this.stagingRoot).length === 0;
    return {
      ready: quick === 'ok' && foreignKeyErrors === 0 && failed.length === 0 && candidateFree,
      schemaVersion: this.db.prepare('SELECT version FROM schema_meta').get()?.version,
      quickCheck: quick,
      foreignKeyErrors,
      activeWeeks: weeks.length,
      failedWeeks: failed.length,
      candidateFree,
    };
  }

  close() { this.db.close(); }
}

module.exports = { CdfStore, SCHEMA_VERSION };
