'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync, execFileSync} = require('node:child_process');
const {buildFrontend} = require('../src/release-frontend');
const {sha} = require('../src/release-delivery-contract');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-package-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  fs.mkdirSync(source); fs.mkdirSync(output);
  const git = args => execFileSync('/usr/bin/git', args, {cwd:source, encoding:'utf8', stdio:['pipe','pipe','pipe']}).trim();
  git(['init']); git(['config','user.name','Test']); git(['config','user.email','test@example.invalid']);
  fs.mkdirSync(path.join(source, 'dashboard/public/assets'), {recursive:true});
  fs.writeFileSync(path.join(source, 'dashboard/input.txt'), 'committed source');
  fs.writeFileSync(path.join(source, '.gitignore'), 'dashboard/public/assets/\n');
  fs.mkdirSync(path.join(source, 'plugins/paycom/frontend'), {recursive:true});
  fs.writeFileSync(path.join(source, 'plugins/paycom/frontend/index.tsx'), 'committed plugin');
  git(['add','.']); git(['-c','commit.gpgsign=false','commit','-m','fixture']);
  const commit = git(['rev-parse','HEAD']);
  fs.writeFileSync(path.join(source, 'dashboard/input.txt'), 'uncommitted source');
  fs.writeFileSync(path.join(source, 'dashboard/public/assets/frontend.js'), 'stale checkout bundle');
  return {source, output, commit};
}

test('release frontend uses the selected Git snapshot and hashes generated assets', t => {
  const {source, output, commit} = fixture(t), steps = [];
  const files = buildFrontend(source, commit, output, {run(executable, args, options) {
    if (executable !== 'npm') return spawnSync(executable, args, options);
    steps.push(args);
    assert.equal(fs.readFileSync(path.resolve(options.cwd, '../plugins/paycom/frontend/index.tsx'), 'utf8'), 'committed plugin');
    assert.equal(fs.readFileSync(path.join(options.cwd, 'input.txt'), 'utf8'), 'committed source');
    const assets = path.join(options.cwd, 'public/assets');
    assert.equal(fs.existsSync(path.join(assets, 'frontend.js')), false);
    if (args.includes('vite')) {
      fs.mkdirSync(assets, {recursive:true});
      fs.writeFileSync(path.join(assets, 'frontend.js'), 'fresh javascript');
      fs.writeFileSync(path.join(assets, 'styles.css'), 'fresh stylesheet');
    }
    return {status:0, stdout:''};
  }});
  assert.deepEqual(steps, [['ci','--no-audit','--no-fund'], ['exec','--','tsc','--noEmit'], ['exec','--','vite','build']]);
  assert.deepEqual(files.map(file => Buffer.from(file.data, 'base64').toString()), ['fresh javascript', 'fresh stylesheet']);
  for (const file of files) {
    assert.equal(file.sha256, sha(Buffer.from(file.data, 'base64')));
    assert.equal(file.mode, '444');
  }
  assert.deepEqual(fs.readdirSync(output), []);
  assert.equal(fs.readFileSync(path.join(source, 'dashboard/public/assets/frontend.js'), 'utf8'), 'stale checkout bundle');
});

test('failed or interrupted frontend commands stop packaging and clean scratch', t => {
  const {source, output, commit} = fixture(t);
  for (const failure of [{status:1}, {status:null, signal:'SIGTERM'}, {status:null, error:{code:'ETIMEDOUT'}}]) {
    assert.throws(() => buildFrontend(source, commit, output, {run(executable, args, options) {
      return executable === 'npm' ? failure : spawnSync(executable, args, options);
    }}), /release_frontend_build_failed:npm/);
    assert.deepEqual(fs.readdirSync(output), []);
  }
});

test('missing, empty, or symlinked frontend outputs cannot become release assets', t => {
  const {source, output, commit} = fixture(t);
  for (const invalid of ['missing', 'empty', 'symlink']) {
    assert.throws(() => buildFrontend(source, commit, output, {run(executable, args, options) {
      if (executable !== 'npm') return spawnSync(executable, args, options);
      if (args.includes('vite')) {
        const assets = path.join(options.cwd, 'public/assets'); fs.mkdirSync(assets, {recursive:true});
        if (invalid === 'empty') fs.writeFileSync(path.join(assets, 'frontend.js'), '');
        if (invalid === 'symlink') fs.symlinkSync(path.join(options.cwd, 'input.txt'), path.join(assets, 'frontend.js'));
      }
      return {status:0, stdout:''};
    }}));
    assert.deepEqual(fs.readdirSync(output), []);
  }
});
