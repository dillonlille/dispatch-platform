'use strict';
// GitHub-only authoring metadata never enters the installation manifest, rich
// Updates sidecar, or dashboard popup.
const REPO = 'https://github.com/example-organization/dispatch-platform';
const fail = () => { throw Object.assign(new Error('release_notes_invalid'), { code: 'release_notes_invalid' }); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function pullRequests(value) {
  if (!Array.isArray(value) || value.length > 20) fail();
  const numbers = new Set();
  for (const reference of value) {
    const number = typeof reference === 'number' ? reference : reference?.number;
    if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number)) fail();
    numbers.add(number);
    // Integer references remain readable for older authoring inputs. New inputs
    // pair each PR with its verified GitHub author login, including bot logins.
    if (typeof reference !== 'number') {
      fields(reference, ['number', 'author']);
      if (typeof reference.author !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/.test(reference.author)) fail();
    }
  }
}
function githubAuthoring(input) {
  if (!input || Array.isArray(input)) return { input };
  const hasSummary = Object.hasOwn(input, 'github');
  const hasEntries = input.changelog?.some(change => Object.hasOwn(change, 'github'));
  if (!hasSummary && !hasEntries) return { input };
  if (!Array.isArray(input.changelog)) fail();
  const metadata = hasSummary ? input.github : {};
  fields(metadata, ['summary', 'previousTag']);
  if (Object.hasOwn(metadata, 'summary') && (typeof metadata.summary !== 'string'
    || !metadata.summary.trim() || metadata.summary.length > 600 || /[\x00-\x1f\x7f]/.test(metadata.summary))) fail();
  if (Object.hasOwn(metadata, 'previousTag') && (typeof metadata.previousTag !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/+\-]{0,159}$/.test(metadata.previousTag))) fail();
  const changes = input.changelog.map(change => {
    const github = Object.hasOwn(change, 'github') ? change.github : {};
    fields(github, ['pullRequests', 'maintenance']);
    if (Object.hasOwn(github, 'maintenance') && typeof github.maintenance !== 'boolean') fail();
    if (Object.hasOwn(github, 'pullRequests')) pullRequests(github.pullRequests);
    return github;
  });
  const { github, ...content } = input;
  return { input: { ...content, changelog: input.changelog.map(({ github, ...change }) => change) },
    github: { ...metadata, changes } };
}
// All authored fields are plain text. Only the renderer supplies Markdown and links.
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, '\\$&');
function markdown(version, changelog, notes, github = {}) {
  const entries = (notes?.changelog || changelog).map((item, index) => ({ ...item, github: github.changes?.[index] || {} }));
  const category = item => item.github.maintenance ? 'Maintenance'
    : ({ added: 'New', changed: 'Improved', improved: 'Improved', fixed: 'Fixed', removed: 'Removed' })[item.kind];
  const row = item => {
    const title = escape(item.title);
    const description = item.description ? ` — ${escape(item.description)}` : '';
    const links = item.github.pullRequests?.length ? ` ${item.github.pullRequests.map(reference => {
      const { number, author } = typeof reference === 'number' ? { number: reference } : reference;
      const credit = author ? `by [@${escape(author)}](https://github.com/${encodeURIComponent(author)}) · ` : '';
      return `${credit}[PR #${number}](${REPO}/pull/${number})`;
    }).join('; ')}` : '';
    const details = item.details ? `\n\n  <details>\n  <summary>Details</summary>\n\n  ${escape(item.details).replaceAll('\n', '\n  ')}\n\n  </details>\n` : '';
    return `- **${title}**${description}${links}${details}`;
  };
  // The release page already displays its title; its body starts with the summary.
  const sections = [];
  if (github.summary) sections.push(escape(github.summary));
  if (notes?.afterUpdating.length) sections.push(`## After updating\n\n${notes.afterUpdating.map(item => `- **${escape(item.title)}** — ${escape(item.description)}`).join('\n')}`);
  for (const heading of ['New', 'Improved', 'Fixed', 'Removed', 'Maintenance']) {
    const items = entries.filter(item => category(item) === heading);
    if (items.length) sections.push(`## ${heading}\n\n${items.map(row).join('\n')}`);
  }
  if (github.previousTag) sections.push(`---\n\n[Full changelog](${REPO}/compare/${encodeURIComponent(github.previousTag)}...${encodeURIComponent(version)})`);
  return `${sections.join('\n\n')}\n`;
}
module.exports = { githubAuthoring, markdown };
