import { AlertTriangle, ChevronRight, CircleX, Cpu, Globe, HardDrive, Mail } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Job, PlatformHealth } from '../../../../../shared/contracts/index.js';
import { Badge, DataTable, Empty, useDataTable, type TableColumn } from '../../../ui/index.js';
import { bytes, deviceTimezone, duration, time } from '../../../lib/format.js';
import { issues } from './attention.js';
import { isUnderway, providerName, type CollectionSource as Source } from './collection-history.js';
import type { Diagnostics } from './types.js';
import { memory } from './RunDetail.js';

function Tile({
  icon,
  label,
  value,
  unit,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  unit?: string;
  children?: ReactNode;
}) {
  return (
    <section className="diagnostics-tile" aria-label={label}>
      <h2>
        {icon}
        {label}
      </h2>
      <p className="diagnostics-tile-value">
        {value}
        {unit && <span> {unit}</span>}
      </p>
      {children}
    </section>
  );
}

export function DiagnosticsOverview({
  health,
  diagnostics,
  jobs,
  sources,
  openSource,
  openEmail,
}: {
  health: PlatformHealth;
  diagnostics: Diagnostics;
  jobs: Job[];
  sources: Source[];
  /** Opens a source in Collections, with one of its runs expanded when named. */
  openSource: (key: string, run?: string) => void;
  openEmail: () => void;
}) {
  const { browsers, mail } = health;
  const running = jobs.filter((job) => isUnderway(job.status));
  const attention = issues(health, diagnostics, sources);
  const columns: TableColumn<Source>[] = [
    {
      id: 'source',
      header: 'Source',
      rowHeader: true,
      cell: ({ newest }) => (
        <>
          <strong>{newest.dspName}</strong>
          <small>{providerName(newest.kind)}</small>
        </>
      ),
    },
    { id: 'status', header: 'Status', cell: ({ newest }) => <Badge value={newest.status} /> },
    {
      id: 'finished',
      header: 'Finished',
      cell: ({ newest }) => time(newest.completedAt, deviceTimezone(), '—'),
    },
    {
      id: 'time',
      header: 'Collection time',
      cell: ({ runs, newest }) =>
        duration(runs.find((run) => run.job.id === newest.id)?.collectionMs ?? null),
    },
    { id: 'median', header: 'Median', cell: ({ medianMs }) => duration(medianMs) },
    {
      id: 'memory',
      header: 'Peak browser memory',
      cell: ({ runs, newest }) =>
        memory(runs.find((run) => run.job.id === newest.id)?.peakBytes ?? null),
    },
    {
      id: 'open',
      header: '',
      cell: ({ key, label, newest }) => (
        <button
          className="icon-button diagnostics-open"
          aria-label={`Open ${label}`}
          onClick={() => openSource(key, newest.id)}
        >
          <ChevronRight size={16} />
        </button>
      ),
    },
  ];
  const table = useDataTable({ columns, rows: sources, rowId: (source) => source.key });
  return (
    <>
      <div className="diagnostics-tiles">
        <Tile icon={<Cpu size={16} />} label="Platform runtime" value={diagnostics.runtime.status}>
          <small>
            {bytes(diagnostics.runtime.memoryBytes, 'MiB')} memory · {health.release}
          </small>
        </Tile>
        <Tile
          icon={<Globe size={16} />}
          label="Browsers"
          value={browsers.active}
          unit={`of ${browsers.capacity} in use`}
        >
          <div className="diagnostics-slots" aria-hidden="true">
            {Array.from({ length: browsers.capacity }, (_, index) => (
              <span key={index} className={index < browsers.active ? 'used' : undefined} />
            ))}
          </div>
          <small>
            {browsers.memory.availableBytes === null
              ? 'Available memory unknown'
              : `${bytes(browsers.memory.availableBytes, 'GiB', 1)} free`}{' '}
            · {bytes(browsers.memory.requiredBytes, 'GiB', 1)} per browser
            {!browsers.memory.canStart && ' · new browsers waiting for memory'}
          </small>
        </Tile>
        <Tile
          icon={<HardDrive size={16} />}
          label="Storage"
          value={bytes(diagnostics.storageAvailableBytes, 'GiB', 1).replace(' GiB', '')}
          unit="GiB available"
        />
        <Tile
          icon={<Mail size={16} />}
          label="Email"
          value={mail.enabled ? mail.pending : 'Disabled'}
          unit={mail.enabled ? `pending · ${mail.failed} failed` : undefined}
        >
          <small>
            {mail.lastSuccessAt
              ? `Last delivered ${time(mail.lastSuccessAt, deviceTimezone())}`
              : 'Nothing delivered yet'}
          </small>
        </Tile>
      </div>
      <div className="diagnostics-pair">
        <section className="diagnostics-card" aria-labelledby="diagnostics-running">
          <h2 id="diagnostics-running">Running now</h2>
          {running.length ? (
            running.map((job) => (
              <div className="diagnostics-live" key={job.id}>
                <div>
                  <strong>{job.dspName}</strong>
                  <small>
                    {providerName(job.kind)} · attempt {job.attempt} of {job.maxAttempts}
                  </small>
                </div>
                <div>
                  <div className="progress">
                    <span style={{ width: `${job.progress}%` }} />
                  </div>
                  <small>{job.message}</small>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No collections are running.</p>
          )}
        </section>
        <section className="diagnostics-card" aria-labelledby="diagnostics-attention">
          <h2 id="diagnostics-attention">Needs attention</h2>
          {attention.map((issue) => {
            const body = (
              <>
                {issue.tone === 'failed' ? (
                  <CircleX size={16} className="diagnostics-bad" />
                ) : (
                  <AlertTriangle size={16} className="diagnostics-warn" />
                )}
                <span>
                  <strong>{issue.title}</strong>
                  {issue.details.map((detail) => (
                    <small key={detail}>{detail}</small>
                  ))}
                </span>
              </>
            );
            const { open } = issue;
            return open ? (
              <button
                className="diagnostics-issue"
                key={issue.id}
                onClick={() =>
                  open.tab === 'email' ? openEmail() : openSource(open.source, open.run)
                }
              >
                {body}
              </button>
            ) : (
              <div className="diagnostics-issue" key={issue.id}>
                {body}
              </div>
            );
          })}
          {!attention.length && <p className="muted">Nothing needs attention.</p>}
        </section>
      </div>
      <section className="diagnostics-card" aria-labelledby="diagnostics-latest">
        <h2 id="diagnostics-latest">Latest by source</h2>
        {sources.length ? (
          <div className="table-wrap">
            <DataTable table={table} label="Latest collection for each source" />
          </div>
        ) : (
          <Empty title="No collections yet">Start a collection from a DSP workspace.</Empty>
        )}
      </section>
    </>
  );
}
