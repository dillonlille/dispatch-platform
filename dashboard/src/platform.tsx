import { useState, type FormEvent } from 'react';
import { Plus, Search, Building2, FlaskConical, Check, Copy } from 'lucide-react';
import type {
  DspSummary,
  AuditEvent,
  Job,
  ReleaseSummary,
  PlatformHealth,
} from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import {
  Badge,
  Empty,
  ErrorBox,
  Header,
  Loading,
  Modal,
  OpenButton,
  Section,
  time,
  title,
} from './ui.js';
export type Perform = (work: () => Promise<unknown>, success?: string) => Promise<boolean>;
export function DspList({ open, perform }: { open: (dsp: DspSummary) => void; perform: Perform }) {
  const { data, error, refresh } = useData<DspSummary[]>('/api/platform/dsps', 10000),
    activity = useData<AuditEvent[]>('/api/platform/audit', 10000);
  const [query, setQuery] = useState(''),
    [environment, setEnvironment] = useState('all'),
    [creating, setCreating] = useState(false),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false);
  const dsps = data ?? [],
    visible = dsps.filter(
      (d) =>
        d.name.toLowerCase().includes(query.toLowerCase()) &&
        (environment === 'all' || d.environment === environment),
    );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const ok = await perform(async () => {
      const result = await api<{ invitationUrl?: string }>('/api/platform/dsps', {
        name: form.get('name'),
        timezone: form.get('timezone'),
        ...(form.get('ownerEmail') ? { ownerEmail: form.get('ownerEmail') } : {}),
      });
      setLink(result.invitationUrl ?? '');
      refresh();
    }, 'DSP created');
    setBusy(false);
    if (ok) setCreating(false);
  }
  return (
    <>
      <Header title="DSPs" subtitle="Manage access, connections, and collection activity.">
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          Create DSP
        </button>
      </Header>
      <ErrorBox message={error} />
      <div className="summary-strip">
        <div>
          <span>Total DSPs</span>
          <strong>{dsps.length}</strong>
        </div>
        <div>
          <span>Production</span>
          <strong>{dsps.filter((d) => d.environment === 'production').length}</strong>
        </div>
        <div>
          <span>Preview</span>
          <strong>{dsps.filter((d) => d.environment === 'preview').length}</strong>
        </div>
      </div>
      <div className="toolbar">
        <label className="search">
          <Search size={18} />
          <input
            aria-label="Search DSPs"
            placeholder="Search DSPs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter environment"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
        >
          <option value="all">All environments</option>
          <option value="production">Production</option>
          <option value="preview">Preview</option>
        </select>
        <span className="muted result-count">{visible.length} DSPs</span>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>DSP</th>
                <th>Environment</th>
                <th>Status</th>
                <th>Paycom</th>
                <th>Last collection</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((dsp) => (
                <tr key={dsp.id}>
                  <td>
                    <div className="identity">
                      <span className={`entity-icon ${dsp.permanent ? 'preview-icon' : ''}`}>
                        {dsp.permanent ? <FlaskConical size={20} /> : <Building2 size={20} />}
                      </span>
                      <div>
                        <strong>{dsp.name}</strong>
                        <small>{dsp.permanent ? 'Development & testing' : dsp.timezone}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge value={dsp.environment} />
                  </td>
                  <td>
                    <Badge value={dsp.status} />
                  </td>
                  <td>
                    <Badge value={dsp.paycom} />
                  </td>
                  <td className="muted">{time(dsp.lastCollection)}</td>
                  <td>
                    {dsp.status === 'active' ? (
                      <OpenButton onClick={() => open(dsp)} />
                    ) : (
                      <button
                        className="text-button"
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
                        {dsp.status === 'failed' ? 'Retry' : 'Resume'}
                      </button>
                    )}
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
      <Section title="Recent activity">
        <Activity events={activity.data?.slice(0, 5) ?? []} />
      </Section>
      {creating && (
        <Modal title="Create DSP" onClose={() => setCreating(false)}>
          <p className="muted">Create a workspace with its own private data and connections.</p>
          <form onSubmit={(e) => void create(e)}>
            <label>
              DSP name
              <input name="name" required maxLength={100} placeholder="Company name" />
            </label>
            <label>
              Timezone
              <input
                name="timezone"
                required
                defaultValue="America/Chicago"
                placeholder="America/Chicago"
              />
            </label>
            <label>
              Owner email <span className="muted">(optional)</span>
              <input name="ownerEmail" type="email" placeholder="owner@company.com" />
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
      {link && <InvitationLink link={link} close={() => setLink('')} />}
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
      <table>
        <thead>
          <tr>
            <th>Collection</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Requested</th>
            <th>Attempt</th>
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
      <Header title="Jobs" subtitle="Follow collection progress and recent results." />
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
    release: string;
    update?: { status: string; commit?: string; updatedAt: string } | null;
  }>('/api/platform/releases', 5000);
  const [pending, setPending] = useState<{ digest: string; environment: string }>();
  if (data?.standalone)
    return (
      <>
        <Header
          title="Dev builds"
          subtitle="Merged changes are checked and installed automatically."
        />
        <ErrorBox message={error} />
        <Section title="Running build">
          <div className="build-details">
            <p>This environment includes the owner dashboard and all of its test DSPs.</p>
            <p>
              Build: <code>{data.release.slice(0, 12)}</code>
            </p>
            {data.update?.commit && (
              <p>
                Commit: <code>{data.update.commit.slice(0, 12)}</code>
              </p>
            )}
            {data.update && (
              <p>
                Update status: {title(data.update.status)} · {time(data.update.updatedAt)}
              </p>
            )}
          </div>
        </Section>
        <div className="notice">
          Feature PRs merge into dev when approved. Successful builds update this platform
          automatically. Your accounts, DSPs and connection data are retained.
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
