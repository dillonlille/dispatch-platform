import { test as base, expect, type Page } from '@playwright/test';
import { built, demo, fixture, type FixtureOptions } from '../support.js';

type Dispatch = Awaited<ReturnType<typeof fixture>>;
export const test = base.extend<{
  /** Set with `test.use`, or override in `test.extend`, to change the server under test. */
  dispatchOptions: Pick<FixtureOptions, 'seed' | 'env'>;
  /** A private server of the built artifact with its own state, port and mail. */
  dispatch: Dispatch;
}>({
  dispatchOptions: [{}, { option: true }],
  dispatch: async ({ dispatchOptions }, use) => {
    const app = await fixture({
      ...dispatchOptions,
      ...built,
      env: { ...built.env, ...dispatchOptions.env },
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
export { demo, expect };

/** Fill and submit the sign-in form the page already shows. */
export async function signIn(page: Page, email = demo.email) {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(demo.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
/** Open the app and sign in, as the platform owner unless another seeded account is named. */
export async function login(page: Page, email = demo.email) {
  await page.goto('/');
  await signIn(page, email);
}
/** From the platform's DSP list, open a DSP's dialog and enter its view. */
export async function openDsp(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
}
