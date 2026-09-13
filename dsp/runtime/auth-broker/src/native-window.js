'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { resolveRootExecutable, trustedCommandPath } = require('dispatch-protocol/trusted-command-path');
const { boundedJson } = require('./cdp');

const WIDTH = 1600, HEIGHT = 1100;
function failure(code = 'browser_start_failed') { return Object.assign(new Error(code), { code }); }
function cancelled(signal) { if (signal?.aborted) throw failure('acquisition_cancelled'); }

function authorityRecord(cookie, display = '') {
  const field = value => {
    const bytes = Buffer.from(value), length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  // The server reads the cookie before its display number is allocated. Update
  // the client lookup number after -displayfd returns; the cookie never changes.
  return Buffer.concat([Buffer.from([255, 255]), field(''), field(display),
    field('MIT-MAGIC-COOKIE-1'), field(cookie)]);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  if (port < 1024) throw failure();
  return port;
}

async function waitForWindowBrowser(port, child, timeoutMs, signal) {
  const endpoint = `http://127.0.0.1:${port}`, deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    cancelled(signal);
    if (child.__dispatchSpawnError || child.exitCode !== null || child.signalCode !== null) throw failure();
    try {
      const version = await boundedJson(`${endpoint}/json/version`, { timeoutMs: 500, signal });
      const socket = new URL(version.webSocketDebuggerUrl);
      if (socket.protocol !== 'ws:' || socket.hostname !== '127.0.0.1' || Number(socket.port) !== port
          || socket.username || socket.password || socket.search || socket.hash
          || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(socket.pathname)) throw failure();
      return { endpoint, browserWebSocketUrl: socket.href };
    } catch { cancelled(signal); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw failure();
}

async function createNativeWindow({ directory, launcher, signal }) {
  cancelled(signal);
  const xvfb = resolveRootExecutable(undefined, ['Xvfb']);
  const python = resolveRootExecutable(undefined, ['python3']);
  if (!xvfb || !python) throw failure('browser_unavailable');
  const root = fs.mkdtempSync(path.join(directory, 'native-window-'));
  fs.chmodSync(root, 0o700);
  const authority = path.join(root, 'Xauthority'), cookie = crypto.randomBytes(16);
  fs.writeFileSync(authority, authorityRecord(cookie), { mode: 0o600, flag: 'wx' });
  const env = { PATH: trustedCommandPath(), HOME: root, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', XAUTHORITY: authority };
  let display, closed = false, closing = null;
  const inputs = new Set();
  const { waitForGroupExit, processGroupAlive } = require('./browser-runtime');
  const close = async () => {
    if (closed) return;
    if (closing) return closing;
    closing = (async () => {
      for (const child of inputs) child.kill('SIGKILL');
      if (display?.pid) {
        try { process.kill(-display.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw failure('browser_cleanup_failed'); }
        if (!(await waitForGroupExit(display.pid, 2000))) {
          try { process.kill(-display.pid, 'SIGKILL'); } catch {}
          if (!(await waitForGroupExit(display.pid, 2000))) throw failure('browser_cleanup_failed');
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      closed = true;
    })();
    try { await closing; } finally { closing = null; }
  };
  try {
    display = spawn(launcher, ['--pdeathsig', 'KILL', '--', xvfb, '-displayfd', '3',
      '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-noreset', '-auth', authority], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env,
    });
    const number = await new Promise((resolve, reject) => {
      let bytes = '';
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        display.stdio[3].off('data', data); display.off('exit', exited);
      };
      const fail = code => { cleanup(); reject(failure(code)); };
      const aborted = () => { display.kill('SIGKILL'); fail('acquisition_cancelled'); };
      const exited = () => fail('browser_start_failed');
      const data = chunk => {
        bytes += chunk.toString('ascii');
        if (bytes.length > 16 || !/^[0-9]*\n?$/.test(bytes)) return fail('browser_start_failed');
        if (bytes.endsWith('\n')) {
          const value = Number(bytes.trim());
          if (!Number.isInteger(value) || value < 0 || value > 65535) return fail('browser_start_failed');
          cleanup(); resolve(String(value));
        }
      };
      const timer = setTimeout(() => fail('browser_start_failed'), 10000);
      display.on('error', exited); display.once('exit', exited); display.stdio[3].on('data', data);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    env.DISPLAY = `:${number}`;
    fs.writeFileSync(authority, authorityRecord(cookie, number), { mode: 0o600 });
    cookie.fill(0);
    cancelled(signal);
    const alive = () => !closed && !closing && display.exitCode === null && display.signalCode === null && processGroupAlive(display.pid);
    const input = async (actions, inputSignal) => {
      cancelled(inputSignal);
      if (!alive()) throw failure('manual_verification_required');
      await new Promise((resolve, reject) => {
        const child = spawn(launcher, ['--pdeathsig', 'KILL', '--', python, path.join(__dirname, 'native-input.py')], {
          stdio: ['pipe', 'ignore', 'ignore'], env,
        });
        inputs.add(child);
        const aborted = () => child.kill('SIGKILL');
        const timer = setTimeout(aborted, 15000);
        const finish = ok => {
          clearTimeout(timer); inputs.delete(child); inputSignal?.removeEventListener('abort', aborted);
          ok ? resolve() : reject(failure(inputSignal?.aborted ? 'acquisition_cancelled' : 'manual_verification_required'));
        };
        child.once('error', () => finish(false)); child.once('exit', code => finish(code === 0));
        inputSignal?.addEventListener('abort', aborted, { once: true });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(actions));
        if (inputSignal?.aborted) aborted();
      });
    };
    return {
      env, close, isAlive: alive,
      onExit(listener) { display.on('exit', listener); return () => display.off('exit', listener); },
      input: {
        async click(connection, x, y, inputSignal) {
          cancelled(inputSignal);
          await connection.command('Page.bringToFront');
          const geometry = await connection.evaluate('({x:screenX+(outerWidth-innerWidth)/2,y:screenY+outerHeight-innerHeight,scale:devicePixelRatio})');
          if (geometry?.scale !== 1 || ![x, y, geometry.x, geometry.y].every(Number.isFinite)) throw failure('manual_verification_required');
          const a = Math.round(x + geometry.x), b = Math.round(y + geometry.y);
          if (a < 0 || a >= WIDTH || b < 0 || b >= HEIGHT) throw failure('manual_verification_required');
          await input([{ action: 'click', x: a, y: b }], inputSignal);
        },
        async type(text, inputSignal) {
          if (typeof text !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(text)) throw failure('manual_verification_required');
          await input([{ action: 'text', text }], inputSignal);
        },
      },
    };
  } catch (error) {
    cookie.fill(0);
    await close();
    throw error;
  }
}

module.exports = { createNativeWindow, reservePort, waitForWindowBrowser };
