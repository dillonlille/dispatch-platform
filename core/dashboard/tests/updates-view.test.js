'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Small DOM fixture for polling/navigation races; rendered layout is checked in Chromium.
function element(tag, className = '', text = '') {
  return {
    tag, className, textContent: text, children: [], dataset: {}, attributes: {}, handlers: {},
    style: { setProperty(key, value) { this[key] = value; } },
    append(...items) { for (const item of items) { if (item.tag === 'fragment') this.append(...item.children); else { item.parent = this; this.children.push(item); } } },
    prepend(item) { item.parent = this; this.children.unshift(item); },
    replaceChildren(...items) { this.children = []; this.append(...items); },
    remove() { this.parent.children = this.parent.children.filter(item => item !== this); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    focus() {},
    contains(item) { return this === item || this.children.some(child => child.contains(item)); },
    querySelectorAll(selector) {
      const matches = item => selector.split(',').some(part => part.startsWith('.')
        ? (item.className || '').split(' ').includes(part.slice(1)) : item.tag === part);
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
}
function harness() {
  let now = 1000, next = null, mutationResult = null, timer = null;
  const nodes = new Map();
  const byId = id => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); };
  const location = { hash: '#/updates' };
  const context = { window: {}, document: { createDocumentFragment: () => element('fragment'), createElementNS: (_ns, tag) => element(tag), activeElement: null }, location,
    Date: class extends Date { static now() { return now; } }, AbortSignal,
    setTimeout: (callback, delay) => { timer = { callback, delay }; return timer; }, clearTimeout: () => { timer = null; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/assets/updates.js"), 'utf8'), context);
  const views = context.window.createUpdatesViews({ byId, node: element, errorMessage: code => `error:${code}`,
    request: async () => { if (next instanceof Error) throw next; return await next; },
    mutation: async () => { throw new Error("viewer must not mutate"); }, mutationKey: () => 'fixture:key', settleMutationKey: () => {} });
  views.setUpdatesActive(true);
  const container = byId('platform-updates-content');
  const text = item => [item.textContent, ...item.children.map(text)].join(' ');
  return { ...views, container, text: () => text(container), timer: () => timer,
    set: value => { next = value; }, mutation: value => { mutationResult = value; }, advance: ms => { now += ms; },
    leave() { location.hash = '#/plugins'; views.setUpdatesActive(false); },
    enter() { location.hash = '#/updates'; views.setUpdatesActive(true); } };
}
function data(state = 'installed') {
  const notes = require('../examples/grouped-changelog.json');
  const release = { id: 'dispatch_0.0.9', version: '0.0.9', publishedAt: '2026-09-08T00:00:00.000Z', state, changelog: notes.changelog, notes };
  return { enabled: true, releases: [], displayedRelease: release, releaseHistory: [release,
    { id: 'dispatch_0.0.8', version: '0.0.8', state: 'historical' }], rollout: null };
}
const unavailable = status => Object.assign(new Error('unavailable'), { status, code: 'unavailable' });

for (const state of ['available', 'rolling_out', 'installed', 'historical']) test(`changelog stays readable without rollout controls: ${state}`, async () => {
  const h = harness(); h.set(data(state)); await h.renderUpdates();
  assert.match(h.text(), /3 additions · 4 changes · 3 improvements/);
  assert.match(h.text(), /September 8, 2026/);
  assert.equal(h.container.querySelectorAll('.update-feature-group').length, 4);
  assert.doesNotMatch(h.text(), /Install update|Start rollout|Pause rollout|Resume rollout|Retry download|You’re up to date/);
  assert.equal(h.container.querySelector('.update-live-rollout'), null);
});

test('group disclosures and version search survive changed polling responses', async () => {
  const h = harness(); const value = data(); h.set(value); await h.renderUpdates();
  h.container.querySelector('.update-details-toggle').handlers.click();
  const search = h.container.querySelector('input'); search.value = '0.0.8'; search.handlers.input();
  assert.equal(h.container.querySelector('.update-release-list').children[0].hidden, true);
  assert.equal(h.container.querySelector('.update-release-list').children[1].hidden, false);
  h.set({ ...value, delivery: { state: 'ready' } }); await h.renderUpdates();
  assert.equal(h.container.querySelector('input').value, '0.0.8');
  assert.equal(h.container.querySelector('.update-release-list').children[0].hidden, true);
  assert.equal(h.container.querySelector('.update-expanded-details').hidden, false);
});

test('release selection updates the changelog and its selected navigation marker', async () => {
  const h = harness(); const value = data(); h.set(value); await h.renderUpdates();
  h.set({ ...value, displayedRelease: { ...value.releaseHistory[1], changelog: [{ kind: 'fixed', title: 'Earlier fix', description: '' }] } });
  await h.container.querySelectorAll('.update-release-link')[1].handlers.click();
  assert.match(h.text(), /Earlier fix/); assert.match(h.text(), /What’s new/);
  assert.equal(h.container.querySelectorAll('.update-release-link')[1].attributes['aria-current'], 'page');
});

test('transient interruptions retain notes and recover; auth errors clear cached content', async () => {
  const h = harness(); const value = data(); h.set(value); await h.renderUpdates();
  const notes = h.container.querySelector('.update-notes-panel');
  h.set(unavailable(503)); await h.renderUpdates(); await h.renderUpdates();
  assert.equal(h.container.querySelector('.update-notes-panel'), notes);
  assert.equal(h.container.querySelectorAll('.update-reconnecting').length, 1);
  assert.match(h.text(), /Showing the last loaded changelog/);
  assert.equal(h.timer().delay, 1000);
  h.set(value); await h.renderUpdates(); assert.equal(h.container.querySelector('.update-reconnecting'), null);
  assert.equal(h.timer().delay, 3000);
  h.set(unavailable(403)); await h.renderUpdates();
  assert.match(h.text(), /error:unavailable/); assert.equal(h.container.querySelector('.update-notes-panel'), null);
  h.set(unavailable(503)); await h.renderUpdates(); assert.doesNotMatch(h.text(), /last loaded/);
});

test('leaving the page invalidates a pending request and stops polling', async () => {
  const h = harness(); let resolve;
  h.set(new Promise(done => { resolve = done; })); const pending = h.renderUpdates();
  h.leave(); resolve(data()); await pending;
  assert.equal(h.container.children.length, 0); assert.equal(h.timer(), null);
  h.enter(); h.set(data()); await h.renderUpdates(); assert.match(h.text(), /Installed/);
});

test('empty history does not claim installation and disabled operators can still read notes', async () => {
  const h = harness(); h.set({ enabled: false, releases: [], rollout: null }); await h.renderUpdates();
  assert.match(h.text(), /No releases yet/); assert.doesNotMatch(h.text(), /Installed/);
  h.set({ ...data(), enabled: false }); await h.renderUpdates(); assert.match(h.text(), /3 additions/);
});

test('hotfix releases have readable version labels', async () => {
  const h = harness(); const value = data(); value.displayedRelease.version = '0.0.9+hotfix.1';
  h.set(value); await h.renderUpdates(); assert.match(h.text(), /Version 0.0.9 — Hotfix 1/);
});
