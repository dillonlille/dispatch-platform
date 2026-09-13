'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../examples/github-changelog.json');
const { authoring, markdown, releaseNotes } = require('../src/release-notes');
const input = () => structuredClone(fixture);
const render = source => {
  const { changelog, notes, github } = authoring(source);
  return markdown('0.0.1', changelog, notes, github);
};

test('GitHub uses inline author and PR links under change types without a duplicate release heading', () => {
  const body = render(input());
  assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['New', 'Improved', 'Fixed', 'Maintenance']);
  assert.ok(body.includes(fixture.github.summary.replaceAll('.', '\\.')));
  assert.ok(body.includes('- **Capacity\\-aware shift templates** — Preview conflicts while building shifts\\. by [@example\\-author](https://github.com/example-author) · [PR #101]'));
  assert.doesNotMatch(body, /^# Dispatch/m);
  assert.ok(body.startsWith(fixture.github.summary.replaceAll('.', '\\.')));
  assert.match(body, /## New[\s\S]*#101[\s\S]*#103[\s\S]*## Improved[\s\S]*#102[\s\S]*#105[\s\S]*## Fixed[\s\S]*#104[\s\S]*#106[\s\S]*## Maintenance[\s\S]*#107/);
  for (let number = 101; number <= 107; number++) {
    assert.equal(body.split(`[PR #${number}](https://github.com/example-organization/dispatch-platform/pull/${number})`).length, 2);
  }
  assert.ok(body.endsWith('[Full changelog](https://github.com/example-organization/dispatch-platform/compare/0.0.0...0.0.1)\n'));
  assert.doesNotMatch(body, /^## (Scheduling|Workforce|Dashboard|Highlights|Changed|Added)$/m);
});

test('GitHub-only metadata leaves the complete Updates, installation and popup data unchanged', () => {
  const source = input(), original = structuredClone(source);
  const withoutGithub = input();
  delete withoutGithub.github;
  for (const entry of withoutGithub.changelog) delete entry.github;
  const { github, ...actual } = authoring(source);
  assert.deepEqual(actual, authoring(withoutGithub));
  assert.deepEqual(source, original);
  assert.equal(actual.notes.groups.length, 4);
  assert.equal(actual.notes.changelog.at(-1).kind, 'changed');
  assert.equal(actual.popup.changelog.at(-1).audience, 'platform');
  assert.equal(actual.popup.changelog[0].title, source.changelog[0].popup.title);
  const release = { releaseId: 'dispatch_0.0.1', sourceCommit: 'a'.repeat(40), changelog: actual.changelog };
  assert.ok(releaseNotes({ schemaVersion: 1, releaseId: release.releaseId, sourceCommit: release.sourceCommit, ...actual.notes }, release));
  assert.equal(github.changes.at(-1).maintenance, true);
});

test('changed maps to Improved, removed remains visible, and empty sections are omitted', () => {
  const source = input();
  source.changelog.at(-1).github.maintenance = false;
  source.changelog[1].kind = 'removed';
  const body = render(source);
  assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['New', 'Improved', 'Fixed', 'Removed']);
  assert.match(body, /## Improved[\s\S]*#107[\s\S]*## Fixed/);
  const legacy = authoring([{ ...authoring(source).changelog[0], kind: 'fixed' }]);
  assert.deepEqual([...markdown('0.0.1', legacy.changelog, legacy.notes).matchAll(/^## (.+)$/gm)].map(match => match[1]), ['Fixed']);
});

test('required actions stay prominent and complete details use a disclosure under their entry', () => {
  const source = input();
  source.afterUpdating = [{ title: 'Action', description: 'Required action.', audience: 'dsp' }];
  source.changelog[0].details = 'First paragraph.\n\nSecond paragraph.';
  const body = render(source);
  assert.ok(body.indexOf('## After updating') < body.indexOf('## New'));
  assert.ok(body.includes('- **Action** — Required action\\.'));
  assert.ok(body.includes('  <details>\n  <summary>Details</summary>\n\n  First paragraph\\.\n  \n  Second paragraph\\.\n\n  </details>'));
});

test('old rich inputs, entry-only metadata, and first releases work without fabricated comparison links', () => {
  const source = input();
  delete source.github;
  assert.doesNotMatch(render(source), /Full changelog/);
  assert.match(render(source), /\/pull\/101/);
  for (const entry of source.changelog) delete entry.github;
  assert.equal(authoring(source).github, undefined);
  assert.match(render(source), /## New/);
  assert.doesNotMatch(render(source), /Full changelog|\/pull\//);
  for (const entry of source.changelog) { delete entry.audience; delete entry.popup; }
  source.github = { summary: fixture.github.summary };
  assert.equal(authoring(source).popup, undefined);
  assert.doesNotMatch(render(source), /Full changelog/);
});

test('plain-text copy cannot create headings, raw HTML, or authored Markdown links', () => {
  const source = input();
  source.github.summary = '<img src=x> [link](https://example.test)';
  source.changelog[0].title = '**text**';
  source.changelog[0].details = '</details>\n## Injected';
  const body = render(source);
  assert.ok(body.includes('&lt;img src=x&gt; \\[link\\]\\(https://example\\.test\\)'));
  assert.ok(body.includes('\\*\\*text\\*\\*'));
  assert.ok(body.includes('&lt;/details&gt;\n  \\#\\# Injected'));
  assert.doesNotMatch(body, /<img|^## Injected/m);
});

test('comparison links preserve hotfix tags and encode tag path segments', () => {
  const source = input();
  source.github.previousTag = '0.0.7+hotfix.1';
  assert.match(render(source), /compare\/0\.0\.7%2Bhotfix\.1\.\.\.0\.0\.1/);
  source.github.previousTag = 'releases/0.0.0';
  assert.match(render(source), /compare\/releases%2F0\.0\.0\.\.\.0\.0\.1/);
});

test('each PR retains its own author inline, including bots and legacy references', () => {
  const source = input();
  source.changelog[0].github.pullRequests = [
    { number: 101, author: 'first-author' },
    { number: 108, author: 'dependabot[bot]' },
    109,
  ];
  const body = render(source);
  const line = body.split('\n').find(line => line.includes('PR #101'));
  assert.ok(line.includes('by [@first\\-author](https://github.com/first-author) · [PR #101](https://github.com/example-organization/dispatch-platform/pull/101); by [@dependabot\\[bot\\]](https://github.com/dependabot%5Bbot%5D) · [PR #108](https://github.com/example-organization/dispatch-platform/pull/108); [PR #109](https://github.com/example-organization/dispatch-platform/pull/109)'));
  assert.ok(body.indexOf('PR #101') < body.indexOf('<details>'));
  assert.doesNotMatch(line, /github-actions|by undefined/);
});

for (const [name, mutate] of [
  ['null metadata', n => n.github = null],
  ['unsupported field', n => n.github.url = 'https://example.test'],
  ['empty summary', n => n.github.summary = ''],
  ['multiline summary', n => n.github.summary = 'one\ntwo'],
  ['oversized summary', n => n.github.summary = 'x'.repeat(601)],
  ['invalid tag', n => n.github.previousTag = 'tag?query'],
  ['null entry metadata', n => n.changelog[0].github = null],
  ['unsupported entry field', n => n.changelog[0].github.summary = 'text'],
  ['nonboolean maintenance', n => n.changelog[0].github.maintenance = 'true'],
  ['duplicate PR', n => n.changelog[0].github.pullRequests = [101, 101]],
  ['duplicate attributed PR', n => n.changelog[0].github.pullRequests = [{ number: 101, author: 'one' }, { number: 101, author: 'two' }]],
  ['duplicate mixed PR', n => n.changelog[0].github.pullRequests = [101, { number: 101, author: 'one' }]],
  ['missing author', n => n.changelog[0].github.pullRequests = [{ number: 101 }]],
  ['empty author', n => n.changelog[0].github.pullRequests = [{ number: 101, author: '' }]],
  ['author URL', n => n.changelog[0].github.pullRequests = [{ number: 101, author: 'https://example.test' }]],
  ['author markup', n => n.changelog[0].github.pullRequests = [{ number: 101, author: 'name](https://example.test)' }]],
  ['null reference', n => n.changelog[0].github.pullRequests = [null]],
  ['unsupported reference field', n => n.changelog[0].github.pullRequests = [{ number: 101, author: 'one', url: 'https://example.test' }]],
  ['invalid PR', n => n.changelog[0].github.pullRequests = [0]],
  ['noninteger PR', n => n.changelog[0].github.pullRequests = [1.5]],
  ['string PR', n => n.changelog[0].github.pullRequests = ['101']],
  ['too many PRs', n => n.changelog[0].github.pullRequests = Array.from({ length: 21 }, (_, i) => i + 1)],
]) test(`GitHub authoring rejects ${name}`, () => {
  const source = input(); mutate(source);
  assert.throws(() => authoring(source), { code: 'release_notes_invalid' });
});
