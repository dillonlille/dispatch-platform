import type { PlatformHealth } from '../../../../shared/contracts/index.js';
import { DetailList, ErrorBox } from '../../ui/index.js';
import { deviceTimezone, time } from '../../lib/format.js';

function mailFailure(code: string | null): string {
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

export function DiagnosticsEmail({ mail }: { mail: PlatformHealth['mail'] }) {
  const at = (value: string | null) => (value ? time(value, deviceTimezone()) : '—');
  return (
    <section aria-label="Email delivery">
      <DetailList
        className="diagnostics-tiles diagnostics-facts"
        items={[
          ['Sending', mail.enabled ? 'Enabled' : 'Disabled'],
          ['Pending', mail.pending],
          ['Failed', mail.failed],
          ['Last delivered', at(mail.lastSuccessAt)],
        ]}
      />
      <ErrorBox message={mailFailure(mail.transport.error ?? mail.lastError)} />
      <DetailList
        className="diagnostics-card diagnostics-delivery"
        items={[
          ['Last attempt', at(mail.lastAttemptAt)],
          [
            'Oldest pending',
            mail.pending === 0
              ? '—'
              : mail.oldestPendingAgeMs === null
                ? 'Unknown'
                : `${Math.floor(mail.oldestPendingAgeMs / 60000)} min`,
          ],
          ['Transport checked', at(mail.transport.checkedAt)],
        ]}
      />
    </section>
  );
}
