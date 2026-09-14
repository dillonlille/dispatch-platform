import fs from 'node:fs';
import path from 'node:path';
import type { Storage } from '../storage/index.js';
import type { Audit } from '../audit/index.js';
import type { Environment, ReleaseSummary } from '../../shared/contracts/index.js';
import { assert } from '../../shared/errors.js';
import { id } from '../../shared/crypto.js';
import { privateDirectory, atomicPrivateWrite } from '../storage/paths.js';
import { verifyArtifact, managed } from './artifact.js';
import { lockAlive } from '../storage/lock.js';
export class ReleaseService {
  constructor(
    readonly storage: Storage,
    readonly audit: Audit,
  ) {}
  register(source: string, notes = '') {
    const manifest = verifyArtifact(source),
      directory = privateDirectory(path.join(this.storage.paths.platform, 'releases'));
    const dest = path.join(directory, manifest.digest);
    if (!fs.existsSync(dest)) {
      const temp = path.join(directory, id('import'));
      fs.cpSync(source, temp, { recursive: true, dereference: false });
      verifyArtifact(temp);
      fs.renameSync(temp, dest);
    }
    assert(verifyArtifact(dest).digest === manifest.digest, 'artifact_inventory_changed');
    this.storage.platform.run(
      'INSERT OR IGNORE INTO releases(digest,version,artifact,notes,created_at) VALUES (?,?,?,?,?)',
      manifest.digest,
      manifest.version,
      dest,
      notes.slice(0, 1000),
      new Date().toISOString(),
    );
    return manifest.digest;
  }
  list(): ReleaseSummary[] {
    return this.storage.platform
      .all<ReleaseSummary>(
        "SELECT r.digest,r.version,r.created_at createdAt,r.tested_at testedAt,r.notes,EXISTS(SELECT 1 FROM deployments d WHERE d.environment='production' AND d.digest=r.digest) production,EXISTS(SELECT 1 FROM deployments d WHERE d.environment='preview' AND d.digest=r.digest) preview FROM releases r ORDER BY r.created_at DESC",
      )
      .map((r) => ({ ...r, production: Boolean(r.production), preview: Boolean(r.preview) }));
  }
  markTested(digest: string, actorId: string) {
    const current = this.storage.platform.one<{ digest: string }>(
      "SELECT digest FROM deployments WHERE environment='preview'",
    );
    assert(current?.digest === digest, 'test_current_preview_release', 409);
    this.storage.platform.run(
      'UPDATE releases SET tested_at=?,tested_by=? WHERE digest=?',
      new Date().toISOString(),
      actorId,
      digest,
    );
    this.audit.record(actorId, null, 'release.preview_approved');
  }
  request(digest: string, environment: Environment, actorId: string) {
    assert(this.storage.config.allowDeployment, 'deployment_not_enabled', 409);
    const release = this.storage.platform.one<{ tested_at: string | null; artifact: string }>(
      'SELECT * FROM releases WHERE digest=?',
      digest,
    );
    assert(release, 'release_not_found', 404);
    assert(verifyArtifact(release.artifact).digest === digest, 'artifact_inventory_changed');
    if (environment === 'production') {
      const preview = this.storage.platform.one<{ digest: string }>(
        "SELECT digest FROM deployments WHERE environment='preview'",
      );
      assert(release.tested_at && preview?.digest === digest, 'preview_test_required', 409);
    }
    const requestId = id('deploy');
    this.storage.platform.transaction(() => {
      assert(
        !this.storage.platform.one(
          "SELECT id FROM deployment_requests WHERE status IN ('queued','running')",
        ),
        'deployment_in_progress',
        409,
      );
      this.storage.platform.run(
        "INSERT INTO deployment_requests(id,environment,digest,actor_id,status,created_at) VALUES (?,?,?,?,'queued',?)",
        requestId,
        environment,
        digest,
        actorId,
        new Date().toISOString(),
      );
    });
    this.audit.record(actorId, null, 'release.activation_requested', environment);
    return { id: requestId, status: 'queued' };
  }
  plan(digest: string, environment: Environment) {
    const row = this.storage.platform.one<{ artifact: string }>(
      'SELECT artifact FROM releases WHERE digest=?',
      digest,
    );
    assert(row, 'release_not_found', 404);
    const manifest = verifyArtifact(row.artifact);
    return {
      digest,
      version: manifest.version,
      environment,
      source: row.artifact,
      target:
        environment === 'production'
          ? this.storage.paths.root
          : path.join(this.storage.paths.root, 'preview'),
      managed: [...managed],
      fileCount: manifest.files.length,
    };
  }
  initialize(source: string, actorId: string) {
    assert(this.storage.config.allowDeployment, 'deployment_not_enabled', 409);
    assert(
      !this.storage.platform.one('SELECT environment FROM deployments WHERE digest IS NOT NULL'),
      'platform_already_initialized',
      409,
    );
    assert(
      !this.storage.platform.one('SELECT id FROM dsps WHERE permanent=0'),
      'initial_setup_requires_empty_fleet',
      409,
    );
    for (const environment of ['production', 'preview'])
      assert(
        !lockAlive(
          path.join(this.storage.paths.environment(environment as Environment), 'api.lock'),
        ),
        'stop_services_before_activation',
        409,
      );
    const digest = this.register(source, 'Initial platform baseline'),
      receipts: string[] = [];
    try {
      for (const env of ['preview', 'production'] as const)
        receipts.push(this.installFiles(digest, env).backup);
      this.storage.platform.run(
        'UPDATE deployments SET digest=?,revision=revision+1,updated_at=?',
        digest,
        new Date().toISOString(),
      );
      this.audit.record(actorId, null, 'release.initialized');
    } catch (error) {
      for (const receipt of receipts.reverse()) this.rollbackFiles(receipt);
      throw error;
    }
    return { digest, started: false };
  }
  /** Called only by the supervisor after stopping the target API/workers. */
  installFiles(digest: string, environment: Environment) {
    assert(this.storage.config.allowDeployment, 'deployment_not_enabled', 409);
    const plan = this.plan(digest, environment);
    const target = privateDirectory(plan.target),
      backup = privateDirectory(
        path.join(this.storage.paths.platform, 'activation-backups', id('activation')),
      );
    const staging = privateDirectory(
      path.join(this.storage.paths.platform, 'activation-staging', id('stage')),
    );
    fs.cpSync(plan.source, staging, { recursive: true });
    verifyArtifact(staging);
    const steps = managed.map((name) => ({
      name,
      hadPrevious: Boolean(fs.lstatSync(path.join(target, name), { throwIfNoEntry: false })),
    }));
    const receipt = { digest, environment, target, steps };
    // Intent precedes the first rename, allowing an interrupted activation to be
    // recovered without guessing which directories reached their new version.
    atomicPrivateWrite(path.join(backup, 'receipt.json'), JSON.stringify(receipt));
    const moved: string[] = [];
    const installed: string[] = [];
    try {
      for (const name of managed) {
        const dest = path.join(target, name),
          next = path.join(staging, name);
        if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
          assert(!fs.lstatSync(dest).isSymbolicLink(), 'deployment_target_symlink');
          fs.renameSync(dest, path.join(backup, name));
          moved.push(name);
        }
        if (fs.existsSync(next)) {
          fs.renameSync(next, dest);
          installed.push(name);
        }
      }
    } catch (error) {
      for (const name of installed)
        fs.rmSync(path.join(target, name), { recursive: true, force: true });
      for (const name of moved) fs.renameSync(path.join(backup, name), path.join(target, name));
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return { backup, target, digest, environment };
  }
  rollbackFiles(backup: string) {
    assert(
      path
        .resolve(backup)
        .startsWith(path.join(this.storage.paths.platform, 'activation-backups') + path.sep) &&
        fs.realpathSync(backup) === path.resolve(backup),
      'invalid_rollback_path',
    );
    const receipt = JSON.parse(fs.readFileSync(path.join(backup, 'receipt.json'), 'utf8')) as {
      target: string;
      steps: { name: string; hadPrevious: boolean }[];
    };
    assert(
      receipt.target === this.storage.paths.root ||
        receipt.target === path.join(this.storage.paths.root, 'preview'),
      'invalid_rollback_target',
    );
    for (const step of receipt.steps) {
      assert(
        managed.includes(step.name as (typeof managed)[number]) &&
          typeof step.hadPrevious === 'boolean',
        'invalid_rollback_receipt',
      );
      const previous = path.join(backup, step.name),
        dest = path.join(receipt.target, step.name);
      if (fs.existsSync(previous)) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(previous, dest);
      } else if (!step.hadPrevious) fs.rmSync(dest, { recursive: true, force: true });
    }
  }
  complete(requestId: string) {
    this.storage.platform.transaction(() => {
      const row = this.storage.platform.one<{
        environment: Environment;
        digest: string;
        actor_id: string;
      }>("SELECT * FROM deployment_requests WHERE id=? AND status='running'", requestId);
      assert(row, 'deployment_request_changed', 409);
      this.storage.platform.run(
        'UPDATE deployments SET digest=?,revision=revision+1,updated_at=? WHERE environment=?',
        row.digest,
        new Date().toISOString(),
        row.environment,
      );
      if (row.environment === 'preview')
        this.storage.platform.run('UPDATE releases SET tested_at=NULL,tested_by=NULL');
      this.storage.platform.run(
        "UPDATE deployment_requests SET status='succeeded',completed_at=? WHERE id=?",
        new Date().toISOString(),
        requestId,
      );
      this.audit.record(row.actor_id, null, 'release.activated', row.environment);
    });
  }
}
