'use strict';
const crypto = require('node:crypto');
function fail() { throw Object.assign(new Error('first_publication_failed'), { code: 'first_publication_failed' }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function publicationBaseline(value) {
  exact(value, ['version', 'target', 'publications', 'digest']);
  if (value.version !== 1 || typeof value.target !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.target)) fail();
  exact(value.publications, ['payPeriods', 'roster', 'timecards', 'resourceLinks']);
  const publications = {};
  for (const name of ['payPeriods', 'roster', 'timecards', 'resourceLinks']) {
    const item = value.publications[name];
    exact(item, ['id', 'originRunId', 'contentSha256']);
    if (![item.id, item.originRunId].every(text => typeof text === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(text))
        || typeof item.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentSha256)) fail();
    publications[name] = { id: item.id, originRunId: item.originRunId, contentSha256: item.contentSha256 };
  }
  const body = { version: 1, target: value.target, publications };
  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (value.digest !== digest) fail();
  return Object.freeze({ ...body, digest });
}
function createPublicationBaseline(target, publications) {
  const body = { version: 1, target, publications };
  return publicationBaseline({ ...body, digest: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') });
}
module.exports = { publicationBaseline, createPublicationBaseline };
