import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { features, permissions } from '../../shared/contracts/index.js';
import {
  capabilityLabel,
  featureCatalog,
  grants,
  previewSwitch,
  schedulesFeature,
} from '../../dashboard/src/app/features.js';

test('the dashboard mirrors the backend feature catalog', () => {
  const source = fs.readFileSync('backend/src/features.rs', 'utf8');
  const pages = /PAGES: &\[Feature\] = &\[([\s\S]*?)\n\];/.exec(source)![1]!;
  const parsed = [...pages.matchAll(/Feature \{([\s\S]*?)\n {4}\}/g)].map((match) => {
    const body = match[1]!;
    const field = (name: string) => new RegExp(`\\n {8}${name}: ([^\\n]*),`).exec(body)![1]!;
    const list = (name: string) => [...field(name).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    return {
      id: JSON.parse(field('id')),
      label: JSON.parse(field('label')),
      kind: 'page',
      permissions: list('permissions'),
      requires: list('requires'),
    };
  });
  const registry = /pub const ALL: &\[Self\] = &\[([^\]]*)\];/.exec(
    fs.readFileSync('backend/src/collectors/mod.rs', 'utf8'),
  )![1]!;
  const connections = [...registry.matchAll(/Self::(\w+)/g)].map(([, variant]) => {
    const id = variant!.toLowerCase();
    const collector = fs.readFileSync(`backend/src/collectors/${id}.rs`, 'utf8');
    const value = (fn: string) =>
      new RegExp(`fn ${fn}\\(&self\\) -> &'static str \\{\\s*"([^"]+)"`).exec(collector)![1]!;
    assert.equal(value('id'), id);
    return {
      id,
      label: value('label'),
      kind: 'connection',
      permissions: [],
      provides: value('capability'),
      requires: [],
    };
  });
  assert(parsed.length >= 2 && connections.length >= 2);
  assert.deepEqual(featureCatalog, [...parsed, ...connections]);
  assert.deepEqual(
    featureCatalog.map((feature) => feature.id),
    [...features],
  );
  assert.equal(/pub const SCHEDULES: &str = "([^"]+)";/.exec(source)![1], schedulesFeature);
  for (const capability of featureCatalog.flatMap((feature) => feature.requires))
    assert.notEqual(capabilityLabel(capability), capability, `${capability} has no label`);
});

test('a switch brings its dependencies along, as the backend does', () => {
  const all = [...features];
  assert.deepEqual(previewSwitch(all, 'uniforms', false), [
    { feature: 'uniforms', enabled: false },
  ]);
  assert.deepEqual(previewSwitch(all, 'uniforms', true), []);
  // Disabling a provider disables the pages left without one.
  assert.deepEqual(previewSwitch(all, 'cortex', false), [
    { feature: 'cortex', enabled: false },
    { feature: 'timecard', enabled: false },
  ]);
  // Enabling a page enables the one provider of each capability it lacks.
  assert.deepEqual(previewSwitch(['uniforms', 'paycom'], 'timecard', true), [
    { feature: 'cortex', enabled: true },
    { feature: 'timecard', enabled: true },
  ]);
  assert.deepEqual(previewSwitch(['uniforms'], 'timecard', true), [
    { feature: 'paycom', enabled: true },
    { feature: 'cortex', enabled: true },
    { feature: 'timecard', enabled: true },
  ]);
  assert.deepEqual(previewSwitch(['uniforms'], 'paycom', true), [
    { feature: 'paycom', enabled: true },
  ]);
});

test('a permission exists only with its feature', () => {
  assert.equal(grants(['uniforms'], 'uniforms.view'), true);
  assert.equal(grants(['timecard'], 'uniforms.view'), false);
  assert.equal(grants([], 'members.invite'), true);
  assert.equal(grants(['cortex'], 'connections.manage'), true);
  assert.equal(grants(['timecard', 'uniforms'], 'connections.manage'), false);
  for (const permission of permissions) assert.equal(grants(features, permission), true);
});
