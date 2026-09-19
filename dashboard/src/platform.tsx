import { useUpdateState } from './app/browser-update.js';
import { useState } from 'react';
import { Building2, Ellipsis, Plus, RefreshCw, Eye, FlaskConical } from 'lucide-react';
import type { DspSummary, Job, PlatformHealth, SessionView } from '../../shared/contracts/index.js';
import { dspHash, navigate, platformHash } from './app/navigation.js';
import { useAction } from './app/useAction.js';
import { api, errorLabel, useData } from './app/api.js';
import { DspAvatar } from './app/Brand.js';
import { JobPerformance } from './features/platform/JobPerformance.js';
import { CollectionHistory } from './features/platform/CollectionHistory.js';
import { providerName } from './features/platform/collection-history.js';
import { AuditLog } from './audit.js';
import {
  Badge,
  ConfirmDialog,
  DataState,
  DetailList,
  Empty,
  ErrorBox,
  Header,
  Loading,
  Modal,
  Popover,
  SearchInput,
  Tabs,
} from './ui/index.js';
import { bytes, deviceTimezone, time, title } from './lib/format.js';
const open = (dsp: { id: string }) => navigate(dspHash(dsp.id));
const runtime = (dsp: DspSummary) =>
  dsp.profile.removed ? 'Stopped' : dsp.status === 'active' ? 'Running' : title(dsp.status);
const onboarding = (dsp: DspSummary) =>
  dsp.ownerStatus === 'active'
    ? dsp.profile.setupRequired
      ? 'Details needed'
      : 'Complete'
    : dsp.ownerStatus === 'invited'
      ? 'Invitation pending'
      : 'Invite needed';
export function DspList() {
  const { data, error, refresh } = useData<DspSummary[]>('/api/platform/dsps', 10000);
  const [query, setQuery] = useUpdateState('dsp-query', ''),
    [filter, setFilter] = useUpdateState('dsp-filter', 'all'),
    [creating, setCreating] = useState(false),
    [suspending, setSuspending] = useState<DspSummary>(),
    [removing, setRemoving] = useState<DspSummary>(),
    [detail, setDetail] = useState<DspSummary>();
  const dsps = data ?? [],
    visible = dsps.filter(
      (d) =>
        `${d.name} ${d.ownerEmail ?? ''}`.toLowerCase().includes(query.toLowerCase()) &&
        (filter === 'removed'
          ? d.profile.removed
          : !d.profile.removed &&
            (filter === 'all' ||
              (filter === 'running' && d.status === 'active') ||
              (filter === 'onboarding' &&
                (d.ownerStatus !== 'active' || d.profile.setupRequired)))),
    );
  const create = useAction(
    async (ownerEmail: FormDataEntryValue | null) => {
      await api('/api/platform/dsps', { ownerEmail });
      refresh();
    },
    { success: (ownerEmail) => `Invitation email queued for ${ownerEmail}` },
  );
  const restore = useAction(
    async (dsp: DspSummary) => {
      await api(`/api/platform/dsps/${dsp.id}/restore`, {});
      refresh();
    },
    { success: 'DSP restored' },
  );
  const resume = useAction(
    async (dsp: DspSummary) => {
      await api(
        `/api/platform/dsps/${dsp.id}/${dsp.status === 'failed' ? 'retry' : 'status'}`,
        dsp.status === 'failed' ? {} : { status: 'active' },
      );
      refresh();
    },
    { success: 'DSP available' },
  );
  const remove = useAction(
    async (dsp: DspSummary) => {
      await api(`/api/platform/dsps/${dsp.id}/remove`, {});
      setRemoving(undefined);
      refresh();
    },
    { success: 'DSP removed' },
  );
  const suspend = useAction(
    async (dsp: DspSummary) => {
      await api(`/api/platform/dsps/${dsp.id}/status`, { status: 'suspended' });
      setSuspending(undefined);
      refresh();
    },
    { success: 'DSP suspended' },
  );
  const busy = create.busy;
  return (
    <>
      <Header title="DSPs">
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          Create new DSP
        </button>
      </Header>
      <ErrorBox message={error} />
      <div className="inline-summary" aria-label="DSP summary">
        <span>
          <strong>{dsps.filter((d) => !d.profile.removed).length}</strong>DSPs
        </span>
        <span>
          <strong>{dsps.filter((d) => d.status === 'active').length}</strong>running
        </span>
        <span>
          <strong>
            {
              dsps.filter(
                (d) =>
                  !d.profile.removed && (d.ownerStatus !== 'active' || d.profile.setupRequired),
              ).length
            }
          </strong>
          onboarding
        </span>
      </div>
      <Tabs
        value={filter}
        onChange={setFilter}
        items={[
          ['all', 'All DSPs'],
          ['running', 'Running'],
          ['onboarding', 'Onboarding'],
          ['removed', 'Removed'],
        ]}
        label="DSP filters"
      />
      <div className="table-toolbar">
        <SearchInput
          label="Search DSPs"
          placeholder="Search DSPs or owner email"
          value={query}
          onChange={setQuery}
        />
        <button className="icon-button" aria-label="Refresh DSPs" onClick={refresh}>
          <RefreshCw size={16} />
        </button>
      </div>
      <DataState data={data}>
        {() => (
          <div className="table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th style={{ width: '28%' }}>DSP</th>
                  <th>Owner</th>
                  <th>Runtime</th>
                  <th>Onboarding</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((dsp) => (
                  <tr key={dsp.id}>
                    <td>
                      <button className="identity-button" onClick={() => setDetail(dsp)}>
                        <DspAvatar name={dsp.name} />
                        <span className="dsp-identity-copy">
                          <strong>{dsp.name}</strong>
                          <span>{dsp.profile.abbreviation || (dsp.permanent ? 'DEV' : '')}</span>
                        </span>
                      </button>
                    </td>
                    <td className="muted">{dsp.ownerEmail ?? 'No owner assigned'}</td>
                    <td>
                      <Badge value={dsp.status}>{runtime(dsp)}</Badge>
                    </td>
                    <td>
                      <Badge value={dsp.ownerStatus === 'active' ? 'neutral' : 'pending'}>
                        {onboarding(dsp)}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Popover
                        className="row-menu"
                        label={`Actions for ${dsp.name}`}
                        trigger={<Ellipsis size={18} />}
                        anchored
                      >
                        {dsp.profile.removed ? (
                          <button onClick={() => void restore.run(dsp)}>Restore DSP</button>
                        ) : dsp.status === 'active' ? (
                          <button onClick={() => open(dsp)}>
                            <Eye size={16} />
                            View
                          </button>
                        ) : (
                          <button onClick={() => void resume.run(dsp)}>
                            {dsp.status === 'failed' ? 'Retry' : 'Resume DSP'}
                          </button>
                        )}
                        {!dsp.permanent &&
                          !dsp.profile.removed &&
                          ['active', 'suspended'].includes(dsp.status) && (
                            <button onClick={() => setRemoving(dsp)}>Remove DSP</button>
                          )}
                        {dsp.status === 'active' && !dsp.permanent && (
                          <button className="danger" onClick={() => setSuspending(dsp)}>
                            Suspend DSP
                          </button>
                        )}
                      </Popover>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <Empty title="No DSPs found">Try another search or create your first DSP.</Empty>
            )}
          </div>
        )}
      </DataState>
      <p className="table-count">
        {visible.length} DSP{visible.length === 1 ? '' : 's'}
      </p>
      {creating && (
        <Modal
          title="Create new DSP"
          description="Invite an owner. Their workspace will be prepared while they finish setup."
          variant="sheet"
          onClose={() => setCreating(false)}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              if (await create.run(form.get('ownerEmail'))) setCreating(false);
            }}
          >
            <label>
              Owner email
              <input
                name="ownerEmail"
                type="email"
                autoComplete="off"
                maxLength={254}
                required
                disabled={busy}
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create DSP'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal
          variant="sheet"
          title={
            <span className="dsp-panel-identity">
              <DspAvatar name={detail.name} />
              <span>{detail.name}</span>
            </span>
          }
          description="DSP ownership and runtime status."
          onClose={() => setDetail(undefined)}
        >
          <DetailList
            className="detail-list dsp-detail-list"
            items={[
              ['Owner', detail.ownerEmail || 'Not assigned'],
              [
                'Runtime',
                <Badge value={detail.profile.removed ? 'suspended' : detail.status}>
                  {runtime(detail)}
                </Badge>,
              ],
              ['Onboarding', onboarding(detail)],
              ['Station', detail.profile.stationCode || '—'],
              ['Timezone', detail.timezone],
            ]}
          />
          <div className="dsp-detail-actions">
            <button
              className="primary"
              disabled={detail.status !== 'active' || detail.profile.removed}
              onClick={() => {
                setDetail(undefined);
                open(detail);
              }}
            >
              <Eye size={16} />
              View
            </button>
            {detail.status === 'active' && !detail.permanent && (
              <button
                onClick={() => {
                  setDetail(undefined);
                  setSuspending(detail);
                }}
              >
                Suspend DSP ↗
              </button>
            )}
            {(detail.status !== 'active' || detail.profile.removed) && (
              <p className="muted">Viewing is unavailable for suspended or removed DSPs.</p>
            )}
          </div>
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title="Remove DSP"
          confirm="Remove DSP"
          onConfirm={() => void remove.run(removing)}
          onCancel={() => setRemoving(undefined)}
        >
          Remove {removing.name}. Access and collection will stop immediately. Existing data will be
          retained so you can restore this DSP later.
        </ConfirmDialog>
      )}
      {suspending && (
        <ConfirmDialog
          title={`Suspend ${suspending.name}?`}
          confirm="Suspend DSP"
          tone="danger"
          onConfirm={() => void suspend.run(suspending)}
          onCancel={() => setSuspending(undefined)}
        >
          Members lose access and active collections are cancelled until you resume this DSP.
        </ConfirmDialog>
      )}
    </>
  );
}
// A member's platform page: the DSPs they belong to.
export function DspPicker({ session }: { session: SessionView }) {
  return (
    <>
      <Header title="Your DSPs" />
      <div className="workspace-grid">
        {session.dsps
          .filter((d) => d.status === 'active')
          .map((dsp) => (
            <button className="workspace-card" key={dsp.id} onClick={() => open(dsp)}>
              <Building2 />
              <strong>{dsp.name}</strong>
              <Badge value={dsp.environment} />
            </button>
          ))}
      </div>
      {!session.dsps.length && (
        <p>Your account has no DSP memberships. Ask your DSP owner for an invitation.</p>
      )}
    </>
  );
}
function JobTable({ jobs }: { jobs: Job[] }) {
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
export function AuditPage() {
  return (
    <>
      <Header title="Audit log" />
      <AuditLog />
    </>
  );
}
export function ReleasesPage() {
  const { data, error, refresh } = useData<{
    version?: string | null;
    release: string;
    update?: { status: string; commit?: string; updatedAt: string } | null;
  }>('/api/platform/releases', 5000);
  if (!data)
    return (
      <>
        <ErrorBox message={error} />
        <Loading />
      </>
    );
  return (
    <>
      <Header title="Updates">
        <button onClick={refresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </Header>
      <ErrorBox message={error} />
      <div id="platform-updates-content" className="archived-updates">
        {data.update && (
          <section className="archived-card update-status" role="status" aria-label="Update status">
            <h2>{title(data.update.status)}</h2>
            <p className="muted">
              Last update status {time(data.update.updatedAt, deviceTimezone())}
            </p>
          </section>
        )}
        {['Core', 'DSP'].map((product) => (
          <section
            key={product}
            className="archived-card archived-release-card"
            aria-label={`${product} release`}
          >
            <div className="release-card-heading">
              <div>
                <h2>{product}</h2>
                <p className="muted">Installed: {data.version ?? data.release.slice(0, 12)}</p>
              </div>
              <span className="muted">Updates automatically</span>
            </div>

            <div className="release-card-notes">
              <h3>{data.version ? `Version ${data.version}` : 'Current build'}</h3>

              <p className="muted">
                Build {data.release.slice(0, 12)}
                {data.update?.commit ? ` · Commit ${data.update.commit.slice(0, 12)}` : ''}
              </p>
            </div>
          </section>
        ))}
      </div>
    </>
  );
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
