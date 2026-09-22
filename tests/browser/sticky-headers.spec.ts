import type { Locator, Page } from '@playwright/test';
import type { DailyTimecards } from '../../shared/contracts/index.js';
import type { MealComparison } from '../../shared/contracts/meals.js';
import { demo, expect, login, openDsp, test } from './fixtures.js';

async function longTables(page: Page) {
  await page.route('**/api/dsp/timecards?*', async (route) => {
    const response = await route.fetch();
    const data: DailyTimecards = await response.json();
    expect(data.rows.length).toBeGreaterThan(0);
    data.rows = Array.from({ length: 80 }, (_, index) => ({
      ...data.rows[0]!,
      employeeCode: `sticky-${index}`,
      name: `Driver ${String(index + 1).padStart(3, '0')}`,
    }));
    if (new URL(route.request().url()).searchParams.get('direction') === 'desc')
      data.rows.reverse();
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/dsp/paycom/meal-breaks?*', async (route) => {
    const response = await route.fetch();
    const data: MealComparison = await response.json();
    expect(data.rows.length).toBeGreaterThan(0);
    data.rows = Array.from({ length: 80 }, (_, index) => ({
      ...data.rows[0]!,
      id: `sticky-${index}`,
      name: `Driver ${String(index + 1).padStart(3, '0')}`,
    }));
    await route.fulfill({ response, json: data });
  });
}

async function expectPinned(table: Locator) {
  await expect
    .poll(() =>
      table.evaluate((element) => {
        const banner = document.querySelector('[data-sticky-banner]');
        return Math.abs(
          element.querySelector('thead tr')!.getBoundingClientRect().top -
            (banner?.getBoundingClientRect().bottom ?? 0),
        );
      }),
    )
    .toBeLessThan(1);
  // Check actual column geometry, including the sticky employee column on phones.
  const aligned = await table.evaluate((element) => {
    const header = element.querySelector('thead tr') as HTMLTableRowElement;
    const row = element.querySelector('tbody tr:nth-child(20)') as HTMLTableRowElement;
    return [...header.cells].every((cell, index) => {
      const heading = cell.getBoundingClientRect();
      const value = row.cells[index]!.getBoundingClientRect();
      return Math.abs(heading.left - value.left) < 1 && Math.abs(heading.width - value.width) < 1;
    });
  });
  expect(aligned).toBe(true);
}

async function expectSteadyWhileScrolling(page: Page, table: Locator) {
  // Sample as scroll events arrive, before a scroll-following animation can catch up.
  await table.evaluate((element) => {
    const samples: number[] = [];
    const record = () => {
      const top =
        document.querySelector('[data-sticky-banner]')?.getBoundingClientRect().bottom ?? 0;
      samples.push(Math.abs(element.querySelector('thead tr')!.getBoundingClientRect().top - top));
    };
    Object.assign(window, {
      stickyScrollSamples: samples,
      stopStickyScroll: () => window.removeEventListener('scroll', record),
    });
    window.addEventListener('scroll', record, { passive: true });
  });
  await page.mouse.move(page.viewportSize()!.width - 45, 450);
  for (const delta of [180, 180, -240, 120, -180]) {
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, delta);
    await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);
  }
  const samples = await page.evaluate(() => {
    const state = window as typeof window & {
      stickyScrollSamples: number[];
      stopStickyScroll: () => void;
    };
    state.stopStickyScroll();
    return state.stickyScrollSamples;
  });
  expect(samples.length).toBeGreaterThanOrEqual(5);
  expect(Math.max(...samples)).toBeLessThan(1);
}

for (const width of [1440, 390]) {
  for (const banner of [true, false]) {
    test(`column headings stay pinned at ${width}px ${banner ? 'below the DSP banner' : 'without a banner'}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 850 });
      await longTables(page);
      await login(page, banner ? demo.email : demo.member);
      if (banner) await openDsp(page, 'Northline Logistics');
      if (width < 700) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('link', { name: 'Timecard', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Timecard', exact: true })).toBeVisible();
      await expect(page.locator('[data-sticky-banner]')).toHaveCount(banner ? 1 : 0);

      for (const [tab, selector, columns] of [
        ['Timecard', '.paycom-day-table', 7],
        ['Meal Breaks', '.meal-table', 8],
      ] as const) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const table = page.locator(selector);
        await expect(table.locator('tbody > tr')).toHaveCount(80);
        await expect(table.getByRole('columnheader')).toHaveCount(columns);
        const header = table.locator('thead > tr').first();
        const initial = await header.boundingBox();
        expect(initial!.y).toBeGreaterThan(100);

        await table.evaluate((element) =>
          window.scrollBy(0, element.getBoundingClientRect().top + 950),
        );
        await expectPinned(table);
        await expectSteadyWhileScrolling(page, table);
        await expect(table.getByRole('columnheader')).toHaveCount(columns);
        await page.screenshot({
          path: test.info().outputPath(`${tab}-${width}-${banner ? 'banner' : 'member'}.png`),
        });

        if (width < 700) {
          if (tab === 'Timecard') {
            const scrolled = await page.evaluate(() => window.scrollY);
            await table.getByRole('columnheader').last().getByRole('button').focus();
            await expect(table.getByRole('columnheader').last()).toBeInViewport();
            expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
          }
          expect(
            await table.evaluate((element) => {
              const wrap = element.parentElement!;
              wrap.scrollLeft = wrap.scrollWidth;
              return wrap.scrollLeft;
            }),
          ).toBeGreaterThan(100);
          await expectPinned(table);
          await expect(table.getByRole('columnheader').first()).toBeInViewport();
          await expect(table.getByRole('columnheader').last()).toBeInViewport();
        }

        // A real click on the pinned sort control must work without jumping up the page.
        const scrolled = await page.evaluate(() => window.scrollY);
        const employee = table.getByRole('columnheader').first();
        await employee.getByRole('button').click();
        await expect(employee).toHaveAttribute('aria-sort', 'descending');
        await expect(table.locator('tbody > tr').first()).toContainText('080');
        expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThan(2);
        await expectPinned(table);

        // Banner wrapping and table sizing both change on a live viewport resize.
        await page.setViewportSize({ width: width === 1440 ? 980 : 430, height: 780 });
        await expectPinned(table);
        await page.setViewportSize({ width, height: 850 });
        await expectPinned(table);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );

        await page.evaluate(() => window.scrollTo(0, 0));
        await expect
          .poll(async () => Math.abs((await header.boundingBox())!.y - initial!.y))
          .toBeLessThan(1);

        // Give the page room below the table to exercise its lower sticky boundary.
        await page.evaluate(() => {
          const spacer = document.createElement('div');
          spacer.id = 'scroll-test-spacer';
          spacer.style.height = '100vh';
          document.querySelector('main')!.append(spacer);
        });
        await table.evaluate((element) =>
          window.scrollBy(0, element.getBoundingClientRect().bottom + 10),
        );
        await expect(header).not.toBeInViewport();
        await page.evaluate(() => {
          document.getElementById('scroll-test-spacer')!.remove();
          window.scrollTo(0, 0);
        });
      }
      await page.getByRole('tab', { name: 'Employees', exact: true }).click();
      await expect(page.locator('.table-sticky-header')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}
