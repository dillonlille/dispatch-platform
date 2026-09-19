import type { Job } from '../../../../shared/contracts/index.js';
import { errorLabel } from '../../app/api.js';
import { JobPerformance } from './JobPerformance.js';
import { providerName } from './collection-history.js';
import { Badge, Empty } from '../../ui/index.js';
import { deviceTimezone, time, title } from '../../lib/format.js';

export function JobTable({ jobs }: { jobs: Job[] }) {
  return jobs.length ? (
    <div className="table-wrap">
      <table className="collection-table">
        <thead>
          <tr>
            <th>Collection</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Requested</th>
            <th>Attempt</th>
            <th>Performance</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <strong>{job.dspName}</strong>
                <small>
                  {providerName(job.kind)} · {job.environment}
                </small>
              </td>
              <td>
                <Badge value={job.status} />
                {job.error && <small>{errorLabel(job.error) ?? title(job.error)}</small>}
              </td>
              <td>
                <div className="progress">
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                <small>{job.message}</small>
              </td>
              <td>{time(job.createdAt, deviceTimezone())}</td>
              <td>
                {job.attempt} / {job.maxAttempts}
              </td>
              <td>
                <JobPerformance metrics={job.metrics} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="No collections yet">Start a collection from a DSP workspace.</Empty>
  );
}
