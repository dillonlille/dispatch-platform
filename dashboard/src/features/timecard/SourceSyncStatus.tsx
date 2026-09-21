import { AlertTriangle } from 'lucide-react';
import type { Job } from '../../../../shared/contracts/index.js';
import { Badge } from '../../ui/index.js';
import { time, timeOfDay, title } from '../../lib/format.js';
import { localDate } from '../../../../shared/meal-breaks.js';
import { dateFormatter } from '../../../../shared/date-format.js';

export type SyncSource = {
  enabled: boolean;
  active: boolean;
  job: Pick<Job, 'status'> | null;
  jobDate: string | null;
  collectedAt: string | null;
};

export function SourceSyncStatus({
  name,
  source,
  timezone,
  compact = false,
}: {
  name: string;
  source?: SyncSource;
  timezone: string;
  compact?: boolean;
}) {
  const status = source?.job?.status;
  const target = source?.active
    ? source.jobDate
      ? dateFormatter('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${source.jobDate}T00:00:00Z`),
        )
      : name === 'Paycom'
        ? 'current pay period'
        : null
    : null;
  const message = !source
    ? 'Checking…'
    : status === 'failed'
      ? 'Last collection failed'
      : status === 'cancelled'
        ? 'Sync cancelled'
        : source.active
          ? title(status ?? 'running')
          : !source.enabled
            ? 'Sync paused'
            : status === 'succeeded'
              ? 'Sync complete'
              : 'Waiting for next sync';
  if (compact) {
    const collectedAt = source?.collectedAt;
    const collectedToday =
      collectedAt && localDate(timezone, new Date(collectedAt)) === localDate(timezone);
    const timestamp = collectedAt
      ? collectedToday
        ? timeOfDay(collectedAt, timezone)
        : time(collectedAt, timezone)
      : null;
    return (
      <div
        className="paycom-header-sync"
        role="status"
        aria-label={`${name} sync`}
        title={collectedAt ? `Last successful sync ${time(collectedAt, timezone)}` : undefined}
      >
        {status === 'failed' && !source?.active ? (
          <span className="paycom-sync-failed">
            <AlertTriangle size={15} aria-hidden="true" />
            {name} failed
          </span>
        ) : (
          <Badge
            value={
              message === 'Sync complete'
                ? 'succeeded'
                : source?.active
                  ? (status ?? 'running')
                  : 'pending'
            }
          >
            {name} {message === 'Sync complete' ? 'synced' : message.toLowerCase()}
            {target && ` · ${target}`}
          </Badge>
        )}
        {collectedAt && message === 'Sync complete' && (
          <span className="paycom-sync-timestamp">
            ·{' '}
            <time
              dateTime={collectedAt}
              title={`Last successful sync ${time(collectedAt, timezone)}`}
            >
              {timestamp}
            </time>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="paycom-source-status">
      <span className="muted">{name}</span>
      <span role="status" aria-label={`${name} sync`}>
        {message}
        {target && ` · ${target}`}
      </span>
      {source?.collectedAt && (
        <span className="muted">Last successful sync {time(source.collectedAt, timezone)}</span>
      )}
    </div>
  );
}
