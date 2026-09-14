import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { configuration, type Config } from '../services/config.js';
import { seed, demo } from '../tooling/seed.js';
import type { DspView, SessionView } from '../shared/contracts/index.js';
export async function fixture(overrides: Partial<Config> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
  const result = await createApp(
    configuration({
      stateRoot: root,
      development: true,
      providerMode: 'fixture',
      origin: 'http://127.0.0.1:5173',
      ...overrides,
    }),
    { fixturePreview: true },
  );
  await seed(result.runtime);
  await result.app.ready();
  async function client(email = demo.email, password = demo.password) {
    const login = await result.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
      },
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const headers: Record<string, string> = {
      host: '127.0.0.1:5173',
      origin: 'http://127.0.0.1:5173',
      cookie,
      'content-type': 'application/json',
    };
    const response = await result.app.inject({ method: 'GET', url: '/api/session', headers }),
      session = response.json<SessionView>();
    headers['x-csrf-token'] = session.csrf;
    return {
      session,
      headers,
      async select(id: string) {
        const response = await result.app.inject({
          method: 'POST',
          url: '/api/session/dsp',
          headers,
          payload: { dspId: id },
        });
        assert.equal(response.statusCode, 200, response.body);
        const view = response.json<DspView>();
        headers['x-dispatch-view'] = view.token;
        return view;
      },
      get: (url: string) => result.app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown) =>
        result.app.inject({ method: 'POST', url, headers, payload: JSON.stringify(payload) }),
    };
  }
  return {
    ...result,
    root,
    client,
    async close() {
      await result.app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function until(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    assert(Date.now() - start < timeout, 'Condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
