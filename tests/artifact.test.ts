import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './rust-support.js';
import { verifyArtifact } from '../tooling/artifact.js';

test(
  'installed artifact serves the complete platform directly from Rust and contains only isolated Node workers',
  { skip: process.env.DISPATCH_TEST_ARTIFACT !== '1', timeout: 60000 },
  async (t) => {
    const artifact = path.resolve('.build');
    const manifest = verifyArtifact(artifact);
    assert.equal(manifest.format, 2);
    for (const name of [
      'api/main.js',
      'tooling/cli.js',
      'tooling/supervisor.js',
      'node_modules/fastify/package.json',
      'node_modules/nodemailer/package.json',
    ])
      assert(!fs.existsSync(path.join(artifact, name)), name);
    for (const name of [
      'services/runtime/auth-worker.js',
      'services/runtime/collection-worker.js',
      'services/runtime/provider/auth/adapter.js',
    ])
      assert(fs.existsSync(path.join(artifact, name)), name);
    // The updater owns verification and restores executable permissions lost by extraction.
    const script = `import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('u','tooling/update-dev.py'); u=importlib.util.module_from_spec(s); s.loader.exec_module(u); m=u.verify_artifact(Path('.build')); assert m['format']==2`;
    execFileSync('python3', ['-c', script]);
    const f = await fixture({
      seed: false,
      binary: path.join(artifact, 'services/rust/dispatch-backend'),
      env: { DISPATCH_ARTIFACT_ROOT: artifact },
    });
    t.after(f.close);
    assert.equal((await f.request('/api/health')).value.release, manifest.digest);
    const owner = await f.client();
    await owner.select(owner.session.dsps[0].id);
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
    assert.equal(fs.readFileSync(`/proc/${f.pid()}/task/${f.pid()}/children`, 'utf8').trim(), '');
    const html = await fetch(f.env.DISPATCH_ORIGIN + '/');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<div id="root">/);
    assert.equal(JSON.parse(f.cli(['status'])).runtime, 'rust');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bad-artifact-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    fs.cpSync(artifact, path.join(scratch, 'artifact'), { recursive: true });
    fs.appendFileSync(path.join(scratch, 'artifact/services/rust/dispatch-backend'), 'tampered');
    assert.throws(
      () => verifyArtifact(path.join(scratch, 'artifact')),
      /artifact inventory changed/,
    );
  },
);
