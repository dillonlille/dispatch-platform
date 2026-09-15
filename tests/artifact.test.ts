import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Runtime } from '../services/runtime.js';
import { configuration } from '../services/config.js';
import { ReleaseService } from '../services/releases/index.js';
import { writeManifest } from '../services/releases/artifact.js';
import { until } from './helpers.js';
import { fixtureWorkforce } from '../integrations/paycom/fixture.js';
test(
  'built supervisor updates Preview, promotes the exact artifact, and restores code after failed health check',
  { skip: process.env.DISPATCH_TEST_ARTIFACT !== '1', timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-artifact-test-'));
    const runtime = new Runtime(
      configuration({
        stateRoot: root,
        development: true,
        providerMode: 'fixture',
        allowDeployment: true,
        port: 5200,
        origin: 'http://127.0.0.1:5200',
      }),
    );
    const releases = new ReleaseService(runtime.storage, runtime.audit);
    let supervisor: ReturnType<typeof spawn> | undefined;
    try {
      const owner = await runtime.accounts.createUser(
        'test-owner@dispatch.test',
        { firstName: 'Test', lastName: 'Owner' },
        'Artifact-test-password!',
        true,
      );
      const dsp = runtime.dsps.create('Dev DSP', 'UTC', owner.id, true);
      const workforce = fixtureWorkforce(dsp);
      runtime.runner.workforce.publish(dsp.id, workforce);
      // The real updater discards executable bits when extracting tar archives.
      fs.chmodSync(path.resolve('.build/services/rust/dispatch-backend'), 0o600);
      releases.initialize(path.resolve('.build'), owner.id);
      fs.writeFileSync(path.join(root, 'dsps', 'sentinel'), 'private DSP state', { mode: 0o600 });
      supervisor = spawn(process.execPath, [path.resolve('.build/tooling/supervisor.js')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'development',
          DISPATCH_STATE_ROOT: root,
          DISPATCH_PROVIDER_MODE: 'fixture',
          DISPATCH_ENABLE_DEPLOYMENT: '1',
          DISPATCH_ORIGIN: 'http://127.0.0.1:5200',
          PORT: '5200',
        },
      });
      let logs = '';
      supervisor.stderr!.on('data', (chunk) => (logs += chunk.toString()));
      supervisor.stdout!.on('data', () => {});
      const candidate = path.join(root, 'candidate');
      fs.cpSync('.build', candidate, { recursive: true });
      fs.appendFileSync(
        path.join(candidate, 'dashboard/index.html'),
        '\n<!-- release candidate -->',
      );
      const digest = writeManifest(candidate, '0.1.0-dev.1').digest;
      releases.register(candidate);
      const preview = releases.request(digest, 'preview', owner.id);
      const done = (id: string) =>
        runtime.storage.platform.one<{ status: string; error: string }>(
          'SELECT status,error FROM deployment_requests WHERE id=?',
          id,
        )!;
      await until(() => ['succeeded', 'failed'].includes(done(preview.id).status), 60000);
      assert.equal(done(preview.id).status, 'succeeded', logs);
      releases.markTested(digest, owner.id);
      const prod = releases.request(digest, 'production', owner.id);
      await until(() => ['succeeded', 'failed'].includes(done(prod.id).status), 60000);
      assert.equal(done(prod.id).status, 'succeeded', logs);
      const health = (await fetch('http://127.0.0.1:5200/api/health').then((r) => r.json())) as {
        release: string;
      };
      assert.equal(health.release, digest);
      const origin = 'http://127.0.0.1:5200';
      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password: 'Artifact-test-password!' }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const session = (await fetch(`${origin}/api/session`, { headers: { cookie } }).then((r) =>
        r.json(),
      )) as { csrf: string };
      const view = (await fetch(`${origin}/api/session/dsp`, {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/json',
          'x-csrf-token': session.csrf,
        },
        body: JSON.stringify({ dspId: dsp.id }),
      }).then((r) => r.json())) as { token: string };
      const detail = await fetch(`${origin}/api/dsp/employees/${workforce.employees[0]!.code}`, {
        headers: { cookie, 'x-dispatch-view': view.token },
      });
      assert.equal(detail.status, 200);
      assert.deepEqual(
        await detail.json(),
        runtime.runner.workforce.employee(dsp.id, workforce.employees[0]!.code),
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'dsps', 'sentinel'), 'utf8'),
        'private DSP state',
      );
      fs.writeFileSync(
        path.join(candidate, 'services/rust/dispatch-backend'),
        'invalid executable\n',
      );
      const broken = writeManifest(candidate, '0.1.0-dev.2').digest;
      releases.register(candidate);
      const failedAt = Date.now();
      const failed = releases.request(broken, 'preview', owner.id);
      await until(() => done(failed.id).status === 'failed', 60000);
      assert(
        Date.now() - failedAt < 10000,
        'An exited process must fail without the health timeout',
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'preview', 'release.json'), 'utf8')).digest,
        digest,
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'dsps', 'sentinel'), 'utf8'),
        'private DSP state',
      );
    } finally {
      if (supervisor && supervisor.exitCode === null) {
        const child = supervisor;
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        });
      }
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
