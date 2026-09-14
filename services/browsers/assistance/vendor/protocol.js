'use strict';

const QUEUE_MS = 30_000;
const SOLVE_MS = 200_000;
const REQUEST_MS = QUEUE_MS + SOLVE_MS + 20_000;
const AUTH_REQUEST_MS = 390_000;
const SOCKET_NAME = /^a-[a-f0-9]{12}\.sock$/;
const BROWSER_PATH = /^\/devtools\/browser\/[A-Za-z0-9_-]{1,80}$/;
const PHASES = new Set(['queued', 'solving', 'verifying']);
function fail(code = 'assistance_invalid') { throw Object.assign(new Error(code), { code }); }
function request(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'browserPath,pluginId,socketName,type'
      || value.type !== 'captcha' || value.pluginId !== 'paycom'
      || !SOCKET_NAME.test(value.socketName) || !BROWSER_PATH.test(value.browserPath)) fail();
  return { ...value };
}
module.exports = { QUEUE_MS, SOLVE_MS, REQUEST_MS, AUTH_REQUEST_MS, SOCKET_NAME, BROWSER_PATH, PHASES, request, fail };
