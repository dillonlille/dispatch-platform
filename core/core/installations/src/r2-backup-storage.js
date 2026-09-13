'use strict';
// Root-only storage administration. Fixed hosts, bounded responses, no redirects
// and no credentials in argv, logs, tenant environments or public receipts.
const https = require('node:https'),
  crypto = require('node:crypto'),
  fs = require('node:fs');
const { privateJson, atomic } = require('./release-delivery-files');
function fail() {
  throw Object.assign(Error('backup_storage_unavailable'), { code: 'backup_storage_unavailable' });
}
function http(url, method, headers, body = '') {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 30000 }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) req.destroy(Error());
        else chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('timeout', () => req.destroy(Error()));
    req.on('error', () =>
      reject(
        Object.assign(Error('backup_storage_unavailable'), { code: 'backup_storage_unavailable' }),
      ),
    );
    req.end(body);
  });
}
function readCredentials() {
  const credential = privateJson('/etc/dispatch/offsite-backup-credentials.json', 0);
  const managementFile = '/etc/dispatch/cloudflare-r2-management-token';
  const file = fs.lstatSync(managementFile);
  if (
    file.uid !== 0 ||
    !file.isFile() ||
    file.nlink !== 1 ||
    file.mode & 0o077 ||
    fs.realpathSync(managementFile) !== managementFile
  )
    fail();
  const token = fs.readFileSync(managementFile, 'utf8').trim();
  if (!/^[!-~]{20,512}$/.test(token)) fail();
  return { credential, token };
}
function createR2BackupStorage(config, { request = http, credentials = readCredentials(), journalFile = '/var/lib/dispatch-backup/deletion-locks.json', ownerUid = 0 } = {}) {
  const { credential, token } = credentials;
  async function control(method, suffix, body) {
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/r2/buckets/${config.bucket}${suffix}`,
      method,
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body ? JSON.stringify(body) : '',
    );
    let value;
    try {
      value = JSON.parse(response.body);
    } catch {
      fail();
    }
    if (response.status < 200 || response.status >= 300 || value.success !== true) fail();
    return value.result;
  }
  async function ensureLocks() {
    await restoreDeletionLocks();
    const current = await control('GET', '/lock'),
      rules = current?.rules || [];
    let changed = false;
    for (const days of [null, 7, 30, 90, 365]) {
      const tier = days === null ? 'all' : String(days),
        id = `dispatch-archives-${tier}`;
      const desired = {
        id,
        enabled: true,
        prefix: `archives/${tier}/`,
        condition:
          days === null ? { type: 'Indefinite' } : { type: 'Age', maxAgeSeconds: days * 86400 },
      };
      const existing = rules.find((r) => r.id === id);
      if (existing) {
        if (
          JSON.stringify(existing.condition) !== JSON.stringify(desired.condition) ||
          existing.prefix !== desired.prefix ||
          !existing.enabled
        )
          fail();
      } else {
        rules.push(desired);
        changed = true;
      }
    }
    const artifactRule = { id: 'dispatch-recovery-artifacts', enabled: true, prefix: 'recovery-artifacts/', condition: { type: 'Indefinite' } };
    const existingArtifactRule = rules.find(rule => rule.id === artifactRule.id);
    if (existingArtifactRule && (existingArtifactRule.prefix !== artifactRule.prefix || !existingArtifactRule.enabled
        || existingArtifactRule.condition?.type !== 'Indefinite')) fail();
    if (!existingArtifactRule) { rules.push(artifactRule); changed = true; }
    if (changed) await control('PUT', '/lock', { rules });
    const confirmed = await control('GET', '/lock');
    for (const rule of rules.filter((r) => r.id.startsWith('dispatch-archives-') || r.id === 'dispatch-recovery-artifacts')) {
      const actual = confirmed.rules.find((r) => r.id === rule.id);
      if (
        !actual?.enabled ||
        actual.prefix !== rule.prefix ||
        JSON.stringify(actual.condition) !== JSON.stringify(rule.condition)
      )
        fail();
    }
  }
  const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const encode = (s) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  async function s3(method, key = '', query = {}) {
    const host = `${config.accountId}.r2.cloudflarestorage.com`,
      uri = `/${config.bucket}/${key.split('/').map(encode).join('/')}`;
    const queryString = Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .join('&');
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
      date = stamp.slice(0, 8),
      scope = `${date}/auto/s3/aws4_request`;
    const headers = `host:${host}\nx-amz-content-sha256:${hash('')}\nx-amz-date:${stamp}\n`,
      signed = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, uri, queryString, headers, signed, hash('')].join('\n');
    const sign = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
    const keyBytes = sign(
      sign(sign(sign(`AWS4${credential.secretAccessKey}`, date), 'auto'), 's3'),
      'aws4_request',
    );
    const signature = crypto
      .createHmac('sha256', keyBytes)
      .update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`)
      .digest('hex');
    const auth = `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    return request(`https://${host}${uri}${queryString ? '?' + queryString : ''}`, method, {
      Authorization: auth,
      'x-amz-date': stamp,
      'x-amz-content-sha256': hash(''),
    });
  }
  async function removeExpired(record, now = Date.now()) {
    if (
      ![7, 30, 90, 365].includes(record.retentionDays) ||
      !Number.isSafeInteger(record.expiresAt) ||
      now < record.expiresAt ||
      !/^(backup|breq)_[a-f0-9]{32}$/.test(record.id)
    )
      fail();
    return removePermanent(record);
  }
  async function listSets() {
    const ids=[];let continuation;
    for(let page=0;page<1000;page++) {
      const response=await s3('GET','',{'list-type':'2',prefix:'sets/',delimiter:'/', 'encoding-type':'url','max-keys':'1000',...(continuation?{'continuation-token':continuation}:{})});
      if(response.status!==200 || !response.body.includes('<ListBucketResult')) fail();
      for(const match of response.body.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>\s*<\/CommonPrefixes>/g)){
        const prefix=decodeURIComponent(match[1]);if(!/^sets\/breq_[a-f0-9]{32}\/$/.test(prefix))fail();ids.push(prefix.split('/')[1]);
      }
      if(!/<IsTruncated>\s*true\s*<\/IsTruncated>/.test(response.body))return ids;
      continuation=/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(response.body)?.[1].replaceAll('&amp;','&');
      if(!continuation)fail();
    }
    fail();
  }
  async function listArchives() {
    const result = [];
    for (const retentionDays of [null, 7, 30, 90, 365]) {
      const tier = retentionDays === null ? 'all' : String(retentionDays), prefix = `archives/${tier}/`;
      let continuation;
      for (let page = 0; page < 1000; page++) {
        const response = await s3('GET', '', { 'list-type': '2', prefix, delimiter: '/', 'encoding-type': 'url', 'max-keys': '1000',
          ...(continuation ? { 'continuation-token': continuation } : {}) });
        if (response.status !== 200 || !response.body.includes('<ListBucketResult')) fail();
        for (const match of response.body.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>\s*<\/CommonPrefixes>/g)) {
          const selected = decodeURIComponent(match[1]), id = selected.slice(prefix.length, -1);
          if (!selected.startsWith(prefix) || !selected.endsWith('/') || !/^(backup|breq)_[a-f0-9]{32}$/.test(id)) fail();
          result.push({ id, retentionDays });
        }
        if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/.test(response.body)) break;
        continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(response.body)?.[1].replaceAll('&amp;', '&');
        if (!continuation || page === 999) fail();
      }
    }
    return result;
  }
  // Count encrypted objects, including repository metadata, rather than the
  // uncompressed recovery payload. Listing is read-only and fully paginated.
  async function usage() {
    const archives = {}, sets = {};
    let legacyBytes = 0, artifactBytes = 0;
    const add = (a, b) => { const n = a + b; if (!Number.isSafeInteger(n)) fail(); return n; };
    for (const prefix of ['archives/', 'sets/', 'recovery-artifacts/', ...(config.prefix ? [`${config.prefix}/`] : [])]) {
      const tokens = new Set(), keys = new Set();
      let continuation;
      for (let page = 0; page < 1000; page++) {
        const response = await s3('GET', '', {'list-type':'2', prefix, 'encoding-type':'url', 'max-keys':'1000', ...(continuation ? {'continuation-token':continuation} : {})});
        const body = response.body;
        if (response.status !== 200 || !body.includes('<ListBucketResult') || !body.includes('</ListBucketResult>')) fail();
        const contents = [...body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
        if ((body.match(/<Contents>/g) || []).length !== contents.length) fail();
        for (const [, item] of contents) {
          const rawKey = /<Key>([^<]*)<\/Key>/.exec(item)?.[1], rawSize = /<Size>(\d+)<\/Size>/.exec(item)?.[1];
          if (!rawKey || rawSize === undefined) fail();
          const key = decodeURIComponent(rawKey), size = Number(rawSize);
          if (!key.startsWith(prefix) || keys.has(key) || !Number.isSafeInteger(size) || size < 0) fail();
          keys.add(key);
          if (prefix === 'archives/') {
            const match = /^archives\/(?:all|7|30|90|365)\/((?:backup|breq)_[a-f0-9]{32})\/[a-z0-9/]+$/.exec(key);
            if (!match) fail();
            archives[match[1]] = add(archives[match[1]] || 0, size);
          } else if (prefix === 'sets/') {
            const match = /^sets\/(breq_[a-f0-9]{32})\/[a-z0-9/]+$/.exec(key);
            if (!match) fail();
            sets[match[1]] = add(sets[match[1]] || 0, size);
          } else if (prefix === 'recovery-artifacts/') {
            if (!/^recovery-artifacts\/[a-f0-9]{64}\/[a-z0-9/]+$/.test(key)) fail();
            artifactBytes = add(artifactBytes, size);
          } else legacyBytes = add(legacyBytes, size);
        }
        const truncated = /<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/.exec(body)?.[1];
        if (!truncated) fail();
        if (truncated === 'false') break;
        continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1]
          .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
        if (!continuation || tokens.has(continuation) || page === 999) fail();
        tokens.add(continuation);
      }
    }
    return {archives, sets, legacyBytes, artifactBytes};
  }
  async function removePermanent(record) {
    if (![null, 7, 30, 90, 365].includes(record.retentionDays)
        || !/^(backup|breq)_[a-f0-9]{32}$/.test(record.id)) fail();
    const prefix = `archives/${record.retentionDays === null ? 'all' : record.retentionDays}/${record.id}/`;
    return removePrefix(prefix);
  }
  async function removeSet(id) {
    if(!/^breq_[a-f0-9]{32}$/.test(id))fail();
    return removePrefix(`sets/${id}/`);
  }
  async function removePrefix(prefix) {
    // Re-list the first page after each batch, avoiding deletion-pagination races.
    for (let page = 0; page < 1000; page++) {
      const response = await s3('GET', '', {
        'list-type': '2',
        prefix,
        'encoding-type': 'url',
        'max-keys': '1000',
      });
      if (response.status !== 200 || !response.body.includes('<ListBucketResult') || !response.body.includes('</ListBucketResult>')) fail();
      const keys = [...response.body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) =>
        decodeURIComponent(m[1]),
      );
      if (
        keys.some(
          (k) =>
            !k.startsWith(prefix) ||
            !/^(archives\/(all|7|30|90|365)\/(backup|breq)_[a-f0-9]{32}|sets\/breq_[a-f0-9]{32})\/[a-z0-9/]+$/.test(k),
        )
      )
        fail();
      if (!keys.length) {
        if (response.body.includes('<Contents>') || /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(response.body)) fail();
        return;
      }
      for (const key of keys) {
        const deleted = await s3('DELETE', key);
        if (deleted.status !== 204) fail();
      }
    }
    fail();
  }
  const canonical = value => value && typeof value === 'object'
    ? JSON.stringify(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : JSON.stringify(value);
  const deletionPrefixes = () => [
    ...['all', 7, 30, 90, 365].map(tier => `archives/${tier}/`),
    ...['data/', 'index/', 'snapshots/'].map(part => `${config.prefix}/${part}`),
  ];
  async function restoreDeletionLocks() {
    if (!fs.existsSync(journalFile)) return;
    const journal = privateJson(journalFile, ownerUid);
    if (journal.accountId !== config.accountId || journal.bucket !== config.bucket
        || !Array.isArray(journal.rules) || journal.rules.some(rule => !deletionPrefixes().includes(rule.prefix))) fail();
    const current = await control('GET', '/lock');
    const rules = current.rules.filter(rule => !journal.rules.some(saved => saved.id === rule.id));
    rules.push(...journal.rules);
    await control('PUT', '/lock', { rules });
    const restored = await control('GET', '/lock');
    if (journal.rules.some(rule => !restored.rules.some(actual => canonical(actual) === canonical(rule)))) fail();
    fs.unlinkSync(journalFile);
  }
  async function withDeletionAccess(prefixes, callback) {
    if (!Array.isArray(prefixes) || prefixes.some(prefix => !deletionPrefixes().includes(prefix))) fail();
    await restoreDeletionLocks();
    const current = await control('GET', '/lock');
    if (!Array.isArray(current.rules)) fail();
    // A broader administrator-defined lock is not ours to weaken.
    if (current.rules.some(rule => rule.enabled && prefixes.some(prefix => prefix.startsWith(rule.prefix || '')
        && !prefixes.includes(rule.prefix)))) fail();
    const removed = current.rules.filter(rule => prefixes.includes(rule.prefix));
    atomic(journalFile, { accountId: config.accountId, bucket: config.bucket, rules: removed });
    try {
      await control('PUT', '/lock', { rules: current.rules.filter(rule => !prefixes.includes(rule.prefix)) });
      const unlocked = await control('GET', '/lock');
      if (unlocked.rules.some(rule => rule.enabled && prefixes.includes(rule.prefix))) fail();
      return await callback();
    } finally {
      // The durable journal also restores locks before the next scan after a crash.
      await restoreDeletionLocks();
    }
  }
  return { usage, removeSet, listSets, ensureLocks, removeExpired, removePermanent, withDeletionAccess, restoreDeletionLocks, listArchives };
}
module.exports = { createR2BackupStorage };
