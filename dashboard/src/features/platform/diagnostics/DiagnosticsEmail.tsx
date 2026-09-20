import { useMemo, useState } from 'react';
import type { MailMessage, PlatformHealth } from '../../../../../shared/contracts/index.js';
import { discardMail, retryMail, usePlatformMail } from '../../../app/endpoints.js';
import { useAction } from '../../../app/useAction.js';
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
} from '../../../ui/index.js';
import { at, kindLabel, mailFailure, stage } from './mail.js';
import { MailProgress } from './MailProgress.js';

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
    { id: 'progress', header: 'Progress', cell: (message) => <MailProgress message={message} /> },
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
          <div className="diagnostics-chips" role="group" aria-label="Filter messages">
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
