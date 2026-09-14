import fs from 'node:fs';
import path from 'node:path';
import { configuration } from '../services/config.js';
import { Runtime } from '../services/runtime.js';
import { seed } from './seed.js';
import { ReleaseService } from '../services/releases/index.js';
import { backupState, restoreState } from '../services/storage/backup.js';
import { assert } from '../shared/errors.js';
const [command, ...args] = process.argv.slice(2);
if (command === 'restore') {
  assert(args[0] && args[1], 'usage_restore_source_empty_target');
  process.stdout.write(
    JSON.stringify(restoreState(path.resolve(args[0]), path.resolve(args[1]))) + '\n',
  );
} else if (command === 'backup') {
  assert(args[0] && process.env.DISPATCH_STATE_ROOT, 'usage_backup_destination_and_state_root');
  process.stdout.write(
    JSON.stringify(await backupState(process.env.DISPATCH_STATE_ROOT, path.resolve(args[0]))) +
      '\n',
  );
} else if (
  [
    'seed',
    'bootstrap',
    'release-import',
    'release-plan',
    'initialize',
    'release-recover',
    'status',
  ].includes(command ?? '')
) {
  const runtime = new Runtime(configuration());
  try {
    const releases = new ReleaseService(runtime.storage, runtime.audit);
    if (command === 'seed') await seed(runtime);
    if (command === 'bootstrap') {
      assert(
        args[0] && args[1] && !runtime.storage.platform.one('SELECT id FROM users LIMIT 1'),
        'usage_bootstrap_email_name_empty_platform',
      );
      assert(!process.stdin.isTTY, 'password_required_on_stdin');
      const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      const owner = await runtime.accounts.createUser(args[0], args[1], password, true);
      runtime.dsps.create('Dev DSP', 'UTC', owner.id, true);
    }
    if (command === 'release-import') {
      assert(args[0], 'artifact_path_required');
      process.stdout.write(
        releases.register(path.resolve(args[0]), args.slice(1).join(' ')) + '\n',
      );
    }
    if (command === 'release-plan') {
      assert(
        args[0] && (args[1] === 'preview' || args[1] === 'production'),
        'usage_release_plan_digest_environment',
      );
      process.stdout.write(JSON.stringify(releases.plan(args[0], args[1]), null, 2) + '\n');
    }
    if (command === 'initialize') {
      assert(args[0] && args[1], 'usage_initialize_artifact_owner_email');
      const owner = runtime.storage.platform.one<{ id: string }>(
        "SELECT id FROM users WHERE email=? AND platform_owner=1 AND status='active'",
        args[1],
      );
      assert(owner, 'platform_owner_required');
      process.stdout.write(
        JSON.stringify(releases.initialize(path.resolve(args[0]), owner.id)) + '\n',
      );
    }
    if (command === 'release-recover') {
      assert(
        args[0] && args[1] && runtime.config.allowDeployment,
        'usage_release_recover_receipt_directory_request_id',
      );
      const { lockAlive } = await import('../services/storage/lock.js');
      for (const env of ['preview', 'production'] as const)
        assert(
          !lockAlive(path.join(runtime.storage.paths.environment(env), 'api.lock')),
          'stop_services_before_recovery',
          409,
        );
      assert(
        !lockAlive(path.join(runtime.storage.paths.platform, 'supervisor.lock')),
        'stop_supervisor_before_recovery',
        409,
      );
      const request = runtime.storage.platform.one<{ digest: string; environment: string }>(
        "SELECT * FROM deployment_requests WHERE id=? AND status='running'",
        args[1],
      );
      assert(request, 'interrupted_request_required');
      const receipt = JSON.parse(
        fs.readFileSync(path.join(path.resolve(args[0]), 'receipt.json'), 'utf8'),
      );
      assert(
        receipt.digest === request.digest && receipt.environment === request.environment,
        'recovery_receipt_mismatch',
      );
      releases.rollbackFiles(path.resolve(args[0]));
      runtime.storage.platform.run(
        "UPDATE deployment_requests SET status='failed',error='operator_recovery',completed_at=? WHERE id=?",
        new Date().toISOString(),
        args[1],
      );
      runtime.audit.record(null, null, 'release.recovered');
    }
    if (command === 'status')
      process.stdout.write(
        JSON.stringify(
          {
            environment: runtime.config.environment,
            dsps: runtime.storage.platform.all('SELECT name,environment,status FROM dsps'),
            releases: releases.list(),
          },
          null,
          2,
        ) + '\n',
      );
  } finally {
    await runtime.close();
  }
} else
  process.stdout.write(
    'dispatch seed | bootstrap EMAIL NAME < password-file | status | release-import ARTIFACT [NOTES] | release-plan DIGEST preview|production | initialize ARTIFACT OWNER_EMAIL | release-recover RECEIPT_DIRECTORY REQUEST_ID | backup DESTINATION | restore BACKUP EMPTY_TARGET\nSet DISPATCH_STATE_ROOT explicitly for operational commands. Activation requires DISPATCH_ENABLE_DEPLOYMENT=1.\n',
  );
