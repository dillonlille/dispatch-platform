'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AccessError } = require('../accounts/src');
const { exactHttpsOrigin } = require('./invitation-email');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const KEY_RE = /^[A-Za-z0-9_-]{20,128}$/;

function invalidConfig() { throw new Error('turnstile_config_invalid'); }

function readSecret(file) {
  let descriptor;
  try {
    const parent = path.dirname(file), directory = fs.lstatSync(parent), before = fs.lstatSync(file);
    if (!directory.isDirectory() || directory.uid !== process.geteuid()
        || (directory.mode & 0o7777) !== 0o700 || fs.realpathSync(parent) !== parent
        || !before.isFile() || before.isSymbolicLink() || before.uid !== process.geteuid()
        || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size > 256) invalidConfig();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.mode !== before.mode || opened.uid !== before.uid || opened.nlink !== 1) invalidConfig();
    const secret = fs.readFileSync(descriptor, 'utf8').replace(/\r?\n$/, '');
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !KEY_RE.test(secret)) invalidConfig();
    return secret;
  } catch { invalidConfig(); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function createTurnstile({ siteKey, secret, hostname, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (typeof siteKey !== 'string' || !KEY_RE.test(siteKey) || typeof secret !== 'string' || !KEY_RE.test(secret)
      || typeof hostname !== 'string' || !/^[a-z0-9.-]+$/.test(hostname)
      || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) invalidConfig();
  return Object.freeze({
    publicConfig: Object.freeze({ siteKey }),
    async verify(token, action, remoteip) {
      if (!['login', 'register', 'forgot_password'].includes(action)) invalidConfig();
      if (typeof token !== 'string' || token.length < 1 || token.length > 2048 || /\s/.test(token)) {
        throw new AccessError('turnstile_required', 400);
      }
      let result;
      try {
        const response = await fetchImpl(SITEVERIFY_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json' },
          // Never send account credentials, invitation tokens, or form contents.
          body: JSON.stringify({ secret, response: token, ...(remoteip ? { remoteip } : {}) }),
        });
        if (!response.ok) throw new Error('siteverify_unavailable');
        result = await response.json();
        if (typeof result?.success !== 'boolean') throw new Error('siteverify_invalid_response');
      } catch { throw new AccessError('turnstile_unavailable', 503); }
      if (!result.success || result.hostname !== hostname || result.action !== action) {
        throw new AccessError('turnstile_invalid', 403);
      }
    },
  });
}

function turnstileFromEnvironment({ environment = process.env, paths, publicOrigin, fetchImpl } = {}) {
  const siteKey = environment.DISPATCH_TURNSTILE_SITE_KEY;
  if (siteKey === undefined) return null;
  try { exactHttpsOrigin(publicOrigin); } catch { invalidConfig(); }
  if (!paths || typeof paths.secretsRoot !== 'string' || !path.isAbsolute(paths.secretsRoot)
      || path.resolve(paths.secretsRoot) !== paths.secretsRoot) invalidConfig();
  const secret = readSecret(path.join(paths.secretsRoot, 'turnstile', 'secret-key'));
  // Cloudflare's dummy keys must never activate a public installation.
  if (/^[123]x/.test(siteKey) || /^[123]x/.test(secret)) invalidConfig();
  return createTurnstile({ siteKey, secret, hostname: new URL(publicOrigin).hostname, fetchImpl });
}

module.exports = { SITEVERIFY_URL, createTurnstile, turnstileFromEnvironment };
