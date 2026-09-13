'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginStorage } = require('../storage');

test('plugin storage keeps databases and files separate across DSPs and plugins', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugin-storage-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function scoped(dsp, plugin) {
    const base = path.join(root, dsp);
    const roots = { projectRoot: path.resolve(__dirname, '../../..'), dataRoot: path.join(base, 'data'),
      stateRoot: path.join(base, 'state'), stagingRoot: path.join(base, 'staging') };
    for (const field of ['dataRoot', 'stateRoot', 'stagingRoot']) fs.mkdirSync(roots[field], { recursive: true, mode: 0o700 });
    const store = createPluginStorage({ roots, pluginId: plugin }); stores.push(store); return store;
  }
  const first = scoped('dsp-a', 'sample'), second = scoped('dsp-b', 'sample'), sibling = scoped('dsp-a', 'other');
  const db = first.database('records'); db.exec("CREATE TABLE record(value TEXT); INSERT INTO record VALUES('private');");
  first.files('exports').write('report.csv', 'first DSP');
  assert.equal(first.files('exports').read('report.csv').toString(), 'first DSP');
  assert.throws(() => second.files('exports').read('report.csv'), { code: 'ENOENT' });
  assert.throws(() => sibling.files('exports').read('report.csv'), { code: 'ENOENT' });
  assert.equal(second.database('records').prepare("SELECT count(*) n FROM sqlite_master WHERE name='record'").get().n, 0);
  assert.throws(() => first.database('../other/records'), { code: 'plugin_storage_name_invalid' });
  assert.throws(() => first.files('exports').read('../../other/report.csv'), { code: 'plugin_storage_name_invalid' });
  const outside = path.join(root, 'unrelated.txt'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(root, 'dsp-a/data/files/sample/exports/link.txt'));
  assert.throws(() => first.files('exports').read('link.txt'), { code: 'plugin_storage_unsafe' });
  assert.throws(() => first.files('exports').write('link.txt', 'overwrite'), { code: 'plugin_storage_unsafe' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
  first.close(); assert.throws(() => first.database('records'), { code: 'plugin_storage_closed' });
});
