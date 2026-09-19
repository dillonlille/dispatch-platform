import fs from 'node:fs';
import { test, expect, login, openDsp } from './fixtures.js';

test('timecard columns can be hidden, stay hidden, and shape the export', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  const table = page.getByRole('table', { name: 'Daily employee timecards' });
  await expect(table.getByRole('columnheader')).toHaveText([
    'Employee',
    'Clock in',
    'Lunch out',
    'Lunch in',
    'Clock out',
    'Hours',
    'Punch status',
  ]);

  await page.getByLabel('Choose columns').click();
  // The column that names the row is not offered.
  await expect(page.getByRole('checkbox', { name: 'Employee', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Lunch out', exact: true }).uncheck();
  // The menu stays open so several columns can change at once.
  await page.getByRole('checkbox', { name: 'Lunch in', exact: true }).uncheck();
  await expect(table.getByRole('columnheader')).toHaveText([
    'Employee',
    'Clock in',
    'Clock out',
    'Hours',
    'Punch status',
  ]);
  await expect(table.locator('tbody tr').first().getByRole('cell')).toHaveCount(5);
  await page.keyboard.press('Escape');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export timecards', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^timecards-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = fs.readFileSync(await file.path(), 'utf8').split('\r\n');
  expect(lines[0]).toBe('﻿Employee,Clock in,Clock out,Hours,Punch status');
  expect(lines).toHaveLength(13);

  await page.reload();
  await expect(table.getByRole('columnheader')).toHaveCount(5);
  await page.getByLabel('Choose columns').click();
  await page.getByRole('checkbox', { name: 'Lunch out', exact: true }).check();
  await expect(table.getByRole('columnheader', { name: 'Lunch out' })).toBeVisible();
});

test('arrow keys, j and k move between the rows of a table', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  const rows = page.getByRole('button', { name: /View punches for/ });
  await expect(rows).toHaveCount(12);
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('j');
  await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('k');
  await page.keyboard.press('ArrowUp');
  await expect(rows.first()).toBeFocused();
  // The first row has nowhere further up to go.
  await page.keyboard.press('ArrowUp');
  await expect(rows.first()).toBeFocused();
});

test('hiding a meal break column keeps the expanded detail across the table', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
  const table = page.locator('.meal-table');
  await expect(table.getByRole('columnheader')).toHaveCount(8);
  await table
    .getByRole('button', { name: /^Details for / })
    .first()
    .click();
  const detail = table.locator('.meal-detail > td');
  await expect(detail).toHaveAttribute('colspan', '8');

  await page.getByLabel('Choose columns').click();
  await page.getByRole('checkbox', { name: 'Comparison', exact: true }).uncheck();
  await expect(table.getByRole('columnheader')).toHaveCount(7);
  await expect(detail).toHaveAttribute('colspan', '7');
  await page.keyboard.press('Escape');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export meal breaks', exact: true }).click();
  const csv = fs.readFileSync(await (await download).path(), 'utf8');
  expect(csv.split('\r\n')[0]).toBe(
    '﻿Employee,IN DAY,Last delivery,OUT LUNCH Paycom,OUT LUNCH Flex,IN LUNCH Paycom,IN LUNCH Flex,First delivery,OUT DAY',
  );
});
