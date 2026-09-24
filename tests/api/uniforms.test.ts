import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Uniform, UniformInventory } from '../../shared/contracts/uniforms.js';
import { fixture, demo } from '../support/support.js';

const route = '/api/dsp/uniforms';
const input = {
  name: 'Delivery polo',
  category: 'Custom tops',
  variants: [
    { fit: 'men', size: 'XL' },
    { fit: 'women', size: 'M' },
    { fit: 'unisex', size: 'XS/S' },
  ],
};
const draft = (uniform: Uniform) => ({
  name: uniform.name,
  category: uniform.category,
  revision: uniform.revision,
  variants: uniform.variants.map(({ id, fit, size }) => ({ id, fit, size })),
});

async function setup() {
  const f = await fixture();
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  return { f, owner, north };
}

test('uniform catalogs are customizable, permission checked and isolated by DSP', async (t) => {
  const { f, owner, north } = await setup();
  t.after(f.close);
  const member = await f.client(demo.member);
  await member.select(north.id);
  assert.deepEqual((await member.get(route)).value, { revision: 0, uniforms: [] });
  assert.equal((await member.post(route, input)).status, 403);
  assert.equal((await member.post(`${route}/initialize`, { starter: true })).status, 403);
  const starter = await owner.post(`${route}/initialize`, { starter: true });
  assert.equal(starter.status, 200, starter.body);
  const inventory: UniformInventory = starter.value;
  assert.equal(inventory.uniforms.length, 11);
  assert.equal(inventory.uniforms.flatMap((u) => u.variants).length, 83);
  assert(inventory.uniforms.every((u) => u.variants.every((v) => v.quantity === 0)));
  assert.equal(inventory.uniforms.find((u) => u.name === 'Long Sleeve Polo')!.variants.length, 14);
  assert.deepEqual(
    inventory.uniforms.find((u) => u.name === 'Spare Vest')!.variants.map((v) => v.size),
    ['XS/S', 'M/L', 'XL', '2XL/3XL', '4XL/5XL'],
  );
  assert.equal(inventory.uniforms.find((u) => u.name === 'Rainshell')!.variants.length, 0);
  assert.equal((await owner.post(`${route}/initialize`, { starter: true })).status, 409);
  const created = await owner.post(route, input);
  assert.equal(created.status, 201, created.body);
  const uniform = (created.value as UniformInventory).uniforms.at(-1)!;
  assert.equal(uniform.name, input.name);
  assert.deepEqual(
    uniform.variants.map((v) => [v.fit, v.size]),
    input.variants.map((v) => [v.fit, v.size]),
  );
  const variant = uniform.variants[0]!;
  assert.equal(
    (await member.post(`${route}/stock/${variant.id}`, { delta: 1, requestId: randomUUID() }))
      .status,
    403,
  );
  const other = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
  await owner.select(other.id);
  assert.equal((await owner.get(route)).value.uniforms.length, 0);
  assert.equal(
    (await owner.post(`${route}/stock/${variant.id}`, { delta: 1, requestId: randomUUID() }))
      .status,
    404,
  );
  assert.equal((await owner.post(`${route}/${uniform.id}`, draft(uniform))).status, 404);
  await owner.select(north.id);
  for (const bad of [
    { ...input, name: ' ' },
    { ...input, category: '' },
    { ...input, quantity: 5 },
    { ...input, variants: [{ fit: 'unknown', size: 'M' }] },
    { ...input, variants: [{ fit: 'men', size: ' ' }] },
    {
      ...input,
      variants: [
        { fit: 'men', size: 'M' },
        { fit: 'men', size: 'm' },
      ],
    },
    { ...input, variants: [{ fit: 'men', size: 'M', quantity: 12 }] },
  ])
    assert.equal((await owner.post(route, bad)).status, 400);
  assert.equal((await owner.post(route, { ...input, name: input.name.toUpperCase() })).status, 409);
});

test('concurrent adjustments never lose counts, duplicate retries or take stock below zero', async (t) => {
  const { f, owner, north } = await setup();
  t.after(f.close);
  const second = await f.client();
  await second.select(north.id);
  const created = await owner.post(route, input);
  const uniform = (created.value as UniformInventory).uniforms[0]!;
  const variant = uniform.variants[0]!;
  const stock = `${route}/stock/${variant.id}`;
  const requestId = randomUUID();
  const duplicated = await Promise.all(
    Array.from({ length: 8 }, () => owner.post(stock, { delta: 1, requestId })),
  );
  assert(
    duplicated.every((r) => r.status === 200),
    JSON.stringify(duplicated),
  );
  assert(duplicated.every((r) => r.value.quantity === 1));
  assert.equal(new Set(duplicated.map((r) => r.value.revision)).size, 1);
  const changed = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? owner : second).post(stock, { delta: 1, requestId: randomUUID() }),
    ),
  );
  assert(changed.every((r) => r.status === 200));
  assert.equal((await owner.get(route)).value.uniforms[0].variants[0].quantity, 21);
  assert.equal((await owner.post(stock, { delta: -1, requestId })).status, 409);
  assert.equal((await owner.post(stock, { delta: 0, requestId: randomUUID() })).status, 400);
  const removed = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? owner : second).post(stock, { delta: -1, requestId: randomUUID() }),
    ),
  );
  assert.equal(removed.filter((r) => r.status === 200).length, 21);
  assert.equal(
    removed.filter((r) => r.status === 409 && r.value.error === 'uniform_out_of_stock').length,
    9,
  );
  const final = (await owner.get(route)).value;
  assert.equal(final.uniforms[0].variants[0].quantity, 0);
  assert.equal(final.revision, 43); // creation, 21 additions, 21 removals; rejected writes leave no revisions.
  const events = (await owner.get(`${route}/history`)).value.events;
  assert.equal(events.length, 43);
  assert(
    events
      .filter((e: { kind: string }) => e.kind === 'adjusted')
      .every((e: { quantity: number }) => e.quantity >= 0),
  );
  await f.stop();
  await f.start();
  assert.deepEqual((await owner.get(route)).value, final);
  assert.equal((await owner.post(stock, { delta: 1, requestId })).value.quantity, 1);
  assert.deepEqual((await owner.get(route)).value, final); // original acknowledgement, no second write after restart.
});

test('live listeners get durable deltas and catch catalog edits without missed wakeups', async (t) => {
  const { f, owner, north } = await setup();
  t.after(f.close);
  const member = await f.client(demo.member);
  await member.select(north.id);
  const initial = await member.get(`${route}/updates`);
  assert.deepEqual(initial.value.inventory, { revision: 0, uniforms: [] });
  const waiting = member.get(`${route}/updates?after=0`);
  const created = await owner.post(route, input);
  const uniform = (created.value as UniformInventory).uniforms[0]!;
  assert.deepEqual((await waiting).value.inventory, created.value);
  const variant = uniform.variants[0]!;
  const next = member.get(`${route}/updates?after=1`);
  const addition = await owner.post(`${route}/stock/${variant.id}`, {
    delta: 1,
    requestId: randomUUID(),
  });
  assert.deepEqual((await next).value, {
    revision: 2,
    inventory: null,
    adjustments: [addition.value],
  });
  // A change made before a new listener subscribes is still read from the journal.
  await owner.post(`${route}/stock/${variant.id}`, { delta: 1, requestId: randomUUID() });
  const missed = await member.get(`${route}/updates?after=1`);
  assert.equal(missed.value.adjustments.length, 2);
  assert.equal(missed.value.adjustments.at(-1).quantity, 2);
  const updated = await owner.post(`${route}/${uniform.id}`, {
    ...draft(uniform),
    name: 'Renamed polo',
  });
  const catalogChange = await member.get(`${route}/updates?after=3`);
  assert.equal(catalogChange.value.inventory.uniforms[0].name, 'Renamed polo');
  assert.deepEqual(catalogChange.value.inventory, updated.value);
  assert.equal(catalogChange.value.inventory.uniforms[0].variants[0].quantity, 2);
  const other = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
  await owner.select(other.id);
  assert.equal((await owner.get(`${route}/updates`)).value.revision, 0);
  assert.deepEqual((await owner.get(`${route}/history`)).value.events, []);
});

test('catalog revisions protect edits while stock changes and history remain intact', async (t) => {
  const { f, owner } = await setup();
  t.after(f.close);
  const created = await owner.post(route, input);
  const uniform = (created.value as UniformInventory).uniforms[0]!;
  const variant = uniform.variants[0]!;
  const stock = `${route}/stock/${variant.id}`;
  await owner.post(stock, { delta: 1, requestId: randomUUID() });
  const changed = await owner.post(`${route}/${uniform.id}`, {
    ...draft(uniform),
    name: 'Polo v2',
  });
  assert.equal(changed.status, 200, changed.body);
  const current = (changed.value as UniformInventory).uniforms[0]!;
  assert.equal(current.variants[0]!.quantity, 1);
  assert.equal(
    (await owner.post(`${route}/${uniform.id}`, draft(uniform))).value.error,
    'uniform_changed',
  );
  const removeSize = await owner.post(`${route}/${uniform.id}`, {
    ...draft(current),
    variants: [],
  });
  assert.equal(removeSize.value.error, 'uniform_size_in_stock');
  assert.equal(
    (await owner.post(`${route}/${uniform.id}/archive`, { revision: current.revision })).value
      .error,
    'uniform_in_stock',
  );
  await owner.post(stock, { delta: -1, requestId: randomUUID() });
  const archived = await owner.post(`${route}/${uniform.id}/archive`, {
    revision: current.revision,
  });
  assert.equal(archived.status, 200, archived.body);
  assert.equal(archived.value.uniforms.length, 0);
  assert.equal((await owner.post(stock, { delta: 1, requestId: randomUUID() })).status, 404);
  const history = (await owner.get(`${route}/history`)).value.events;
  assert.deepEqual(
    history.map((e: { kind: string }) => e.kind),
    ['archived', 'adjusted', 'updated', 'adjusted', 'created'],
  );
  assert.equal(history.at(-2).uniformName, input.name); // historical names are snapshots.
});

test('inventory history paginates and waiting reads reauthorize after a role changes', async (t) => {
  const { f, owner, north } = await setup();
  t.after(f.close);
  const created = await owner.post(route, input);
  const uniform = (created.value as UniformInventory).uniforms[0]!;
  const stock = `${route}/stock/${uniform.variants[0]!.id}`;
  const role = await owner.post('/api/dsp/roles', {
    name: 'Inventory counter',
    permissions: ['uniforms.adjust'],
  });
  const members = (await owner.get('/api/dsp/members')).value;
  const memberId = members.find((m: { email: string }) => m.email === demo.member).id;
  await owner.post(`/api/dsp/members/${memberId}`, { role: role.value.id });
  const member = await f.client(demo.member);
  await member.select(north.id);
  assert.equal((await member.post(route, input)).status, 403);
  for (let batch = 0; batch < 3; batch++) {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => member.post(stock, { delta: 1, requestId: randomUUID() })),
    );
    assert(responses.every((r) => r.status === 200));
  }
  const first = (await member.get(`${route}/history`)).value;
  assert.equal(first.events.length, 50);
  assert(first.events.every((e: { actorName: string }) => e.actorName === 'Jordan Ellis'));
  const last = (await member.get(`${route}/history?before=${first.nextBefore}`)).value;
  assert.equal(last.events.length, 11);
  assert.equal(last.nextBefore, null);
  assert.equal(new Set([...first.events, ...last.events].map((e) => e.revision)).size, 61);
  const pending = member.get(`${route}/updates?after=61`);
  await owner.select(north.id);
  const revoked = await owner.post(`/api/dsp/roles/${role.value.id}`, {
    name: 'Inventory counter',
    permissions: [],
  });
  assert.equal(revoked.status, 200, revoked.body);
  await owner.select(north.id);
  await owner.post(stock, { delta: 1, requestId: randomUUID() });
  const withdrawn = await pending;
  assert.equal(withdrawn.status, 409);
  assert.equal(withdrawn.value.error, 'dsp_view_expired');
  await member.select(north.id);
  assert.equal((await member.get(route)).status, 403);
});
