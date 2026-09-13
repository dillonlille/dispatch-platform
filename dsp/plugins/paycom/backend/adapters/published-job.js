'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PaycomStore } = require('../src/store');
const { openDatabase } = require('dispatch-protocol/published/database');
const completed = new Map();

function pendingFingerprint({ database, publishedDatabase, timezone }) {
  if (!fs.existsSync(database)) return null;
  const source = new PaycomStore(database, { readOnly: true });
  const hash = require('node:crypto').createHash('sha256'); let changed = false;
  let published;
  try {
    published = openDatabase(publishedDatabase);
    for (const row of source.db.prepare(`SELECT r.target,r.publication_id roster,t.publication_id timecards,l.publication_id links
      FROM active_publications r JOIN active_publications t ON t.kind='timecards' AND t.target=r.target
      JOIN active_resource_link_publications l ON l.target=r.target WHERE r.kind='roster' ORDER BY r.target`).iterate()) {
      const expected = [row.roster, row.timecards, row.links, timezone].join(':');
      if (!published || published.prepare('SELECT fingerprint FROM periods WHERE target=?').get(row.target)?.fingerprint !== expected) {
        changed = true; hash.update(row.target + '\n' + expected + '\n');
      }
    }
    return changed ? hash.digest('hex') : null;
  } finally { source.close(); published?.close(); }
}

function publish(options) {
  const fingerprint = pendingFingerprint(options);
  if (!fingerprint || completed.get(options.database) === fingerprint) return Promise.resolve({ changed: 0 });
  // A temporary DSP-local process releases all model-building memory when it
  // exits. The gateway remains responsive while a large period is published.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'published-job.js'), options.database, options.publishedDatabase, options.timezone],
      { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('published_build_timeout')); }, 300000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024) { child.kill('SIGKILL'); finish(new Error('published_build_failed')); } });
    child.once('error', () => finish(new Error('published_build_failed')));
    child.once('close', code => {
      if (code !== 0) return finish(new Error('published_build_failed'));
      try {
        const value = JSON.parse(output); if (!Number.isInteger(value.changed)) throw new Error();
        // Incomplete source pointers are retried when they change, rather than
        // keeping an otherwise idle DSP awake rebuilding the same partial data.
        if (completed.size >= 16) completed.delete(completed.keys().next().value);
        completed.set(options.database, fingerprint); finish(null, value);
      }
      catch { finish(new Error('published_build_failed')); }
    });
  });
}
if (require.main === module) {
  process.umask(0o077);
  if (process.argv.length !== 5) process.exitCode = 1;
  else require('./published').publishWorkforce({ database: process.argv[2], publishedDatabase: process.argv[3], timezone: process.argv[4] })
    .then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => { process.exitCode = 1; });
}
module.exports = { publish, needsPublication: options => Boolean(pendingFingerprint(options)) };
