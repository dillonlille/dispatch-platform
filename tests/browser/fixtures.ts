import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import { fixture } from '../rust-support.js';

export const test = base.extend<{ dispatch: Awaited<ReturnType<typeof fixture>> }>({
  dispatch: async ({}, use) => {
    const app = await fixture({
      binary: path.resolve('.build/services/rust/dispatch-backend'),
      env: { DISPATCH_ARTIFACT_ROOT: path.resolve('.build') },
    });
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
  baseURL: async ({ dispatch }, use) => {
    await use(dispatch.env.DISPATCH_ORIGIN);
  },
});
export { expect };
