import type { MailMessage } from '../../../../../shared/contracts/index.js';
import { deviceTimezone, time } from '../../../lib/format.js';

export function mailFailure(code: string | null): string {
  if (!code) return '';
  if (/^email_http_\d{3}$/.test(code)) return `The mail service returned HTTP ${code.slice(-3)}.`;
  const labels: Record<string, string> = {
    email_timeout: 'The mail service timed out.',
    email_connection_failed: 'The mail service could not be reached.',
    email_transport_configuration_failed: 'The mail transport configuration could not be loaded.',
    email_smtp_rejected: 'The SMTP server rejected delivery.',
  };
  return labels[code] ?? 'Email delivery failed. Check the service logs for details.';
}
export const at = (value: string | null) => (value ? time(value, deviceTimezone()) : '—');

/** Where a message stands: it has not arrived, the person has yet to act, or it is finished. */
export function stage(message: MailMessage) {
  if (message.status !== 'sent') return 'undelivered';
  if (message.kind !== 'invitation') return 'done';
  if (!message.acceptedAt) return 'waiting';
  return message.owner && message.setupComplete === false ? 'waiting' : 'done';
}
export const kindLabel = (message: MailMessage) =>
  message.kind === 'invitation'
    ? message.owner
      ? 'Owner invitation'
      : `Team invitation${message.role ? ` · ${message.role}` : ''}`
    : message.kind === 'reset'
      ? 'Password reset'
      : 'Email';
