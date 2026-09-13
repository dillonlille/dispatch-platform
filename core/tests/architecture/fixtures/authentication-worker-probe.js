'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CdpConnection, createTarget } = require('/opt/dispatch/node_modules/dispatch-sdk/node/cdp.js');
module.exports.probeAdapter = { provider: 'paycom', async authenticate(browser, credentials) {
  assert.equal(credentials.username, 'synthetic-worker');
  assert.equal(fs.existsSync('/var/lib/dispatch-plugin/database/paycom.sqlite3'), false);
  assert.equal(fs.existsSync('/run/dispatch-agent'), false);
  const dsp = fs.readdirSync('/var/lib/dispatch')[0];
  assert.equal(fs.existsSync(`/var/lib/dispatch/${dsp}/data/db`), false);
  assert.equal(fs.existsSync(`/var/lib/dispatch/${dsp}/secrets/runtime-agent`), false);
  const target = await createTarget(browser.endpoint, 'about:blank');
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
  try {
    const value = await connection.command('Runtime.evaluate', { expression: '21 * 2', returnByValue: true });
    assert.equal(value.result.value, 42);
  } finally { connection.close(); }
  return { status: 'authenticated' };
} };
