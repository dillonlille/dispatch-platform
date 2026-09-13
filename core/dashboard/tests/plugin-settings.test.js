"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const {
  fixture,
  enableFixturePlugin,
} = require("../../core/accounts/tests/plugin-fixture");
const { settingsStore } = require("../../core/plugins/settings-store");
const { createDashboardServer } = require("../server/server");
const definition =
  require("../../tests/fixtures/paycom-plugin.json").settings;
test("settings HTTP routes enforce owner scope and CSRF, preserve DSP isolation and detect stale writes", async (t) => {
  const storages = new Map();
  const f = await fixture(t, {
    settingsPort: async (id, _plugin, request) => {
      const storage = storages.get(id);
      if(request.action === "history")return storage.history(definition,request.input);
      return request.action === "update"
        ? storage.update(definition, request.input, request.actor)
        : storage.read(definition);
    },
  });
  for (const dsp of f.dsps) {
    enableFixturePlugin(f.store, dsp.id);
    const storage = settingsStore(path.join(f.root, dsp.runtimeKey), "paycom");
    storage.initialize(definition);
    storages.set(dsp.runtimeKey, storage);
  }
  const client = {
    workforce: { day() {} },
    sync: { status() {}, runNow() {} },
    system: { status() {} },
  };
  const server = createDashboardServer({
    access: f.access,
    client,
    plugins: f.plugins,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const route = `http://127.0.0.1:${server.address().port}/api/organization/plugins/paycom/settings`;
  const [a, b] = f.dsps;
  const get = (dsp, headers = {}) =>
    fetch(route, {
      headers: { cookie: `dispatch_session=${dsp.token}`, ...headers },
    });
  const history = (dsp, headers = {}, query = '') => fetch(route+'/history'+query,{headers:{cookie:`dispatch_session=${dsp.token}`,...headers}});
  const post = (dsp, body, headers = {}) =>
    fetch(route, {
      method: "POST",
      headers: {
        cookie: `dispatch_session=${dsp.token}`,
        "content-type": "application/json",
        "x-dispatch-csrf": dsp.owner?.csrfToken,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(route)).status, 401);
  const before = (await (await get(a)).json()).data;
  const input = {
    values: {
      ...before.values,
      driver_departments: ["D1"],
      sync_interval_seconds: 7200,
    },
    expectedRevision: before.revision,
    definitionVersion: before.definitionVersion,
    idempotencyKey: "settings:first",
  };
  assert.equal(
    (await post(a, input, { "x-dispatch-csrf": "wrong" })).status,
    403,
  );
  assert.equal((await post(a, { ...input, dspId: b.runtimeKey })).status, 400);
  assert.equal((await post(a, input)).status, 200);
  assert.equal((await post(a, input)).status, 200);
  assert.equal(
    (await post(a, { ...input, idempotencyKey: "settings:stale" })).status,
    409,
  );
  assert.equal(
    (await (await get(b)).json()).data.values.driver_departments,
    null,
  );
  const view = f.access.beginDspView(f.platform.session, {
    controlRef: f.access.issuePlatformControlRef(f.platform.session, b.id),
  });
  const support = { token: f.platform.token, owner: f.platform.session };
  assert.equal(
    (
      await post(
        support,
        { ...input, values: { ...input.values, driver_departments: [] } },
        { "x-dispatch-dsp-view": view.dspView.viewRef },
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await (await get(b)).json()).data.values.driver_departments,
    [],
  );
  assert.deepEqual(
    (await (await get(a)).json()).data.values.driver_departments,
    ["D1"],
  );
  assert.equal(
    (await post(support, input, { "x-dispatch-dsp-view": "forged" })).status,
    403,
  );
  assert.equal(
    storages.get(b.runtimeKey).read(definition).updatedBy,
    f.platform.session.user.id,
  );
  const ownHistory=await history(a);assert.equal(ownHistory.status,200);
  const ownItems=(await ownHistory.json()).data.items;assert.equal(ownItems[0].updatedBy,a.owner.user.id);assert(ownItems[0].actorName);
  assert.equal((await history(a,{},'?dspId='+b.runtimeKey)).status,400);
  assert.equal((await history(a,{},'?before=-1')).status,400);
  const supportHistory=await history(support,{'x-dispatch-dsp-view':view.dspView.viewRef});assert.equal(supportHistory.status,200);assert.equal((await supportHistory.json()).data.items[0].updatedBy,f.platform.session.user.id);
  assert.equal((await history(support,{'x-dispatch-dsp-view':'forged'})).status,403);
  const manager = f.store.roleByKey(a.id, "manager");
  f.store.db
    .prepare(
      "UPDATE memberships SET role_id=? WHERE user_id=? AND organization_id=?",
    )
    .run(manager.id, a.owner.user.id, a.id);
  assert.equal(
    (
      await post(a, {
        ...input,
        expectedRevision: 1,
        idempotencyKey: "settings:manager",
      })
    ).status,
    403,
  );
  assert.equal((await history(a)).status,403);
  assert.equal(storages.get(a.runtimeKey).read(definition).revision, 1);
});
