import { z } from 'zod';
import type { Page } from 'playwright';
import type { Credentials } from '../../services/auth-broker/vault.js';

// Preserve the exact configured answers, including leading zeroes and spaces.
export const securityAnswersSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\r\n\0]+$/),
  )
  .length(5)
  .refine((answers) => new Set(answers).size === 5);
export const securityPath = '/v4/cl/web.php/security/security-question/login';

export async function answerSecurityPins(page: Page, credentials: Credentials) {
  if (!securityAnswersSchema.safeParse(credentials.securityAnswers).success) return false;
  const url = new URL(page.url());
  if (url.origin !== 'https://www.paycomonline.net' || url.pathname !== securityPath) return false;
  try {
    await page
      .locator('input[name="firstSecurityQuestion"]')
      .waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return false;
  }
  // Validate and fill in one document operation. Only the exact archived numbered
  // challenge is supported; unfamiliar verification remains available for assistance.
  return page.evaluate(
    ({ answers, path }) => {
      const safe = (value: string) => {
        const u = new URL(value, location.href),
          keys = [...u.searchParams.keys()];
        return (
          u.origin === 'https://www.paycomonline.net' &&
          !u.username &&
          !u.password &&
          !u.hash &&
          u.pathname === path &&
          keys.length <= 1 &&
          keys.every((key) => key === 'session_nonce')
        );
      };
      if (!safe(location.href)) return false;
      if (
        document.querySelector(
          'input[autocomplete="one-time-code"],input[name="code"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.g-recaptcha,.h-captcha,[data-sitekey]',
        )
      )
        return false;
      const visible = (element: HTMLElement) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const inputs = [...document.querySelectorAll<HTMLInputElement>('input')].filter(
        (input) =>
          visible(input) &&
          !input.disabled &&
          !['hidden', 'submit', 'button', 'reset'].includes(input.type),
      );
      if (inputs.length !== 2) return false;
      const fields: { input: HTMLInputElement; index: number }[] = [];
      for (const name of ['firstSecurityQuestion', 'secondSecurityQuestion']) {
        const matching = inputs.filter(
          (input) => input.name === name && input.type === 'password' && !input.readOnly,
        );
        if (matching.length !== 1) return false;
        const input = matching[0]!;
        const labels = [...(input.labels ?? [])].map((label) => label.textContent ?? '');
        labels.push(
          input.getAttribute('aria-label') ?? '',
          input.placeholder,
          input.name,
          input.id,
        );
        const indices = new Set<number>();
        for (const label of labels) {
          const match =
            label
              .trim()
              .match(
                /^(?:(?:enter|unique)\s+)?(?:paycom\s+)?(?:security\s+)?pin(?:\s*(?:number|no\.?|#))?\s*([1-5])\s*[:?]?\s*$/i,
              ) ?? label.trim().match(/^(?:security[_-]?)?pin[_-]?([1-5])$/i);
          if (match) indices.add(Number(match[1]));
        }
        if (indices.size !== 1) return false;
        fields.push({ input, index: [...indices][0]! });
      }
      const form = fields[0]!.input.form;
      if (
        !form ||
        fields.some(({ input }) => input.form !== form) ||
        fields[0]!.index === fields[1]!.index ||
        form.method.toUpperCase() !== 'POST' ||
        !safe(form.action) ||
        (form.target && form.target !== '_self')
      )
        return false;
      for (const { input, index } of fields) {
        const name = input.name === 'firstSecurityQuestion' ? 'firstIndex' : 'secondIndex';
        const hidden = form.querySelectorAll<HTMLInputElement>(
          `input[type="hidden"][name="${name}"]`,
        );
        if (hidden.length !== 1 || hidden[0]!.value !== String(index)) return false;
      }
      const buttons = [
        ...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          'button,input[type="submit"]',
        ),
      ].filter(
        (button) =>
          visible(button) &&
          !button.disabled &&
          button.type === 'submit' &&
          button.name === 'continue' &&
          (button.textContent || button.value).trim() === 'Continue',
      );
      if (buttons.length !== 1) return false;
      const button = buttons[0]!;
      if (
        (button.hasAttribute('formaction') && !safe(button.formAction)) ||
        (button.formMethod && button.formMethod.toUpperCase() !== 'POST') ||
        (button.formTarget && button.formTarget !== '_self')
      )
        return false;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (const { input, index } of fields) {
        setValue.call(input, answers[index - 1]!);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      button.click();
      return true;
    },
    { answers: credentials.securityAnswers!, path: securityPath },
  );
}
