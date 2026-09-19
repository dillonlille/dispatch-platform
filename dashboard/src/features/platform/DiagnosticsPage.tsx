import { FlaskConical } from 'lucide-react';
import type { Job, PlatformHealth } from '../../../../shared/contracts/index.js';
import { platformHash } from '../../app/navigation.js';
import { useAction } from '../../app/useAction.js';
import { api, useData } from '../../app/api.js';
import { CollectionHistory } from './CollectionHistory.js';
import { DataState, DetailList, ErrorBox, Header } from '../../ui/index.js';
import { bytes, deviceTimezone, time, title } from '../../lib/format.js';
import { JobTable } from './JobTable.js';

export function DiagnosticsPage() {
  const health = useData<PlatformHealth>('/api/platform/health', 10000);
  const { data, error, refresh } = useData<{
    enabled: boolean;
    storageAvailableBytes: number;
    runtime: { name: string; status: string; memoryBytes: number; browsers: number };
    dsps: { id: string; name: string; status: string }[];
  }>('/api/platform/diagnostics', 5000);
  const jobs = useData<Job[]>('/api/platform/jobs', 3000);
  const deploy = useAction(
    async () => {
      await api('/api/platform/diagnostics', {});
      refresh();
    },
    { success: 'Test DSP ready' },
  );
  const busy = deploy.busy;
  return (
    <>
      <Header title="Diagnostics" />
      <ErrorBox message={error || health.error} />
      <DataState data={data}>
        {(data) => (
          <>
            <section aria-label="Runtime health" className="archived-card diagnostics-health">
              <h2>Runtime health</h2>
              <p className="muted">
                Available storage: {bytes(data.storageAvailableBytes, 'GiB', 1)}
              </p>
              <div className="runtime-row">
                <span>{data.runtime.name}</span>
                <span>
                  {data.runtime.status} · {bytes(data.runtime.memoryBytes, 'MiB')} ·{' '}
                  {data.runtime.browsers} active browsers
                </span>
              </div>
              {health.data && (
                <p className="muted">{browserMemoryStatus(health.data.browsers.memory)}</p>
              )}
            </section>
            {health.data?.mail && (
              <section aria-label="Email delivery" className="archived-card diagnostics-health">
                <h2>Email delivery</h2>
                <DetailList
                  className="details"
                  items={[
                    ['Sending', health.data.mail.enabled ? 'Enabled' : 'Disabled'],
                    ['Pending', health.data.mail.pending],
                    ['Failed', health.data.mail.failed],
                    [
                      'Oldest pending',
                      health.data.mail.pending === 0
                        ? '—'
                        : health.data.mail.oldestPendingAgeMs === null
                          ? 'Unknown'
                          : `${Math.floor(health.data.mail.oldestPendingAgeMs / 60000)} min`,
                    ],
                    [
                      'Last delivered',
                      health.data.mail.lastSuccessAt
                        ? time(health.data.mail.lastSuccessAt, deviceTimezone())
                        : '—',
                    ],
                    [
                      'Last attempt',
                      health.data.mail.lastAttemptAt
                        ? time(health.data.mail.lastAttemptAt, deviceTimezone())
                        : '—',
                    ],
                  ]}
                />
                <ErrorBox
                  message={mailFailure(
                    health.data.mail.transport.error ?? health.data.mail.lastError,
                  )}
                />
              </section>
            )}
            <section className="archived-card" aria-labelledby="test-dsp-title">
              <h2 id="test-dsp-title">Test DSP</h2>
              <p className="muted">
                Deploy a DSP with synthetic employees and timecards. Provider collection stays
                stopped, and no invitation email is sent.
              </p>
              <button
                className="primary"
                disabled={busy || !data.enabled}
                onClick={() => void deploy.run()}
              >
                <FlaskConical size={16} />
                {busy ? 'Requesting test DSP…' : 'Deploy test DSP'}
              </button>
              {!data.enabled && (
                <div className="notice">
                  Test DSP deployment is unavailable on this installation.
                </div>
              )}
            </section>
            <section aria-label="Test DSP deployments" className="test-dsp-list" aria-live="polite">
              {data.dsps.map((dsp) => (
                <div key={dsp.id} className="archived-card">
                  <h3>{dsp.name}</h3>
                  <p className="muted">
                    {dsp.status === 'active'
                      ? 'Synthetic data prepared · Available'
                      : title(dsp.status)}
                  </p>
                </div>
              ))}
            </section>
            <a href={platformHash()} className="underlined-link">
              Manage test DSPs in DSPs
            </a>
          </>
        )}
      </DataState>
      <section className="diagnostics-jobs" aria-label="Platform collections">
        <h2>Collections</h2>
        <DataState data={jobs.data} error={jobs.error}>
          {(jobs) => (
            <>
              <CollectionHistory jobs={jobs} />
              <JobTable jobs={jobs} />
            </>
          )}
        </DataState>
      </section>
    </>
  );
}
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
function browserMemoryStatus(memory: PlatformHealth['browsers']['memory']) {
  const status = memory.canStart
    ? 'Memory available for another browser'
    : 'New browsers waiting for memory';
  const available =
    memory.availableBytes === null
      ? 'Available memory unknown'
      : `${bytes(memory.availableBytes, 'MiB')} available`;
  return `${status} · ${available} · ${bytes(memory.requiredBytes, 'MiB')} needed`;
}
