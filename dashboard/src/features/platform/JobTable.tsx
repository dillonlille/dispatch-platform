import type { Job } from '../../../../shared/contracts/index.js';
import { errorLabel } from '../../app/api.js';
import { JobPerformance } from './JobPerformance.js';
import { providerName } from './collection-history.js';
import { Badge, DataTable, Empty, useDataTable, type TableColumn } from '../../ui/index.js';
import { deviceTimezone, time, title } from '../../lib/format.js';

const columns: TableColumn<Job>[] = [
  {
    id: 'collection',
    header: 'Collection',
    hideable: false,
    value: (job) => job.dspName,
    cell: (job) => (
      <>
        <strong>{job.dspName}</strong>
        <small>
          {providerName(job.kind)} · {job.environment}
        </small>
      </>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    value: (job) => job.status,
    cell: (job) => (
      <>
        <Badge value={job.status} />
        {job.error && <small>{errorLabel(job.error) ?? title(job.error)}</small>}
      </>
    ),
  },
  {
    id: 'progress',
    header: 'Progress',
    value: (job) => job.progress,
    cell: (job) => (
      <>
        <div className="progress">
          <span style={{ width: `${job.progress}%` }} />
        </div>
        <small>{job.message}</small>
      </>
    ),
  },
  {
    id: 'requested',
    header: 'Requested',
    value: (job) => job.createdAt,
    cell: (job) => time(job.createdAt, deviceTimezone()),
  },
  {
    id: 'attempt',
    header: 'Attempt',
    value: (job) => job.attempt,
    cell: (job) => (
      <>
        {job.attempt} / {job.maxAttempts}
      </>
    ),
  },
  {
    id: 'performance',
    header: 'Performance',
    cell: (job) => <JobPerformance metrics={job.metrics} />,
  },
];

export function JobTable({ jobs }: { jobs: Job[] }) {
  const table = useDataTable({ columns, rows: jobs, rowId: (job) => job.id });
  return jobs.length ? (
    <div className="table-wrap">
      <DataTable table={table} className="collection-table" />
    </div>
  ) : (
    <Empty title="No collections yet">Start a collection from a DSP workspace.</Empty>
  );
}
