import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startPreview } from '../../tooling/dev/dev-server.js';
import { demo, until } from '../support/support.js';

test('parallel worktree previews isolate ports, files, fixtures and browser sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-preview-test-'));
  const worktrees = ['first', 'second'].map((name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(path.join(cwd, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'vite.config.ts'), 'export default {};');
    fs.writeFileSync(path.join(cwd, 'dashboard/index.html'), `<h1>${name} worktree</h1>`);
    fs.writeFileSync(
      path.join(cwd, 'dashboard/entry.js'),
      'export const value = 1; if (import.meta.hot) import.meta.hot.accept();',
    );
    return cwd;
  });
  const started = await Promise.allSettled(
    worktrees.map((cwd) => startPreview({ cwd, host: '127.0.0.1', port: 0 })),
  );
  const previews = started.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  t.after(async () => {
    try {
      await Promise.all(previews.map((preview) => preview.close()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const result of started) if (result.status === 'rejected') throw result.reason;
  const [first, second] = previews as [(typeof previews)[number], (typeof previews)[number]];
  assert.notEqual(first.origin, second.origin);
  assert.notEqual(first.root, second.root);
  for (const [index, preview] of previews.entries()) {
    const html = await (await fetch(preview.origin)).text();
    assert(html.includes(`${index === 0 ? 'first' : 'second'} worktree`));
    assert(html.includes('/@vite/client'));
  }

  const sockets = await Promise.all(
    previews.map(async ({ origin }) => {
      const client = await (await fetch(origin + '/@vite/client')).text();
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1];
      assert(token, 'Vite must supply its HMR token');
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/?token=' + token, 'vite-hmr');
      const messages: { type: string; updates?: { path: string }[] }[] = [];
      socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
      await until(async () => messages.some((message) => message.type === 'connected'));
      assert.equal((await fetch(origin + '/entry.js')).status, 200);
      return { socket, messages };
    }),
  );
  fs.writeFileSync(
    path.join(worktrees[0]!, 'dashboard/entry.js'),
    'export const value = 2; if (import.meta.hot) import.meta.hot.accept();',
  );
  await until(async () =>
    sockets[0]!.messages.some((message) =>
      message.updates?.some((update) => update.path === '/entry.js'),
    ),
  );
  assert(!sockets[1]!.messages.some((message) => message.type === 'update'));
  for (const { socket } of sockets) socket.close();

  // Entry links establish independent demo sessions in browsers with no cookies.
  const enter = async (preview: typeof first) => {
    const response = await fetch(preview.previewUrl, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const cookie = response.headers.getSetCookie()[0]!;
    assert(cookie.startsWith(`dispatch_preview_${new URL(preview.origin).port}=`));
    assert(cookie.includes('HttpOnly'));
    assert(cookie.includes('SameSite=Strict'));
    return cookie.split(';')[0]!;
  };
  const session = async (preview: typeof first, cookie: string) => {
    const response = await fetch(preview.origin + '/api/session', { headers: { cookie } });
    return { status: response.status, value: await response.json() };
  };
  const invalid = await fetch(first.origin + new URL(second.previewUrl).pathname);
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get('set-cookie'), null);
  const wrongMethod = await fetch(first.previewUrl, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('set-cookie'), null);
  const [firstBrowser, secondBrowser] = await Promise.all([enter(first), enter(first)]);
  assert.notEqual(firstBrowser, secondBrowser);
  const firstSession = await session(first, firstBrowser);
  const secondSession = await session(first, secondBrowser);
  for (const result of [firstSession, secondSession]) {
    assert.equal(result.status, 200);
    assert.equal(result.value.user.email, demo.email);
    assert.equal(result.value.user.platformOwner, true);
  }
  assert.equal((await session(second, firstBrowser)).status, 401);
  assert.equal((await session(second, await enter(second))).status, 200);
  const logout = await fetch(first.origin + '/api/auth/logout', {
    method: 'POST',
    headers: {
      origin: first.origin,
      cookie: firstBrowser,
      'content-type': 'application/json',
      'x-csrf-token': firstSession.value.csrf,
    },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal((await session(first, firstBrowser)).status, 401);
  assert.equal((await session(first, secondBrowser)).status, 200);
  assert.equal((await session(first, await enter(first))).status, 200);

  // A real browser sends all same-host cookies, regardless of their ports.
  const jar = new Map<string, string>();
  async function request(origin: string, url: string, body?: unknown, csrf?: string) {
    const response = await fetch(origin + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!;
      const equal = pair.indexOf('=');
      jar.set(pair.slice(0, equal), pair.slice(equal + 1));
      assert(cookie.includes('HttpOnly'));
      assert(cookie.includes('SameSite=Strict'));
      assert(!pair.startsWith('dispatch_session='));
    }
    return { status: response.status, value: await response.json() };
  }
  const signedIn = await request(first.origin, '/api/auth/login', {
    email: demo.email,
    password: demo.password,
  });
  assert.equal(signedIn.status, 200);
  const owner = await request(first.origin, '/api/session');
  assert.equal(owner.value.user.platformOwner, true);
  // Even copying a canonical session cookie cannot authenticate the other preview.
  jar.set('dispatch_session', [...jar.values()][0]!);
  assert.equal((await request(second.origin, '/api/session')).status, 401);
  assert.equal(
    (
      await request(second.origin, '/api/auth/login', {
        email: demo.member,
        password: demo.password,
      })
    ).status,
    200,
  );
  assert.equal(jar.size, 3);
  const member = await request(second.origin, '/api/session');
  assert.equal(member.value.user.platformOwner, false);
  assert.equal((await request(first.origin, '/api/session')).value.user.platformOwner, true);
  assert.notEqual(owner.value.user.id, member.value.user.id);
  assert.equal((await request(first.origin, '/api/auth/logout', {})).status, 403);
  assert.equal((await request(first.origin, '/api/auth/logout', {}, owner.value.csrf)).status, 200);
  assert.equal((await request(first.origin, '/api/session')).status, 401);
  assert.equal((await request(second.origin, '/api/session')).status, 200);

  // An explicit occupied port fails, without taking over or stopping its owner.
  await assert.rejects(
    startPreview({ host: '127.0.0.1', port: Number(new URL(first.origin).port) }),
    { code: 'EADDRINUSE' },
  );
  assert.equal((await fetch(first.origin)).status, 200);
  await first.close();
  assert.equal(fs.existsSync(first.root), false);
  assert.equal((await request(second.origin, '/api/session')).status, 200);
  await second.close();
  assert.equal(fs.existsSync(second.root), false);
});

test('preview configuration refuses public wildcard bindings and invalid ports', async () => {
  for (const host of ['0.0.0.0', '::', '[::]', '*'])
    await assert.rejects(startPreview({ host }), /must name one address/);
  for (const port of [-1, 65536, 1.5, NaN])
    await assert.rejects(startPreview({ port }), /must be an integer/);
});
