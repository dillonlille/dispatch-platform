'use strict';
const fs = require('node:fs');
class MaintenanceLockError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new MaintenanceLockError(code); }
function bootId() {
  const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[0-9a-f-]{36}$/.test(value)) fail('unsafe_maintenance_lock');
  return value;
}
function processStartTicks(pid) {
  try {
    const proc = fs.lstatSync(`/proc/${pid}`);
    if (!proc.isDirectory() || proc.uid !== process.geteuid()) return null;
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 1) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
  } catch { return null; }
}

module.exports = { bootId, processStartTicks };
