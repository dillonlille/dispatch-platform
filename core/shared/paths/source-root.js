'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A packaged protocol must resolve the invoking application, not its own
// node_modules directory. Runtime launchers supply an explicit trusted root.
function sourceRoot(start = __dirname) {
  if (process.env.DISPATCH_PROJECT_ROOT) {
    const root = process.env.DISPATCH_PROJECT_ROOT;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || /[\0\r\n]/.test(root)) throw new Error('unsafe_runtime_config');
    return root;
  }
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
      if (['dispatch-core', 'dispatch-dsp'].includes(manifest.name)) return current;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (path.dirname(current) === current) throw new Error('dispatch_application_root_required');
  }
}
module.exports = { sourceRoot };
