'use strict';

const fs = require('node:fs');

const PROFILE = '/tmp/dispatch-sandbox-proof';

function statusFields(pid) {
  const fields = new Map();
  for (const line of fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return fields;
}

function commandLine(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
}

function chromiumProcesses() {
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const argv = commandLine(name);
      const text = argv.join(' ');
      if (argv[0]?.startsWith('/usr/lib/chromium/chromium') && text.includes(`--user-data-dir=${PROFILE}`)) {
        rows.push(Object.freeze({ pid: name, argv: Object.freeze(argv), text }));
      }
    } catch {}
  }
  return rows;
}

function sandboxStatus() {
  const rows = chromiumProcesses();
  const browser = rows.find(row => !row.text.includes('--type='));
  const renderer = rows.find(row => row.text.includes('--type=renderer'));
  if (!browser || !renderer) return Object.freeze({ ok: false, status: 'not_ready' });
  if (rows.some(row => row.text.includes('--no-sandbox'))) return Object.freeze({ ok: false, status: 'sandbox_disabled' });

  const fields = statusFields(renderer.pid);
  const browserPidNamespace = fs.readlinkSync(`/proc/${browser.pid}/ns/pid`);
  const rendererPidNamespace = fs.readlinkSync(`/proc/${renderer.pid}/ns/pid`);
  const ok = fields.get('NoNewPrivs') === '1'
    && fields.get('Seccomp') === '2'
    && Number.parseInt(fields.get('Seccomp_filters') || '0', 10) >= 1
    && browserPidNamespace !== rendererPidNamespace;
  return Object.freeze({ ok, status: ok ? 'sandboxed' : 'sandbox_inactive' });
}

function main() {
  try {
    const result = sandboxStatus();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch {
    process.stdout.write('{"ok":false,"status":"unavailable"}\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { PROFILE, sandboxStatus, main };
