import { test, expect, login, openDsp, expectDate, setDate } from './fixtures.js';
import {
  addDays,
  dayLabel,
  monthLabel,
  monthOf,
  parseDay,
} from '../../dashboard/src/lib/calendar.js';

test('the date opens a calendar that picks past days and refuses future ones', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  const field = page.getByLabel('Paycom date');
  const today = parseDay(await field.inputValue())!;
  const calendar = page.getByRole('dialog', { name: 'Choose paycom date' });
  const day = (value: string) =>
    calendar.getByRole('button', { name: dayLabel(value), exact: true });

  // A press anywhere on the field opens it, not only on an icon.
  await field.click({ position: { x: 12, y: 12 } });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByText(monthLabel(monthOf(today)), { exact: true })).toBeVisible();
  await expect(day(today)).toHaveAttribute('aria-current', 'date');
  await expect(day(today)).toHaveAttribute('aria-pressed', 'true');
  // Collection cannot look ahead of the DSP's business day.
  await expect(calendar.getByRole('button', { name: 'Next month' })).toBeDisabled();
  const tomorrow = addDays(today, 1);
  if (monthOf(tomorrow) === monthOf(today)) await expect(day(tomorrow)).toBeDisabled();

  // A month back always holds a selectable day.
  await calendar.getByRole('button', { name: 'Previous month' }).click();
  const earlier = `${monthOf(addDays(`${monthOf(today)}-01`, -1))}-15`;
  await expect(calendar.getByText(monthLabel(monthOf(earlier)), { exact: true })).toBeVisible();
  await day(earlier).click();
  await expect(calendar).toHaveCount(0);
  await expectDate(page, earlier);
  await expect(field).toBeFocused();

  // Reopening starts from the chosen day, and a press outside closes it.
  await field.click();
  await expect(day(earlier)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('heading', { name: 'Timecard', exact: true }).click();
  await expect(calendar).toHaveCount(0);

  // A plain field: no browser date control, so no icons and nothing selected by a press.
  await expect(field).toHaveAttribute('type', 'text');
  expect(
    await field.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!),
  ).toBe(0);
  await expect(page.locator('.date-field svg')).toHaveCount(0);

  // Typing a date still works, in either form, and only real days up to today are taken.
  await setDate(page, today);
  await expectDate(page, today);
  const yesterday = addDays(today, -1);
  await setDate(
    page,
    `${Number(yesterday.slice(5, 7))}/${Number(yesterday.slice(8))}/${yesterday.slice(0, 4)}`,
  );
  await expectDate(page, yesterday);
  await setDate(page, addDays(today, 1));
  await expectDate(page, yesterday);
  await setDate(page, 'not a date');
  await expectDate(page, yesterday);
});

test('the calendar can be driven from the keyboard', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  const field = page.getByLabel('Paycom date');
  const today = parseDay(await field.inputValue())!;
  const calendar = page.getByRole('dialog', { name: 'Choose paycom date' });
  const day = (value: string) =>
    calendar.getByRole('button', { name: dayLabel(value), exact: true });

  await field.focus();
  await page.keyboard.press('Enter');
  await expect(day(today)).toBeFocused();
  // The future is out of reach, so the arrow stays on today.
  await page.keyboard.press('ArrowRight');
  await expect(day(today)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(day(addDays(today, -7))).toBeFocused();
  // Focus follows the day into the month before.
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await expect(calendar.getByRole('button', { name: 'Next month' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(calendar).toHaveCount(0);
  await expect(field).toBeFocused();
  await expectDate(page, today);

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(calendar).toHaveCount(0);
  await expectDate(page, addDays(today, -1));
});
