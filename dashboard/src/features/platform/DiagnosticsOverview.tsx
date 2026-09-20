import { AlertTriangle, ChevronRight, CircleX, Cpu, Globe, HardDrive, Mail } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Job, PlatformHealth } from '../../../../shared/contracts/index.js';
import { Badge, DataTable, Empty, useDataTable, type TableColumn } from '../../ui/index.js';
import { bytes, deviceTimezone, duration, time } from '../../lib/format.js';
import { providerName, type collectionHistory } from './collection-history.js';
import type { Diagnostics } from './diagnostics.js';
import { memory } from './RunDetail.js';

type Source = ReturnType<typeof collectionHistory>[number];
const active = (job: Job) => ['queued', 'running', 'waiting_verification'].includes(job.status);

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
  openSource: (key: string) => void;
  openEmail: () => void;
}) {
  const { browsers, mail } = health;
  const running = jobs.filter(active);
  const attention = sources.filter((source) => source.warnings.length);
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
      cell: ({ key, label }) => (
        <button
          className="icon-button diagnostics-open"
          aria-label={`Open ${label}`}
          onClick={() => openSource(key)}
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
          {attention.map((source) => (
            <button
              className="diagnostics-issue"
              key={source.key}
              onClick={() => openSource(source.key)}
            >
              {source.newest.status === 'failed' ? (
                <CircleX size={16} className="diagnostics-bad" />
              ) : (
                <AlertTriangle size={16} className="diagnostics-warn" />
              )}
              <span>
                <strong>{source.label}</strong>
                {source.warnings.map((warning) => (
                  <small key={warning}>{warning}</small>
                ))}
              </span>
            </button>
          ))}
          {mail.failed > 0 && (
            <button className="diagnostics-issue" onClick={openEmail}>
              <CircleX size={16} className="diagnostics-bad" />
              <span>
                <strong>Email</strong>
                <small>
                  {mail.failed} failed {mail.failed === 1 ? 'delivery' : 'deliveries'}
                </small>
              </span>
            </button>
          )}
          {!attention.length && !mail.failed && <p className="muted">Nothing needs attention.</p>}
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
