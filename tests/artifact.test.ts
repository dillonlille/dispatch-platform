import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './rust-support.js';
import { verifyArtifact } from '../tooling/artifact.js';

test(
  'installed artifact serves the complete platform directly from Rust and has no Node runtime payload',
  { skip: process.env.DISPATCH_TEST_ARTIFACT !== '1', timeout: 60000 },
  async (t) => {
    const artifact = path.resolve('.build');
    const manifest = verifyArtifact(artifact);
    assert.equal(manifest.format, 3);
    for (const name of [
      'api',
      'services/runtime',
      'node_modules',
      'package.json',
      'package-lock.json',
      'tooling/cli.js',
      'tooling/supervisor.js',
    ])
      assert(!fs.existsSync(path.join(artifact, name)), name);
    assert(!('workerNodeMajor' in manifest));
    // The updater owns verification and restores executable permissions lost by extraction.
    const script = `import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('u','tooling/update-dev.py'); u=importlib.util.module_from_spec(s); s.loader.exec_module(u); m=u.verify_artifact(Path('.build')); assert m['format']==3`;
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
    const document = await html.text();
    assert.match(document, /<div id="root">/);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    const asset = document.match(/src="(\.?\/assets\/[^"]+\.js)"/)![1]!;
    const url = new URL(asset, f.env.DISPATCH_ORIGIN!);
    const get = await fetch(url);
    const bytes = await get.arrayBuffer();
    assert.equal(get.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('etag'), get.headers.get('etag'));
    assert.equal(Number(head.headers.get('content-length')), bytes.byteLength);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const cached = await fetch(url, { headers: { 'if-none-match': get.headers.get('etag')! } });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    const font = await fetch(f.env.DISPATCH_ORIGIN + '/assets/inter.woff2');
    assert.equal(font.headers.get('cache-control'), 'public, no-cache');
    assert.equal((await f.request('/api/session')).headers.get('cache-control'), 'no-store');
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
