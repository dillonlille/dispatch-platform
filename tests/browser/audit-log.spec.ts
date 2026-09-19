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
    ref: null,
    changes: [],
    ...rest,
  }) satisfies AuditEvent;
const system = { actorId: null, actorName: 'System' };
// Northline keeps Chicago time, five hours behind these instants.
const support = { actorId: null, actorName: 'Platform support' };
const events: AuditEvent[] = [
  event('2026-09-16T14:44:00Z', 'collection.completed', 'collections', {
    changes: [
      { field: 'provider', from: null, to: 'paycom' },
      { field: 'date', from: null, to: '2026-09-15' },
      { field: 'duration', from: null, to: '108' },
    ],
  }),
  event('2026-09-16T14:42:00Z', 'collection.requested', 'collections', { detail: '2026-09-15' }),
  event('2026-09-16T11:00:00Z', 'collection.failed', 'collections', {
    ...system,
    detail: 'manual_verification_required',
    target: 'Morning Paycom pull',
    changes: [{ field: 'provider', from: null, to: 'paycom' }],
  }),
  event('2026-09-15T21:38:00Z', 'member.joined', 'team', {
    actorId: 'usr_sam',
    actorName: 'Sam Rivera',
    detail: 'Dispatcher',
    changes: [{ field: 'invitedBy', from: null, to: 'Maria Lopez' }],
  }),
  event('2026-09-15T20:50:00Z', 'member.role_changed', 'team', {
    detail: 'Manager',
    target: 'Jordan Pike',
    ref: { kind: 'member', id: 'usr_jordan' },
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
  event('2026-09-15T17:02:00Z', 'dsp.owner_view_opened', 'team', support),
  event('2026-09-15T16:40:00Z', 'dsp.owner_view_opened', 'team', support),
  event('2026-09-15T16:01:00Z', 'dsp.owner_view_opened', 'team', support),
  event('2026-09-15T15:30:00Z', 'dsp.profile_completed', 'settings', {
    changes: [
      { field: 'station', from: null, to: 'DEN4' },
      { field: 'abbreviation', from: null, to: 'FSLG' },
    ],
  }),
  // Written before events named their subject.
  event('2026-09-15T15:00:00Z', 'member.role_changed', 'team', { detail: 'Member' }),
  event('2026-09-15T14:30:00Z', 'collection.completed', 'collections', system),
  event('2026-09-15T14:00:00Z', 'schedule.deleted', 'schedules', {
    detail: 'schedule_0123456789abcdef0123456789abcdef',
  }),
  event('2026-09-15T13:50:00Z', 'connection.disabled', 'connections', { detail: 'cortex' }),
  event('2026-09-15T13:40:00Z', 'employees.links_updated', 'settings', {
    detail: 'Revision 3; 2 changes',
  }),
  event('2026-09-15T13:38:00Z', 'employees.links_updated', 'settings', {
    detail: 'Revision 4; 3 changes',
    changes: [
      { field: 'linked', from: null, to: '2' },
      { field: 'separated', from: null, to: '1' },
    ],
  }),
  event('2026-09-15T13:36:00Z', 'paycom.settings_updated', 'settings', {
    detail: 'Revision 5',
    changes: [
      { field: 'paycom.automatic_sync', from: 'true', to: 'false' },
      { field: 'paycom.late_da_time', from: '10:01', to: '09:45' },
      { field: 'paycom.department', from: 'All', to: 'Drivers' },
    ],
  }),
  // A retried attempt is not the collection's outcome, so it is not a failure.
  event('2026-09-15T13:34:00Z', 'collection.retrying', 'collections', {
    ...system,
    detail: 'provider_timeout',
    ref: { kind: 'job', id: 'job_1' },
    changes: [
      { field: 'provider', from: null, to: 'cortex' },
      { field: 'attempt', from: null, to: '1 of 3' },
    ],
  }),
  event('2026-09-15T13:32:00Z', 'collection.failed', 'collections', {
    ...system,
    detail: 'provider_timeout',
    ref: { kind: 'job', id: 'job_1' },
    changes: [
      { field: 'provider', from: null, to: 'cortex' },
      { field: 'attempt', from: null, to: '3 of 3' },
    ],
  }),
  // An event this build has no wording for still reads, with its detail.
  event('2026-09-15T13:30:00Z', 'vehicle.inspection_logged', 'settings', { detail: 'Van 12' }),
];

async function open(page: Page) {
  const requests: URLSearchParams[] = [];
  await page.route(/\/api\/dsp\/audit\?/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const area = query.get('area');
    const subject = query.get('subject');
    const matching = events.filter(
      (item) =>
        (!area || (area === 'failures' ? item.action.endsWith('.failed') : item.area === area)) &&
        (!subject || (item.ref && `${item.ref.kind}:${item.ref.id}` === subject)),
    );
    const counts: AuditPage['counts'] = { failures: 1 };
    for (const item of events) counts[item.area] = (counts[item.area] ?? 0) + 1;
    return route.fulfill({
      json: {
        // The first page is short so the log has more to load.
        events: Number(query.get('limit')) > 50 ? matching : matching.slice(0, 12),
        total: matching.length,
        counts,
        actors: [
          { id: 'usr_maria', name: 'Maria Lopez' },
          { id: 'system', name: 'System' },
        ],
        dsps: [],
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

  // Every area is offered, as in the approved design, even before it has events.
  await expect(page.getByRole('group', { name: 'Area' }).getByRole('button')).toHaveText([
    /^All/,
    /^Team/,
    /^Roles/,
    /^Collections/,
    /^Schedules/,
    /^Connections/,
    /^Settings/,
    /^Failures/,
  ]);
  await expect(page.getByPlaceholder('Search people, roles, schedules…')).toBeVisible();

  const completed = item(page, 'Paycom collection for Sep 15 completed');
  await expect(completed).toContainText('Requested by Maria Lopez·1m 48s');
  await expect(item(page, 'started a Paycom collection')).toContainText('for Sep 15');
  await expect(item(page, 'Scheduled collection Morning Paycom pull failed')).toContainText(
    'Paycom needs verification — sign-in was challenged',
  );
  await expect(item(page, 'Sam Rivera joined the team')).toContainText(
    'Invited by Maria Lopez·Dispatcher',
  );
  const role = item(page, 'changed Jordan Pike’s role');
  await expect(role).toContainText('Dispatcher');
  await expect(role).toContainText('Manager');
  await expect(role).toContainText('3:50 PM');
  await expect(item(page, 'invited sam@northline.test')).toContainText('Dispatcher');
  await expect(item(page, 'updated the schedule Morning pull')).toContainText('5:30 AM');
  await expect(item(page, 'updated the role Dispatcher')).toContainText('+ Manage Timecard');
  await expect(item(page, 'updated the role Dispatcher')).toContainText('− Invite Members');

  const visits = item(page, 'Platform support opened this DSP 3 times');
  await expect(visits).toHaveCount(1);
  await expect(visits).toContainText('11:01 AM – 12:02 PM');
  await visits.getByRole('button').click();
  await expect(visits).toContainText('12:02 PM, 11:40 AM, 11:01 AM');

  await role.getByRole('button').click();
  await expect(role).toContainText('member.role_changed · #96');
  await expect(role).toContainText(/Tue, Sep 15, 2026.*3:50:00 PM/);
  await expect(item(page, 'completed the DSP profile')).toContainText(
    'StationDEN4·AbbreviationFSLG',
  );
  await page.screenshot({ path: test.info().outputPath('audit-log.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: test.info().outputPath('audit-log-dark.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  await expect(page.getByText('Showing 12 of 22')).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.get('limit')).toBe('100');
  // Older events fall back to the wording their data supports.
  await expect(item(page, 'changed a member’s role')).toContainText('Member');
  await expect(item(page, 'Collection completed')).toBeVisible();
  await expect(item(page, 'deleted a schedule')).toBeVisible();
  await expect(item(page, 'Maria Lopez disconnected Cortex')).toBeVisible();
  await expect(item(page, 'updated employee links').first()).toContainText('2 links changed');
  await expect(item(page, 'updated employee links').last()).toContainText(
    '2 linked·1 kept separate',
  );
  const paycom = item(page, 'updated Paycom settings');
  await expect(paycom).toContainText('Automatic syncOnOff');
  await expect(paycom).toContainText('Late DA time10:01 AM9:45 AM');
  await expect(paycom).toContainText('DepartmentAllDrivers');
  await expect(item(page, 'Meal break collection attempt 1 of 3 failed')).toContainText(
    'Cortex took too long to respond·Retrying',
  );
  await expect(item(page, /^Meal break collection failed/)).toContainText('After 3 attempts');
  await expect(item(page, 'Maria Lopez vehicle inspection logged')).toContainText('Van 12');
  await expect(page.getByText('schedule_0123', { exact: false })).toHaveCount(0);

  // From one event to everything about its subject, and back.
  await role.getByRole('button', { name: 'All activity involving Jordan Pike' }).click();
  await expect.poll(() => requests.at(-1)?.get('subject')).toBe('member:usr_jordan');
  expect(requests.at(-1)?.get('named')).toBe('Jordan Pike');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop showing only Jordan Pike' }).click();
  await expect.poll(() => requests.at(-1)?.has('subject')).toBe(false);
  await expect(item(page, 'Platform support opened this DSP')).toBeVisible();

  await page.getByRole('button', { name: /^Failures/ }).click();
  await expect(page.getByRole('button', { name: /^Failures/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('listitem')).toHaveCount(2);
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

test('a DSP lists Platform support only once the platform owner shows it there', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@dispatch.test');
  await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const visit = async () => {
    await page.getByRole('link', { name: 'DSPs', exact: true }).click();
    await page.getByText('Northline Logistics', { exact: true }).first().click();
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Audit log', exact: true }).click();
  };
  await visit();
  // Hidden by default: the visit that opened this page is not in the log.
  await expect(page.getByRole('group', { name: 'Area' })).toBeVisible();
  await expect(page.getByText('Platform support', { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: 'Exit view', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Platform support', exact: true }).click();
  const northline = page.getByRole('switch', { name: 'Northline Logistics', exact: true });
  await expect(northline).not.toBeChecked();
  await northline.check();
  await expect(page.getByText('Platform support shown to Northline Logistics')).toBeVisible();
  await expect(northline).toBeChecked();
  await page.screenshot({ path: test.info().outputPath('support-visibility.png') });

  await visit();
  const row = page.getByRole('listitem').filter({ hasText: 'Platform support opened this DSP' });
  await expect(row).toHaveCount(1);
  // Only the visit made after switching it on is listed, and never by name.
  await expect(row).not.toContainText('times');
  await expect(page.getByRole('list').filter({ hasText: 'Platform Owner' })).toHaveCount(0);
  await expect(page.getByLabel('Person')).toContainText('Platform support');

  // The platform's own log is in the sidebar, names its owner and narrows to a DSP.
  await page.getByRole('button', { name: 'Exit view', exact: true }).click();
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Audit log', exact: true })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'showed Platform support to Northline' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'created Summit Delivery' }),
  ).toHaveCount(1);
  await page.getByLabel('DSP', { exact: true }).selectOption({ label: 'Northline Logistics' });
  await expect(
    page.getByRole('listitem').filter({ hasText: 'created Summit Delivery' }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Platform Owner opened Northline Logistics' })
      .first(),
  ).toBeVisible();
});
