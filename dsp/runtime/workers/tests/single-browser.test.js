'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {singleBrowser}=require('../authentication-server');
test('a worker never frees browser capacity after an uncertain launch or an old handle closes twice', async () => {
  const runtime = singleBrowser({ reconcile() {}, async launch() { return { async close() {} }; } });
  const first = await runtime.launch({});
  await assert.rejects(runtime.launch({}), { code: 'session_busy' });
  await first.close(); const second = await runtime.launch({});
  await first.close(); await assert.rejects(runtime.launch({}), { code: 'session_busy' });
  await second.close(); await (await runtime.launch({})).close();
  const failed = singleBrowser({ reconcile() {}, async launch() { throw new Error('uncertain_cleanup'); } });
  await assert.rejects(failed.launch({}), /uncertain_cleanup/);
  await assert.rejects(failed.launch({}), { code: 'session_busy' });
});
