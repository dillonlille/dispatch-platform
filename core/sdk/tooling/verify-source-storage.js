'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Credential/state artifacts never belong in a source tree or deployable build.
// Inspect names only: no secret values are read into build output.
function verifySourceStorage(root = path.resolve(__dirname, '..')) {
  const violations = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      const file = path.join(directory, item.name), relative = path.relative(root, file);
      if (item.isSymbolicLink()) { violations.push(relative); continue; }
      const forbidden = /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/.test(item.name)
        || ['auth.json', 'master.key', 'DevToolsActivePort', 'dispatch-owner.json'].includes(item.name)
        || /^\.env(?:\..+)?$/.test(item.name) && !/\.(?:example|sample|template)$/.test(item.name)
        || item.isDirectory() && ['browser-sessions', '.hermes', 'secrets'].includes(item.name);
      if (forbidden) violations.push(relative);
      else if (item.isDirectory()) visit(file);
    }
  }
  visit(root);
  if (violations.length) throw new Error('private_artifact_in_source: ' + violations.join(', '));
  return { ok: true, status: 'source_storage_verified' };
}
if (require.main === module) {
  try { console.log(JSON.stringify(verifySourceStorage(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifySourceStorage };
