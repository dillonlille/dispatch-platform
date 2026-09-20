import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = 'dashboard/src';

type Module = { file: string; imports: string[] };

function walk(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(directory, entry.name)]
          : [],
    );
}

// Every module under dashboard/src with the dashboard modules it imports, type-only
// imports included, as paths relative to dashboard/src.
const modules: Module[] = walk(source).map((file) => {
  const text = fs.readFileSync(file, 'utf8');
  const imports: string[] = [];
  for (const [, target] of text.matchAll(/(?:from|import)\s+'(\.[^']+)'/g)) {
    const resolved = path.join(path.dirname(file), target!).replace(/\.js$/, '');
    const found = ['.ts', '.tsx'].map((ext) => resolved + ext).find((name) => fs.existsSync(name));
    if (found && found.startsWith(source + path.sep)) imports.push(path.relative(source, found));
  }
  return { file: path.relative(source, file), imports };
});
const area = (file: string) => file.split(path.sep)[0]!;
const feature = (file: string) =>
  area(file) === 'features' ? file.split(path.sep)[1]! : undefined;
const edges = modules.flatMap(({ file, imports }) => imports.map((target) => ({ file, target })));

test('sign-in, DSP onboarding and member profiles own their screen dependencies', () => {
  const auth = path.resolve(source, 'features/auth');
  const screens = ['sign-in', 'dsp-onboarding', 'member-profile'];
  for (const screen of screens) {
    const directory = path.join(auth, screen);
    const files = walk(directory);
    assert(files.length > 0, `${screen} must have its own screen directory`);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [, , imported] of text.matchAll(
        /(?:from\s+|import\s*(?:\(\s*)?)(['"])(\.[^'"]+)\1/g,
      )) {
        const target = path.resolve(path.dirname(file), imported!.split('?')[0]!);
        if (target.startsWith(auth + path.sep))
          assert(
            target.startsWith(directory + path.sep),
            `${file} imports ${imported}; each auth screen owns its forms, layouts, styles and artwork`,
          );
      }
    }
  }
});

// ui/ holds building blocks that would make sense unchanged in another app.
test('ui components know nothing about the product', () => {
  const files = fs.readdirSync(path.join(source, 'ui')).filter((file) => /\.tsx?$/.test(file));
  assert(files.length > 10, `found only ${files.length} ui files`);
  for (const file of files) {
    const text = fs.readFileSync(path.join(source, 'ui', file), 'utf8');
    for (const [, target] of text.matchAll(/from '([^']+)'/g))
      assert(
        !target!.startsWith('.') || target!.startsWith('./') || target!.startsWith('../lib/'),
        `ui/${file} imports ${target}; ui may import packages, ui and lib only`,
      );
  }
});

// lib/ is pure logic: no React product code, nothing from app, features, shell or ui.
test('lib depends on nothing else in the dashboard', () => {
  const files = modules.filter(({ file }) => area(file) === 'lib');
  assert(files.length >= 4, `found only ${files.length} lib files`);
  for (const { file } of files) {
    const text = fs.readFileSync(path.join(source, file), 'utf8');
    for (const [, target] of text.matchAll(/(?:from|import)\s+'([^']+)'/g))
      assert(
        !target!.startsWith('.') || target!.startsWith('./') || target!.startsWith('../../../'),
        `${file} imports ${target}; lib may import packages, lib and shared contracts only`,
      );
  }
});

// A feature that embeds another names it here, so a new edge is a visible decision.
const embeds = ['settings -> audit', 'settings -> connections'];

test('a feature reaches another feature only through its index, and only where allowed', () => {
  assert(modules.filter(({ file }) => feature(file)).length > 30, 'found too few feature files');
  const found = new Set<string>();
  for (const { file, target } of edges) {
    const to = feature(target);
    if (!to || to === feature(file)) continue;
    assert.equal(
      target,
      path.join('features', to, 'index.ts'),
      `${file} imports ${target}; import features/${to}/index.js instead`,
    );
    const from = feature(file);
    if (!from) continue;
    assert(
      embeds.includes(`${from} -> ${to}`),
      `${file} imports the ${to} feature; move what they share to ui, lib or app, or allow the edge`,
    );
    found.add(`${from} -> ${to}`);
  }
  assert.deepEqual([...found].sort(), embeds, 'an allowed feature edge is no longer used');
});

test('features build on ui, lib and app only', () => {
  for (const { file, target } of edges)
    if (feature(file))
      assert(
        ['features', 'ui', 'lib', 'app'].includes(area(target)),
        `${file} imports ${target}; a feature may import ui, lib, app and itself only`,
      );
});

test('only the route table and the entry point know the features', () => {
  for (const { file, target } of edges)
    if (feature(target) && !feature(file))
      assert(
        file === path.join('app', 'routes.tsx') || file === 'main.tsx',
        `${file} imports ${target}; outside features only app/routes.tsx and main.tsx may`,
      );
  for (const { file, target } of edges)
    if (area(file) === 'shell')
      assert(
        ['shell', 'ui', 'lib', 'app'].includes(area(target)),
        `${file} imports ${target}; the shell may import ui, lib and app only`,
      );
});

test('no dashboard modules import each other in a cycle', () => {
  const graph = new Map(modules.map(({ file, imports }) => [file, imports]));
  const done = new Set<string>();
  const trail: string[] = [];
  const visit = (file: string) => {
    if (done.has(file)) return;
    const at = trail.indexOf(file);
    assert(at < 0, `import cycle: ${[...trail.slice(at), file].join(' -> ')}`);
    trail.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    trail.pop();
    done.add(file);
  };
  for (const file of graph.keys()) visit(file);
});

test('every route is declared once and every parent is a route', () => {
  const text = fs.readFileSync(path.join(source, 'app/route-meta.ts'), 'utf8');
  const table = text.slice(text.indexOf('export const routeMeta = ['), text.indexOf('] as const'));
  const entries = table
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((entry) => ({
      id: /^ {4}id: '([^']+)'/m.exec(entry)?.[1],
      scope: /^ {4}scope: '(dsp|platform)'/m.exec(entry)?.[1],
      parent: /^ {4}parent: '([^']+)'/m.exec(entry)?.[1],
    }));
  assert(entries.length >= 10, `found only ${entries.length} routes`);
  for (const entry of entries) {
    assert(entry.id && entry.scope, `unreadable route entry: ${JSON.stringify(entry)}`);
    assert.equal(
      entries.filter((other) => other.scope === entry.scope && other.id === entry.id).length,
      1,
      `${entry.scope} route ${entry.id} is declared more than once`,
    );
    if (entry.parent)
      assert(
        entries.some((other) => other.scope === entry.scope && other.id === entry.parent),
        `${entry.id} names ${entry.parent} as its parent, which is not a ${entry.scope} route`,
      );
  }
});
