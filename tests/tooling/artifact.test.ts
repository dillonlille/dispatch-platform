import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from '../support/support.js';
import { verifyArtifact } from '../../tooling/build/artifact.js';

test(
  'installed artifact serves the complete platform directly from Rust and has no Node runtime payload',
  { skip: process.env.DISPATCH_TEST_ARTIFACT !== '1', timeout: 60000 },
  async (t) => {
    const artifact = path.resolve('.build');
    execFileSync('python3', [
      'tooling/security/check-build-paths.py',
      path.join(artifact, 'services/rust/dispatch-backend'),
    ]);
    const manifest = verifyArtifact(artifact);
    assert.equal(manifest.format, 3);
    // The updater owns verification and restores executable permissions lost by extraction.
    const script = `import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('u','tooling/update-dev.py'); u=importlib.util.module_from_spec(s); s.loader.exec_module(u); m=u.verify_artifact(Path('.build')); assert m['format']==3`;
    execFileSync('python3', ['-c', script]);
    const f = await fixture({
      seed: false,
      binary: path.join(artifact, 'services/rust/dispatch-backend'),
      env: { DISPATCH_ARTIFACT_ROOT: artifact },
    });
    t.after(f.close);
    // Host commands use the shipped executable without taking the running app's data lock.
    assert.deepEqual(JSON.parse(f.cli(['host', 'capabilities'])), {
      hostManagement: 1,
      artifactFormat: 3,
    });
    assert.equal(
      JSON.parse(f.cli(['host', 'artifact', 'verify', artifact])).digest,
      manifest.digest,
    );
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
    const get = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
    const bytes = await get.arrayBuffer();
    assert(
      bytes.byteLength < 400_000,
      'main dashboard JavaScript stays below 400 KB before compression',
    );
    const stylesheet = document.match(/href="(\.?\/assets\/[^"]+\.css)"/)![1]!;
    const styles = await fetch(new URL(stylesheet, f.env.DISPATCH_ORIGIN));
    assert(
      (await styles.arrayBuffer()).byteLength < 30_000,
      'initial common CSS stays below 30 KB; feature CSS loads with its route',
    );

    assert.equal(get.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const head = await fetch(url, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
    assert.equal(head.headers.get('etag'), get.headers.get('etag'));
    assert.equal(Number(head.headers.get('content-length')), bytes.byteLength);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const cached = await fetch(url, {
      headers: { 'if-none-match': get.headers.get('etag')!, 'accept-encoding': 'identity' },
    });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    for (const encoding of ['br', 'gzip']) {
      const compressed = await fetch(url, { headers: { 'accept-encoding': encoding } });
      assert.equal(compressed.headers.get('content-encoding'), encoding);
      assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
      assert.deepEqual(Buffer.from(await compressed.arrayBuffer()), Buffer.from(bytes));
      assert(Number(compressed.headers.get('content-length')) < bytes.byteLength);
      assert.notEqual(compressed.headers.get('etag'), get.headers.get('etag'));
      const conditional = await fetch(url, {
        method: 'HEAD',
        headers: {
          'accept-encoding': encoding,
          'if-none-match': compressed.headers.get('etag')!,
        },
      });
      assert.equal(conditional.status, 304);
      assert.equal(conditional.headers.get('content-encoding'), encoding);
    }
    const noCompression = await fetch(url, {
      headers: { 'accept-encoding': '*;q=1, gzip;q=0, br;q=0' },
    });
    assert.equal(noCompression.headers.get('content-encoding'), null);
    const mapFile = manifest.files.find((file) =>
      /dashboard\/assets\/onboarding-map-.*\.svg$/.test(file.path),
    )!;
    assert(mapFile, 'onboarding map is shipped as an independent vector asset');
    const map = await fetch(f.env.DISPATCH_ORIGIN + mapFile.path.replace('dashboard', ''), {
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(map.headers.get('content-type'), 'image/svg+xml');
    assert.equal(map.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(map.headers.get('content-encoding'), 'br');
    assert(
      Number(map.headers.get('content-length')) < 900_000,
      'compressed vector map stays within its initial-load budget',
    );
    const vanFile = manifest.files.find((file) =>
      /dashboard\/assets\/login-van-.*\.glb$/.test(file.path),
    );
    assert(vanFile, 'van is a separate desktop-only asset');
    const van = await fetch(f.env.DISPATCH_ORIGIN + vanFile.path.replace('dashboard', ''), {
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(van.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(van.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(van.headers.get('content-encoding'), 'br');
    assert(
      Number(van.headers.get('content-length')) < 300_000,
      'compressed van transfer stays under 300 KB',
    );
    const rendererFile = manifest.files.find((file) =>
      /dashboard\/assets\/renderer-.*\.js$/.test(file.path),
    );
    assert(rendererFile, '3D renderer is a deferred chunk');
    const renderer = await fetch(
      f.env.DISPATCH_ORIGIN + rendererFile.path.replace('dashboard', ''),
      { headers: { 'accept-encoding': 'br' } },
    );
    assert(
      Number(renderer.headers.get('content-length')) < 200_000,
      'deferred renderer transfer stays under 200 KB',
    );
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
      /Artifact file verification failed/,
    );
  },
);
