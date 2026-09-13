'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CdpConnection, createTarget } = require('/opt/dispatch/sdk/node/cdp');
module.exports.createPlugin = ({ dispatch }) => ({ async invoke() {
  assert.equal(fs.existsSync('/run/dispatch-agent'), false);
  assert.equal(fs.existsSync('/var/lib/dispatch/dsp_' + 'a'.repeat(32) + '/secrets/auth-broker/master.key'), false);
  return dispatch.connections.withSession({ connection: 'paycom', ttlMs: 30000 }, async browser => {
    assert.match(browser.endpoint, /^http\+unix:/);
    const target = await createTarget(browser.endpoint, 'about:blank');
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    try { assert.equal(await connection.evaluate('6 * 7'), 42); } finally { connection.close(); }
    const { websocketUrl } = require('/opt/dispatch/sdk/node/cdp-transport');
    const control = await CdpConnection.connect(websocketUrl(browser.endpoint));
    try {
      const targets = (await control.command('Target.getTargets')).targetInfos.filter(item => item.type === 'page');
      for (let count = targets.length; count < 6; count++) await control.command('Target.createTarget', { url: 'about:blank' });
      await assert.rejects(control.command('Target.createTarget', { url: 'about:blank' }));
    } finally { control.close(); }
    return { evaluated: 42, privateBrowser: true, tabLimit: 6 };
  });
} });

module.exports.collect = ({ dispatch, request }) => dispatch.connections.withSession({ connection: 'paycom' }, async browser => {
  assert.equal(request.source.config.maxConcurrency, 5);
  const { websocketUrl } = require('/opt/dispatch/sdk/node/cdp-transport');
  const control = await CdpConnection.connect(websocketUrl(browser.endpoint));
  try {
    // Match a provider handoff: retain one authenticated page.
    const pages = (await control.command('Target.getTargets')).targetInfos.filter(item => item.type === 'page');
    for (const page of pages.slice(1)) await control.command('Target.closeTarget', { targetId: page.targetId });
    if (!pages.length) await createTarget(browser.endpoint, 'about:blank');
    await Promise.all(Array.from({ length: request.source.config.maxConcurrency }, async () => {
      const target = await createTarget(browser.endpoint, 'about:blank');
      const client = await CdpConnection.connect(target.webSocketDebuggerUrl);
      try { assert.equal(await client.evaluate('6 * 7'), 42); } finally { client.close(); }
    }));
    assert.equal((await control.command('Target.getTargets')).targetInfos.filter(item => item.type === 'page').length, 6);
    return { ok: true, status: 'no_change', data: { collectionTabs: 5, retainedHandoffTabs: 1 } };
  } finally { control.close(); }
});
