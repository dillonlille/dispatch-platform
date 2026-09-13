'use strict';

// Collector commands are persisted in existing DSP databases and queued runs.
// Keep those executable addresses working without changing tenant data on upgrade.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '/opt/dispatch';
const LEGACY_ENTRYPOINTS = require('dispatch-protocol/legacy-entrypoints');
function install() {
  for (const [provider, executables] of Object.entries(LEGACY_ENTRYPOINTS)) {
    const directory = path.join(ROOT, 'plugins', provider, 'bin');
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    for (const executable of executables) {
      const base = require('dispatch-protocol/plugin-sdk/catalog').plugin(provider) ? ['plugins', provider, 'backend'] : ['compatibility', provider];
      const target = path.join(ROOT, ...base, 'bin', executable);
      if (!fs.lstatSync(target).isFile()) throw new Error('missing_collector_entrypoint');
      const file = path.join(directory, executable);
      fs.writeFileSync(file, `#!/usr/bin/env -S node --no-warnings\n'use strict';\nrequire(${JSON.stringify(target)});\n`, { flag: 'wx', mode: 0o755 });
      fs.chownSync(file, 10001, 10001);
    }
  }
}
if (require.main === module) install();
module.exports = { install, LEGACY_ENTRYPOINTS };
