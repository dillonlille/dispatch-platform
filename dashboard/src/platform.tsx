import { useState, type FormEvent } from 'react';
import { Plus, Search, Check, Copy, RefreshCw, Eye, FlaskConical } from 'lucide-react';
import type {
  DspSummary,
  AuditEvent,
  Job,
  ReleaseSummary,
  PlatformHealth,
} from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { DspAvatar } from './brand.js';
import { DspActionsMenu } from './dsp-actions-menu.js';
import { JobPerformance } from './job-performance.js';
import {
  Badge,
  Empty,
  ErrorBox,
  Header,
  Loading,
  Modal,
  Section,
  time,
  title,
  Tabs,
} from './ui.js';
export type Perform = (work: () => Promise<unknown>, success?: string) => Promise<boolean>;
export function DspList({ open, perform }: { open: (dsp: DspSummary) => void; perform: Perform }) {
  const { data, error, refresh } = useData<DspSummary[]>('/api/platform/dsps', 10000);
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [creating, setCreating] = useState(false),
    [suspending, setSuspending] = useState<DspSummary>(),
    [removing, setRemoving] = useState<DspSummary>(),
    [detail, setDetail] = useState<DspSummary>(),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false);
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
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const ok = await perform(async () => {
      const result = await api<{ invitationUrl?: string }>('/api/platform/dsps', {
        ownerEmail: form.get('ownerEmail'),
      });
      setLink(result.invitationUrl ?? '');
      refresh();
    }, 'DSP created');
    setBusy(false);
    if (ok) setCreating(false);
  }
  return (
    <>
      <Header title="DSPs" subtitle="Manage your DSPs and onboarding.">
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
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search DSPs"
            placeholder="Search DSPs or owner email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="icon-button" aria-label="Refresh DSPs" onClick={refresh}>
          <RefreshCw size={16} />
        </button>
      </div>
      {!data ? (
        <Loading />
      ) : (
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
                    <Badge value={dsp.status}>
                      {dsp.profile.removed
                        ? 'Stopped'
                        : dsp.status === 'active'
                          ? 'Running'
                          : title(dsp.status)}
                    </Badge>
                  </td>
                  <td>
                    <Badge value={dsp.ownerStatus === 'active' ? 'neutral' : 'pending'}>
                      {dsp.ownerStatus === 'active'
                        ? dsp.profile.setupRequired
                          ? 'Details needed'
                          : 'Complete'
                        : dsp.ownerStatus === 'invited'
                          ? 'Invitation pending'
                          : 'Invite needed'}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <DspActionsMenu name={dsp.name}>
                      {dsp.profile.removed ? (
                        <button
                          onClick={() =>
                            void perform(async () => {
                              await api(`/api/platform/dsps/${dsp.id}/restore`, {});
                              refresh();
                            }, 'DSP restored')
                          }
                        >
                          Restore DSP
                        </button>
                      ) : dsp.status === 'active' ? (
                        <button onClick={() => open(dsp)}>
                          <Eye size={16} />
                          View
                        </button>
                      ) : (
                        <button
                          onClick={() =>
                            void perform(async () => {
                              await api(
                                `/api/platform/dsps/${dsp.id}/${dsp.status === 'failed' ? 'retry' : 'status'}`,
                                dsp.status === 'failed' ? {} : { status: 'active' },
                              );
                              refresh();
                            }, 'DSP available')
                          }
                        >
                          {dsp.status === 'failed' ? 'Retry' : 'Resume DSP'}
                        </button>
                      )}
                      {!dsp.permanent &&
                        !dsp.profile.removed &&
                        ['active', 'suspended'].includes(dsp.status) && (
                          <button
                            onClick={(event) => {
                              event.currentTarget.closest('details')?.removeAttribute('open');
                              setRemoving(dsp);
                            }}
                          >
                            Remove DSP
                          </button>
                        )}
                      {dsp.status === 'active' && !dsp.permanent && (
                        <button
                          className="danger"
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            setSuspending(dsp);
                          }}
                        >
                          Suspend DSP
                        </button>
                      )}
                    </DspActionsMenu>
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
          <form onSubmit={(event) => void create(event)}>
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
          <dl className="detail-list dsp-detail-list">
            {[
              ['Owner', detail.ownerEmail || 'Not assigned'],
              [
                'Runtime',
                detail.profile.removed
                  ? 'Stopped'
                  : detail.status === 'active'
                    ? 'Running'
                    : title(detail.status),
              ],
              [
                'Onboarding',
                detail.ownerStatus === 'active'
                  ? detail.profile.setupRequired
                    ? 'Details needed'
                    : 'Complete'
                  : detail.ownerStatus === 'invited'
                    ? 'Invitation pending'
                    : 'Invite needed',
              ],
              ['Station', detail.profile.stationCode || '—'],
              ['Timezone', detail.timezone],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  {key === 'Runtime' ? (
                    <Badge value={detail.profile.removed ? 'suspended' : detail.status}>
                      {value}
                    </Badge>
                  ) : (
                    value
                  )}
                </dd>
              </div>
            ))}
          </dl>
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
        <Modal title="Remove DSP" onClose={() => setRemoving(undefined)}>
          <p>
            Remove {removing.name}. Access and collection will stop immediately. Existing data will
            be retained so you can restore this DSP later.
          </p>
          <div className="form-actions">
            <button onClick={() => setRemoving(undefined)}>Cancel</button>
            <button
              className="primary"
              onClick={() =>
                void perform(async () => {
                  await api(`/api/platform/dsps/${removing.id}/remove`, {});
                  setRemoving(undefined);
                  refresh();
                }, 'DSP removed')
              }
            >
              Remove DSP
            </button>
          </div>
        </Modal>
      )}
      {link && <InvitationLink link={link} close={() => setLink('')} />}
      {suspending && (
        <Modal title={`Suspend ${suspending.name}?`} onClose={() => setSuspending(undefined)}>
          <p>Members lose access and active collections are cancelled until you resume this DSP.</p>
          <div className="form-actions">
            <button onClick={() => setSuspending(undefined)}>Cancel</button>
            <button
              className="danger"
              onClick={() =>
                void perform(async () => {
                  await api(`/api/platform/dsps/${suspending.id}/status`, { status: 'suspended' });
                  setSuspending(undefined);
                  refresh();
                }, 'DSP suspended')
              }
            >
              Suspend DSP
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function InvitationLink({ link, close }: { link: string; close: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Invitation ready" onClose={close}>
      <p>Share this private link with the invited person. It expires in seven days.</p>
      <label>
        Invitation link
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
      </label>
      <div className="form-actions">
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(link)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy link'}
        </button>
        <button className="primary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}
export function Activity({ events }: { events: AuditEvent[] }) {
  return events.length ? (
    <div className="activity">
      {events.map((event) => (
        <div key={event.id}>
          <span className="activity-dot" />
          <div>
            <strong>
              {event.dspName && `${event.dspName} · `}
              {title(event.action)}
            </strong>
            <small>
              {event.actorName}
              {event.detail && ` · ${event.detail}`}
            </small>
          </div>
          <time>{time(event.at)}</time>
        </div>
      ))}
    </div>
  ) : (
    <Empty title="No activity yet">Actions taken in this workspace will appear here.</Empty>
  );
}
export function JobTable({
  jobs,
  perform,
  refresh,
  cancel = false,
}: {
  jobs: Job[];
  perform: Perform;
  refresh: () => void;
  cancel?: boolean;
}) {
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
            {cancel && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <strong>{job.dspName}</strong>
                <small>Paycom · {job.environment}</small>
              </td>
              <td>
                <Badge value={job.status} />
                {job.error && <small>{title(job.error)}</small>}
              </td>
              <td>
                <div className="progress">
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                <small>{job.message}</small>
              </td>
              <td>{time(job.createdAt)}</td>
              <td>
                {job.attempt} / {job.maxAttempts}
              </td>
              <td>
                <JobPerformance metrics={job.metrics} />
              </td>
              {cancel && (
                <td>
                  {['queued', 'running', 'waiting_verification'].includes(job.status) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void perform(async () => {
                          await api(`/api/dsp/jobs/${job.id}/cancel`, {});
                          refresh();
                        }, 'Collection cancelled')
                      }
                    >
                      Cancel
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="No collections yet">Start a collection from a DSP workspace.</Empty>
  );
}
export function JobsPage({
  platform,
  perform,
  canCollect,
}: {
  platform: boolean;
  perform: Perform;
  canCollect: boolean;
}) {
  const { data, error, refresh } = useData<Job[]>(
    platform ? '/api/platform/jobs' : '/api/dsp/jobs',
    3000,
  );
  return (
    <>
      <Header title="Collections" subtitle="Follow collection progress and recent results." />
      <ErrorBox message={error} />
      {data ? (
        <JobTable
          jobs={data}
          perform={perform}
          refresh={refresh}
          cancel={!platform && canCollect}
        />
      ) : (
        <Loading />
      )}
    </>
  );
}
export function DiagnosticsPage({ perform }: { perform: Perform }) {
  const { data, error, refresh } = useData<{
    enabled: boolean;
    storageAvailableBytes: number;
    runtime: { name: string; status: string; memoryBytes: number; browsers: number };
    dsps: { id: string; name: string; status: string }[];
  }>('/api/platform/diagnostics', 5000);
  const jobs = useData<Job[]>('/api/platform/jobs', 3000);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Header title="Diagnostics" subtitle="Check runtime health and create test DSPs." />
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <section aria-label="Runtime health" className="archived-card diagnostics-health">
            <h2>Runtime health</h2>
            <p className="muted">
              Available storage: {(data.storageAvailableBytes / 1024 ** 3).toFixed(1)} GiB
            </p>
            <div className="runtime-row">
              <span>{data.runtime.name}</span>
              <span>
                {data.runtime.status} · {Math.round(data.runtime.memoryBytes / 1024 ** 2)} MiB ·{' '}
                {data.runtime.browsers} active browsers
              </span>
            </div>
          </section>
          <section className="archived-card" aria-labelledby="test-dsp-title">
            <h2 id="test-dsp-title">Test DSP</h2>
            <p className="muted">
              Deploy a DSP with synthetic employees and timecards. Provider collection stays
              stopped, and no invitation email is sent.
            </p>
            <button
              className="primary"
              disabled={busy || !data.enabled}
              onClick={() => {
                setBusy(true);
                void perform(async () => {
                  await api('/api/platform/diagnostics', {});
                  refresh();
                }, 'Test DSP ready').finally(() => setBusy(false));
              }}
            >
              <FlaskConical size={16} />
              {busy ? 'Requesting test DSP…' : 'Deploy test DSP'}
            </button>
            {!data.enabled && (
              <div className="notice">Test DSP deployment is unavailable on this installation.</div>
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
          <a href="#dsps" className="underlined-link">
            Manage test DSPs in DSPs
          </a>
        </>
      )}
      <section className="diagnostics-jobs" aria-label="Platform collections">
        <h2>Collections</h2>
        <ErrorBox message={jobs.error} />
        {jobs.data ? (
          <JobTable jobs={jobs.data} perform={perform} refresh={jobs.refresh} />
        ) : (
          <Loading />
        )}
      </section>
    </>
  );
}
export function AuditPage() {
  const { data, error } = useData<AuditEvent[]>('/api/platform/audit', 10000);
  return (
    <>
      <Header title="Audit log" subtitle="A record of account, workspace, and platform activity." />
      <ErrorBox message={error} />
      <Section title="Latest events">{data ? <Activity events={data} /> : <Loading />}</Section>
    </>
  );
}
export function ReleasesPage({ perform }: { perform: Perform }) {
  const { data, error, refresh } = useData<{
    releases: ReleaseSummary[];
    deploymentEnabled: boolean;
    standalone?: boolean;
    version?: string | null;
    release: string;
    update?: { status: string; commit?: string; updatedAt: string } | null;
  }>('/api/platform/releases', 5000);
  const [pending, setPending] = useState<{ digest: string; environment: string }>();
  if (data?.standalone)
    return (
      <>
        <Header title="Updates" subtitle="Review releases for your platform and DSPs.">
          <button onClick={refresh}>
            <RefreshCw size={16} />
            Refresh
          </button>
        </Header>
        <ErrorBox message={error} />
        <div id="platform-updates-content" className="archived-updates">
          {data.update && (
            <section
              className="archived-card update-status"
              role="status"
              aria-label="Update status"
            >
              <h2>{title(data.update.status)}</h2>
              <p className="muted">Last update status {time(data.update.updatedAt)}</p>
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
              <p className="muted">
                {product === 'Core'
                  ? 'The Platform Owner dashboard, shared API and Core services.'
                  : 'All DSPs use the same installed services and dashboard.'}
              </p>
              <div className="release-card-notes">
                <h3>{data.version ? `Version ${data.version}` : 'Current build'}</h3>
                <p className="muted">
                  Successful merged-dev builds update the complete Dev platform together.
                </p>
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

  return (
    <>
      <Header
        title="Releases"
        subtitle="Test a candidate on the Dev DSP before promoting it to every production DSP."
      />
      <ErrorBox message={error} />
      {data && !data.deploymentEnabled && (
        <div className="notice">
          Deployment is disabled in this development workspace. Builds and release imports stay
          local.
        </div>
      )}
      <div className="release-flow">
        <div>
          <span>01</span>
          <strong>Build once</strong>
          <p>Create a verified release artifact.</p>
        </div>
        <div>
          <span>02</span>
          <strong>Test on Dev</strong>
          <p>Update Preview and verify the Dev DSP.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Promote</strong>
          <p>Activate the same artifact for Production.</p>
        </div>
      </div>
      <Section title="Release inventory">
        {!data ? (
          <Loading />
        ) : !data.releases.length ? (
          <Empty title="No releases imported">
            Build the repository and import its artifact with the Dispatch CLI.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Release</th>
                  <th>Validation</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.releases.map((release) => (
                  <tr key={release.digest}>
                    <td>
                      <strong>{release.version}</strong>
                      <small>{time(release.createdAt)}</small>
                    </td>
                    <td>
                      <code>{release.digest.slice(0, 12)}</code>
                      <div className="badge-row">
                        {release.preview && <Badge value="preview" />}
                        {release.production && <Badge value="production" />}
                      </div>
                    </td>
                    <td>{release.testedAt ? 'Dev testing approved' : 'Awaiting Dev testing'}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          disabled={!data.deploymentEnabled || release.preview}
                          onClick={() =>
                            setPending({ digest: release.digest, environment: 'preview' })
                          }
                        >
                          Update Dev
                        </button>
                        {release.preview && !release.testedAt && (
                          <button
                            onClick={() =>
                              void perform(async () => {
                                await api(`/api/platform/releases/${release.digest}/tested`, {});
                                refresh();
                              }, 'Dev testing approved')
                            }
                          >
                            Mark tested
                          </button>
                        )}
                        <button
                          disabled={
                            !data.deploymentEnabled ||
                            !release.testedAt ||
                            !release.preview ||
                            release.production
                          }
                          onClick={() =>
                            setPending({ digest: release.digest, environment: 'production' })
                          }
                        >
                          Promote
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {pending && (
        <Modal
          title={pending.environment === 'preview' ? 'Update Dev DSP' : 'Promote to Production'}
          onClose={() => setPending(undefined)}
        >
          <p>
            This restarts the {pending.environment} services with release{' '}
            <code>{pending.digest.slice(0, 12)}</code>. Collections drain before activation.
          </p>
          <div className="form-actions">
            <button onClick={() => setPending(undefined)}>Cancel</button>
            <button
              className="primary"
              onClick={() =>
                void perform(async () => {
                  await api(`/api/platform/releases/${pending.digest}/deploy`, {
                    environment: pending.environment,
                  });
                  setPending(undefined);
                  refresh();
                }, 'Activation requested')
              }
            >
              Confirm update
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function HealthPanel() {
  const { data, error } = useData<PlatformHealth>('/api/platform/health', 10000);
  return (
    <Section title="Platform status">
      <ErrorBox message={error} />
      {data ? (
        <dl className="details">
          <dt>Release</dt>
          <dd>
            <code>{data.release.slice(0, 16)}</code>
          </dd>
          <dt>Data provider</dt>
          <dd>
            {data.providerMode === 'fixture' ? 'Synthetic development fixtures' : 'Native browser'}
          </dd>
          <dt>Browser workers</dt>
          <dd>
            {data.browsers.active} / {data.browsers.capacity} active
            <small>
              {data.browsers.memory.canStart
                ? 'Memory available for another browser'
                : 'New browsers waiting for memory'}
              {' · '}
              {data.browsers.memory.availableBytes === null
                ? 'Available memory unknown'
                : `${(data.browsers.memory.availableBytes / 1024 ** 2).toFixed(0)} MiB available`}
              {' · '}
              {(data.browsers.memory.requiredBytes / 1024 ** 2).toFixed(0)} MiB needed
            </small>
          </dd>
          <dt>Email</dt>
          <dd>{data.email ? 'Configured' : 'Not configured'}</dd>
          <dt>DSPs</dt>
          <dd>{data.dsps}</dd>
        </dl>
      ) : (
        <Loading />
      )}
    </Section>
  );
}
