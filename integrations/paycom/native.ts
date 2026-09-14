import { createRequire } from 'node:module';
import type { Page, BrowserContext } from 'playwright';
import type { Credentials } from '../../services/auth-broker/vault.js';
import type { Workforce, Employee, Timecard } from '../../shared/contracts/index.js';
import { projectTimecards, type ProviderTimecard } from './timecards.js';
import { AppError, assert } from '../../shared/errors.js';
import { dateInTimezone, workforceSchema } from './workforce.js';
const require = createRequire(import.meta.url);
const periods = require('./provider/timecard-period.js') as {
  parsePeriodKey(value: string): Period;
  periodFromEnd(value: string): Period;
  buildTimecardUrl(code: string, period: Period, variant: number): string;
};
const roster = require('./provider/roster-request.js') as {
  ROSTER_API: string;
  TIMECARD_SEARCH_URL: string;
  fetchRosterRequest(
    value: unknown,
    period: Period,
    options: unknown,
  ): { codes: string[]; authoritative: boolean; postData: string } | null;
  rosterReadExpression(value: unknown): string;
  rosterMembership(bytes: Buffer, codes: string[]): boolean;
};
const parser = require('./provider/roster-parser.js') as {
  parseRosterSource(bytes: Buffer): { employees: RawEmployee[] };
};
const dom = require('./provider/timecard-dom.js') as {
  buildExtractionExpression(value: unknown): string;
  validateTimecardRecord(value: unknown, expected: unknown): void;
};
interface Period {
  start: string;
  end: string;
  key: string;
  dates: string[];
}
interface RawEmployee {
  employeeCode: string;
  employeeName: string;
  departmentDesc: string;
  positionTitle: string;
  deliveryStationCode: string;
  isActive: boolean;
}
export async function connectionState(
  page: Page,
  fixtureUrl?: string,
): Promise<'ready' | 'challenge' | 'login'> {
  const url = new URL(page.url());
  if (fixtureUrl) {
    if (await page.locator('[data-authenticated="true"]').count()) return 'ready';
    if (await page.locator('input[name="code"]').count()) return 'challenge';
    return 'login';
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.paycomonline.net') return 'challenge';
  if (await page.locator('input[name="password"]').count()) return 'login';
  if (/security-question|two-factor|verification|captcha/i.test(url.pathname)) return 'challenge';
  if (
    url.pathname === '/v4/cl/cl-menu.php' ||
    (url.pathname.startsWith('/v4/cl/web.php/') && !/login|security|two-factor/.test(url.pathname))
  )
    return 'ready';
  return 'challenge';
}
export async function login(page: Page, credentials: Credentials, fixtureUrl?: string) {
  await page.goto(
    fixtureUrl ? `${fixtureUrl}/login` : 'https://www.paycomonline.net/v4/cl/cl-login.php',
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );
  if ((await connectionState(page, fixtureUrl)) === 'ready') return 'ready';
  const fields = [
    ['clientcode', credentials.clientCode],
    ['username', credentials.username],
    ['password', credentials.password],
  ] as const;
  for (const [name, value] of fields) {
    const input = page.locator(`input[name="${name}"]`);
    assert(await input.count(), 'verification_required', 409);
    await input.fill(value);
  }
  await page.locator('input[name="password"]').press('Enter');
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const state = await connectionState(page, fixtureUrl);
    if (state === 'ready') return state;
    if (state === 'challenge') return state;
    const text = await page.locator('body').innerText({ timeout: 5000 });
    if (/invalid (credentials|password)|incorrect password|account.{0,20}locked/i.test(text))
      throw new AppError('invalid_credentials', 409);
  }
  return 'challenge';
}
export async function verify(page: Page, code: string, fixtureUrl?: string) {
  const field = page
    .locator(
      'input[autocomplete="one-time-code"],input[name="code"],input[name="verificationCode"]',
    )
    .first();
  assert(await field.count(), 'manual_verification_required', 409);
  await field.fill(code);
  await field.press('Enter');
  await page.waitForTimeout(500);
  return connectionState(page, fixtureUrl);
}
export async function collect(
  context: BrowserContext,
  timezone: string,
  progress: (value: number, message: string) => void,
  fixtureUrl?: string,
): Promise<Workforce> {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    if (fixtureUrl) {
      await page.goto(`${fixtureUrl}/workforce`);
      const text = await page.locator('pre').innerText();
      return workforceSchema.parse(JSON.parse(text));
    }
    progress(10, 'Reading employee roster');
    let captureResolve!: (value: {
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }) => void;
    const capture = new Promise<{ body: Record<string, unknown>; headers: Record<string, string> }>(
      (resolve) => {
        captureResolve = resolve;
      },
    );
    await page.route(roster.ROSTER_API, async (route) => {
      const req = route.request();
      if (req.method() === 'POST')
        captureResolve({
          body: req.postDataJSON() as Record<string, unknown>,
          headers: await req.allHeaders(),
        });
      await route.continue();
    });
    await page.goto(roster.TIMECARD_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const observed = await Promise.race([
      capture,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new AppError('provider_timeout', 504)), 60_000).unref(),
      ),
    ]);
    const observedPeriod = periods.parsePeriodKey(
      `${observed.body.startDate}_${observed.body.endDate}`,
    );
    const today = dateInTimezone(timezone),
      offset = Math.floor(
        (Date.parse(today) - Date.parse(observedPeriod.start)) / (14 * 86400_000),
      );
    const end = new Date(Date.parse(observedPeriod.end) + offset * 14 * 86400_000)
        .toISOString()
        .slice(0, 10),
      period = periods.periodFromEnd(end);
    const selected = roster.fetchRosterRequest(
      {
        requestId: 'dispatch',
        request: {
          url: roster.ROSTER_API,
          method: 'POST',
          postData: JSON.stringify(observed.body),
        },
      },
      period,
      { unfiltered: true },
    );
    assert(selected?.authoritative, 'roster_not_complete', 409);
    const headers = Object.fromEntries(
      Object.entries(observed.headers).filter(([key]) =>
        /^(accept|authorization|content-type|x-xsrf-token|x-csrf-token|x-requested-with)$/i.test(
          key,
        ),
      ),
    );
    const response = (await page.evaluate(
      roster.rosterReadExpression({
        headers,
        body: Buffer.from(selected.postData, 'base64').toString(),
      }),
    )) as { status: number; text?: string };
    assert(
      response.status === 200 && typeof response.text === 'string',
      'provider_unavailable',
      502,
    );
    const bytes = Buffer.from(response.text);
    assert(roster.rosterMembership(bytes, selected.codes), 'roster_not_complete', 409);
    const employees: Employee[] = parser.parseRosterSource(bytes).employees.map((e) => ({
      code: e.employeeCode,
      name: e.employeeName,
      department: e.departmentDesc,
      position: e.positionTitle,
      station: e.deliveryStationCode,
      active: e.isActive,
    }));
    const timecards: Timecard[] = [];
    await page.unroute(roster.ROSTER_API);
    for (const [index, employee] of employees.entries()) {
      const sourceUrl = periods.buildTimecardUrl(employee.code, period, 1);
      await page.goto(sourceUrl, { waitUntil: 'load', timeout: 120_000 });
      await page.locator('#tbltimesheet').waitFor();
      await page.locator('#periodtotals').waitFor();
      const record = (await page.evaluate(
        dom.buildExtractionExpression({ employeeCode: employee.code, period, sourceUrl }),
      )) as ProviderTimecard;
      dom.validateTimecardRecord(record, { employeeCode: employee.code, period, sourceUrl });
      timecards.push(...projectTimecards(record, employee.code));
      progress(
        20 + Math.floor(((index + 1) / employees.length) * 70),
        `Reading timecards (${index + 1} of ${employees.length})`,
      );
    }
    return workforceSchema.parse({
      employees,
      timecards,
      collectedAt: new Date().toISOString(),
      from: period.start,
      to: period.end,
    });
  } finally {
    await page.close();
  }
}
