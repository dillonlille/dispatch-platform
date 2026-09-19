import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import type { AuditEvent, AuditPage } from '../../shared/contracts/index.js';

let next = 100;
const event = (at: string, action: string, area: AuditEvent['area'], rest: Partial<AuditEvent>) =>
  ({
    id: next--,
    at,
    actorId: 'usr_maria',
    actorName: 'Maria Lopez',
    dspId: 'dsp_1',
    dspName: 'Northline Logistics',
    action,
    detail: '',
    area,
    target: null,
    changes: [],
    ...rest,
  }) satisfies AuditEvent;
const system = { actorId: null, actorName: 'System' };
// Northline keeps Chicago time, five hours behind these instants.
const events: AuditEvent[] = [
  event('2026-09-16T14:44:00Z', 'collection.completed', 'collections', {}),
  event('2026-09-16T14:42:00Z', 'collection.requested', 'collections', { detail: '2026-09-15' }),
  event('2026-09-16T11:00:00Z', 'collection.failed', 'collections', {
    ...system,
    detail: 'verification_required',
  }),
  event('2026-09-15T20:50:00Z', 'member.role_changed', 'team', {
    detail: 'Manager',
    target: 'Jordan Pike',
    changes: [{ field: 'role', from: 'Dispatcher', to: 'Manager' }],
  }),
  event('2026-09-15T20:12:00Z', 'member.invited', 'team', {
    detail: 'Dispatcher',
    target: 'sam@northline.test',
  }),
  event('2026-09-15T19:05:00Z', 'schedule.updated', 'schedules', {
    detail: 'Morning pull',
    target: 'Morning pull',
    changes: [{ field: 'time', from: '05:30', to: '06:00' }],
  }),
  event('2026-09-15T17:10:00Z', 'role.updated', 'roles', {
    detail: 'Dispatcher',
    target: 'Dispatcher',
    changes: [
      { field: 'permission', from: null, to: 'timecard.manage' },
      { field: 'permission', from: 'members.invite', to: null },
    ],
  }),
  event('2026-09-15T17:02:00Z', 'dsp.view_opened', 'access', {}),
  event('2026-09-15T16:40:00Z', 'dsp.view_opened', 'access', {}),
  event('2026-09-15T16:01:00Z', 'dsp.view_opened', 'access', {}),
  // Written before events named their subject.
  event('2026-09-15T15:00:00Z', 'member.role_changed', 'team', { detail: 'Member' }),
  event('2026-09-15T14:00:00Z', 'schedule.deleted', 'schedules', {
    detail: 'schedule_0123456789abcdef0123456789abcdef',
  }),
];

async function open(page: Page) {
  const requests: URLSearchParams[] = [];
  await page.route(/\/api\/dsp\/audit\?/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const area = query.get('area');
    const matching = events.filter(
      (item) =>
        !area || (area === 'failures' ? item.action.endsWith('.failed') : item.area === area),
    );
    const counts: AuditPage['counts'] = { failures: 1 };
    for (const item of events) counts[item.area] = (counts[item.area] ?? 0) + 1;
    return route.fulfill({
      json: {
        // The first page is short so the log has more to load.
        events: Number(query.get('limit')) > 50 ? matching : matching.slice(0, 10),
        total: matching.length,
        counts,
        actors: [
          { id: 'usr_maria', name: 'Maria Lopez' },
          { id: 'system', name: 'System' },
        ],
      } satisfies AuditPage,
    });
  });
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@dispatch.test');
  await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Northline Logistics', { exact: true }).first().click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  if (page.viewportSize()!.width < 700)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audit log', exact: true }).click();
  return requests;
}
const item = (page: Page, text: string | RegExp) =>
  page.getByRole('listitem').filter({ hasText: text });

test('the audit log reads as sentences, shows what changed and folds repeated visits', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests = await open(page);
  await expect(page.getByRole('heading', { name: /Sep 16/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Sep 15/ })).toBeVisible();

  await expect(item(page, 'Collection completed')).toContainText('Requested by Maria Lopez');
  await expect(item(page, 'started a Paycom collection')).toContainText('for Sep 15');
  await expect(item(page, 'Collection failed')).toContainText(/verification/i);
  const role = item(page, 'changed Jordan Pike’s role');
  await expect(role).toContainText('Dispatcher');
  await expect(role).toContainText('Manager');
  await expect(role).toContainText('3:50 PM');
  await expect(item(page, 'invited sam@northline.test')).toContainText('Dispatcher');
  await expect(item(page, 'updated the schedule Morning pull')).toContainText('5:30 AM');
  await expect(item(page, 'updated the role Dispatcher')).toContainText('+ Manage Timecard');
  await expect(item(page, 'updated the role Dispatcher')).toContainText('− Invite Members');

  const visits = item(page, 'opened the DSP 3 times');
  await expect(visits).toHaveCount(1);
  await expect(visits).toContainText('11:01 AM – 12:02 PM');
  await visits.getByRole('button').click();
  await expect(visits).toContainText('12:02 PM, 11:40 AM, 11:01 AM');

  await role.getByRole('button').click();
  await expect(role).toContainText('member.role_changed · #97');
  await expect(role).toContainText(/Tue, Sep 15, 2026.*3:50:00 PM/);
  await page.screenshot({ path: test.info().outputPath('audit-log.png'), fullPage: true });

  await expect(page.getByText('Showing 10 of 12')).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.get('limit')).toBe('100');
  // Older events fall back to the wording their data supports.
  await expect(item(page, 'changed a member’s role')).toContainText('Member');
  await expect(item(page, 'deleted a schedule')).toBeVisible();
  await expect(page.getByText('schedule_0123', { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: /^Failures/ }).click();
  await expect(page.getByRole('button', { name: /^Failures/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('listitem')).toHaveCount(1);
  expect(requests.at(-1)?.get('area')).toBe('failures');
  await page.getByRole('button', { name: /^All/ }).click();

  await page.getByLabel('Person').selectOption({ label: 'Maria Lopez' });
  await expect.poll(() => requests.at(-1)?.get('actor')).toBe('usr_maria');
  await page.getByLabel('Search activity').fill('role');
  await expect.poll(() => requests.at(-1)?.get('q')).toBe('role');
  expect(requests.at(-1)?.get('from')).toBeTruthy();
  await page.getByLabel('Date range').selectOption({ label: 'All time' });
  await expect.poll(() => requests.at(-1)?.has('from')).toBe(false);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const csv = fs.readFileSync(await (await download).path(), 'utf8');
  expect(csv).toContain('Time,Person,Area,Event,Details,Action');
  expect(csv).toContain('"Maria Lopez changed Jordan Pike’s role","Role Dispatcher → Manager"');
  expect(errors).toEqual([]);
});

test('the audit log fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(item(page, 'changed Jordan Pike’s role')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('audit-log-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
