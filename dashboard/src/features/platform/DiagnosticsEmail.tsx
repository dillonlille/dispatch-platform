import { CircleCheck, CircleDashed, CircleX, RefreshCw } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { MailMessage, PlatformHealth } from '../../../../shared/contracts/index.js';
import { discardMail, retryMail, usePlatformMail } from '../../app/endpoints.js';
import { useAction } from '../../app/useAction.js';
import {
  Badge,
  ConfirmDialog,
  DataState,
  DataTable,
  Empty,
  ErrorBox,
  TablePagination,
  useDataTable,
  type TableColumn,
} from '../../ui/index.js';
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
const at = (value: string | null) => (value ? time(value, deviceTimezone()) : '—');

/** Where a message stands: it has not arrived, the person has yet to act, or it is finished. */
function stage(message: MailMessage) {
  if (message.status !== 'sent') return 'undelivered';
  if (message.kind !== 'invitation') return 'done';
  if (!message.acceptedAt) return 'waiting';
  return message.owner && message.setupComplete === false ? 'waiting' : 'done';
}
const kindLabel = (message: MailMessage) =>
  message.kind === 'invitation'
    ? message.owner
      ? 'Owner invitation'
      : `Team invitation${message.role ? ` · ${message.role}` : ''}`
    : message.kind === 'reset'
      ? 'Password reset'
      : 'Email';

function Step({
  state,
  label,
  detail,
}: {
  state: 'done' | 'retrying' | 'failed' | 'todo';
  label: string;
  detail?: ReactNode;
}) {
  const [Icon, tone] = (
    {
      done: [CircleCheck, 'mail-step-done'],
      retrying: [RefreshCw, 'mail-step-retrying'],
      failed: [CircleX, 'mail-step-failed'],
      todo: [CircleDashed, 'mail-step-todo'],
    } as const
  )[state];
  return (
    <li className={`mail-step ${tone}`}>
      <Icon size={14} aria-hidden="true" />
      <span>
        {label}
        {detail && <small>{detail}</small>}
      </span>
    </li>
  );
}
function Progress({ message }: { message: MailMessage }) {
  const delivery =
    message.status === 'sent' ? (
      <Step state="done" label="Sent" detail={at(message.sentAt)} />
    ) : message.status === 'failed' ? (
      <Step
        state="failed"
        label="Not delivered"
        detail={mailFailure(message.lastError) || at(message.lastAttemptAt)}
      />
    ) : message.attempts ? (
      <Step
        state="retrying"
        label={`Retrying · attempt ${message.attempts + 1} of 5`}
        detail={`Next ${at(message.nextAttemptAt)}`}
      />
    ) : (
      <Step state="todo" label="Queued" detail={at(message.queuedAt)} />
    );
  const invitation = message.kind === 'invitation';
  return (
    <ol className="mail-steps">
      {delivery}
      {invitation && (
        <Step
          state={message.acceptedAt ? 'done' : 'todo'}
          label={message.owner ? 'Accepted' : 'Joined'}
          detail={message.acceptedAt ? at(message.acceptedAt) : undefined}
        />
      )}
      {invitation && message.owner && (
        <Step state={message.setupComplete ? 'done' : 'todo'} label="DSP set up" />
      )}
    </ol>
  );
}

const filters = [
  ['all', 'All'],
  ['waiting', 'Waiting on them'],
  ['undelivered', 'Not delivered'],
  ['done', 'Done'],
] as const;

export function DiagnosticsEmail({
  mail,
  onChanged,
}: {
  mail: PlatformHealth['mail'];
  /** A retry or discard changed the counts the page holds. */
  onChanged: () => void;
}) {
  const mailLog = usePlatformMail(5000);
  const { data, error } = mailLog;
  const refresh = () => {
    mailLog.refresh();
    onChanged();
  };
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all');
  const [discarding, setDiscarding] = useState<MailMessage>();
  const retry = useAction(
    async (id: string) => {
      await retryMail(id);
      refresh();
    },
    { success: 'Email queued again' },
  );
  const discard = useAction(
    async (id: string) => {
      await discardMail(id);
      setDiscarding(undefined);
      refresh();
    },
    { success: 'Email discarded' },
  );
  const rows = useMemo(
    () => (data ?? []).filter((message) => filter === 'all' || stage(message) === filter),
    [data, filter],
  );
  const columns: TableColumn<MailMessage>[] = [
    {
      id: 'recipient',
      header: 'Recipient',
      rowHeader: true,
      cell: (message) => (
        <>
          <strong>{message.recipient ?? 'Not recorded'}</strong>
          <small>{kindLabel(message)}</small>
        </>
      ),
    },
    {
      id: 'invitedBy',
      header: 'Invited by',
      cell: (message) =>
        message.kind !== 'invitation' ? (
          '—'
        ) : message.invitedBy ? (
          <>
            {message.dspName}
            <small>{message.invitedBy}</small>
          </>
        ) : (
          <>
            Platform
            {message.dspName && <small>{message.dspName}</small>}
          </>
        ),
    },
    { id: 'progress', header: 'Progress', cell: (message) => <Progress message={message} /> },
    {
      id: 'actions',
      header: '',
      className: 'mail-actions',
      cell: (message) =>
        message.status === 'failed' && (
          <>
            <button
              className="text-button"
              disabled={retry.busy}
              onClick={() => void retry.run(message.id)}
            >
              Retry
            </button>
            <button className="text-button danger" onClick={() => setDiscarding(message)}>
              Discard
            </button>
          </>
        ),
    },
  ];
  const table = useDataTable({ columns, rows, rowId: (message) => message.id, pageSize: 25 });
  const failure = mailFailure(mail.transport.error ?? mail.lastError);
  return (
    <section aria-label="Email delivery">
      <dl className="mail-strip">
        <div>
          <dt>Sending</dt>
          <dd>
            <Badge value={!mail.enabled ? 'idle' : failure ? 'failed' : 'succeeded'}>
              {!mail.enabled ? 'Disabled' : failure ? 'Failing' : 'Enabled'}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>{mail.pending}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{mail.failed}</dd>
        </div>
        <div>
          <dt>Oldest pending</dt>
          <dd>
            {mail.pending === 0
              ? '—'
              : mail.oldestPendingAgeMs === null
                ? 'Unknown'
                : `${Math.floor(mail.oldestPendingAgeMs / 60000)} min`}
          </dd>
        </div>
        <div>
          <dt>Last delivered</dt>
          <dd>{at(mail.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt>Last attempt</dt>
          <dd>{at(mail.lastAttemptAt)}</dd>
        </div>
      </dl>
      <ErrorBox message={failure} />
      <section className="diagnostics-card" aria-labelledby="mail-messages">
        <div className="diagnostics-card-heading">
          <h2 id="mail-messages">Messages</h2>
          <div className="mail-filters" role="group" aria-label="Filter messages">
            {filters.map(([id, label]) => (
              <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
                <span>{(data ?? []).filter((m) => id === 'all' || stage(m) === id).length}</span>
              </button>
            ))}
          </div>
        </div>
        <DataState data={data} error={error}>
          {() =>
            rows.length ? (
              <div className="table-wrap">
                <DataTable table={table} className="mail-table" label="Email messages" />
                <TablePagination table={table} />
              </div>
            ) : (
              <Empty title="No messages" />
            )
          }
        </DataState>
      </section>
      {discarding && (
        <ConfirmDialog
          title="Discard this email?"
          confirm="Discard"
          busy={discard.busy}
          onCancel={() => setDiscarding(undefined)}
          onConfirm={() => void discard.run(discarding.id)}
        >
          It will not be sent{discarding.recipient ? ` to ${discarding.recipient}` : ''}.
        </ConfirmDialog>
      )}
    </section>
  );
}
