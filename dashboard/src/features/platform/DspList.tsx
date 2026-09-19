import { useUpdateState } from '../../app/browser-update.js';
import { useMemo, useState } from 'react';
import { Ellipsis, Plus, RefreshCw, Eye } from 'lucide-react';
import type { DspSummary } from '../../../../shared/contracts/index.js';
import { useAction } from '../../app/useAction.js';
import { api } from '../../app/api.js';
import { DspAvatar } from './DspAvatar.js';
import {
  Badge,
  ConfirmDialog,
  DataState,
  DataTable,
  DetailList,
  Empty,
  ErrorBox,
  Header,
  Modal,
  Popover,
  SearchInput,
  Tabs,
  useDataTable,
  type TableColumn,
} from '../../ui/index.js';
import { title } from '../../lib/format.js';
import { open } from './open.js';
import { usePlatformDsps } from '../../app/endpoints.js';

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
const none: DspSummary[] = [];
export function DspList() {
  const { data, error, refresh } = usePlatformDsps(10000);
  const [query, setQuery] = useUpdateState('dsp-query', ''),
    [filter, setFilter] = useUpdateState('dsp-filter', 'all'),
    [creating, setCreating] = useState(false),
    [suspending, setSuspending] = useState<DspSummary>(),
    [removing, setRemoving] = useState<DspSummary>(),
    [detail, setDetail] = useState<DspSummary>();
  const dsps = data ?? none;
  const visible = useMemo(
    () =>
      dsps.filter(
        (d) =>
          `${d.name} ${d.ownerEmail ?? ''}`.toLowerCase().includes(query.toLowerCase()) &&
          (filter === 'removed'
            ? d.profile.removed
            : !d.profile.removed &&
              (filter === 'all' ||
                (filter === 'running' && d.status === 'active') ||
                (filter === 'onboarding' &&
                  (d.ownerStatus !== 'active' || d.profile.setupRequired)))),
      ),
    [dsps, query, filter],
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
  const columns: TableColumn<DspSummary>[] = [
    {
      id: 'dsp',
      header: 'DSP',
      headerClassName: 'fleet-dsp-column',
      value: (dsp) => dsp.name,
      cell: (dsp) => (
        <button className="identity-button" onClick={() => setDetail(dsp)}>
          <DspAvatar name={dsp.name} />
          <span className="dsp-identity-copy">
            <strong>{dsp.name}</strong>
            <span>{dsp.profile.abbreviation || (dsp.permanent ? 'DEV' : '')}</span>
          </span>
        </button>
      ),
    },
    {
      id: 'owner',
      header: 'Owner',
      className: 'muted',
      value: (dsp) => dsp.ownerEmail,
      cell: (dsp) => dsp.ownerEmail ?? 'No owner assigned',
    },
    {
      id: 'runtime',
      header: 'Runtime',
      value: runtime,
      cell: (dsp) => <Badge value={dsp.status}>{runtime(dsp)}</Badge>,
    },
    {
      id: 'onboarding',
      header: 'Onboarding',
      value: onboarding,
      cell: (dsp) => (
        <Badge value={dsp.ownerStatus === 'active' ? 'neutral' : 'pending'}>
          {onboarding(dsp)}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'cell-end',
      cell: (dsp) => (
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
      ),
    },
  ];
  const table = useDataTable({ columns, rows: visible, rowId: (dsp) => dsp.id });
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
            <DataTable table={table} className="fleet-table" />
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
