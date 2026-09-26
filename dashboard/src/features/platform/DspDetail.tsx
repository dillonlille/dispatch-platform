import { ChevronLeft, Ellipsis, Eye } from 'lucide-react';
import type { DspSummary } from '../../../../shared/contracts/index.js';
import { useUpdateState } from '../../app/browser-update.js';
import { featureCatalog } from '../../app/features.js';
import { Badge, DspAvatar, Popover, Tabs } from '../../ui/index.js';
import { deviceTimezone, time } from '../../lib/format.js';
import { DspFeaturesTab } from './DspFeaturesTab.js';
import { dspState, stateLabels } from './status.js';

export type DspAction = 'view' | 'enable' | 'retry' | 'restore' | 'remove' | 'disable';

// The chosen DSP: its facts, its features and what the platform may do to it.
export function DspDetail({
  dsp,
  back,
  act,
  changed,
}: {
  dsp: DspSummary;
  back: () => void;
  act: (action: DspAction) => void;
  /** A feature was switched; the list's counts follow. */
  changed: () => void;
}) {
  const [tab, setTab] = useUpdateState('dsp-tab', 'details');
  const state = dspState(dsp);
  const removed = dsp.profile.removed;
  const viewable = dsp.status === 'active' && !removed;
  const actions: [DspAction, string, boolean][] = [
    ['view', 'View', viewable],
    ['restore', 'Restore DSP', removed],
    ['retry', 'Retry', dsp.status === 'failed'],
    ['enable', 'Enable DSP', dsp.status === 'suspended' && !removed],
    [
      'remove',
      'Remove DSP',
      !dsp.permanent && !removed && ['active', 'suspended'].includes(dsp.status),
    ],
    ['disable', 'Disable DSP', dsp.status === 'active' && !dsp.permanent],
  ];
  const available = actions.filter(([, , shown]) => shown);
  const footer = available.filter(([action]) => action !== 'view');
  const zone = deviceTimezone();
  const connections = featureCatalog.filter(
    (feature) => feature.kind === 'connection' && dsp.features.includes(feature.id),
  );
  const facts: [string, React.ReactNode][] = [
    [
      'Owner',
      dsp.ownerStatus === 'active'
        ? (dsp.ownerEmail ?? 'Not assigned')
        : dsp.ownerStatus === 'invited'
          ? `Invitation sent to ${dsp.ownerEmail}`
          : 'Invitation expired',
    ],
    ['Members', String(dsp.members)],
    ['Created', time(dsp.createdAt, zone)],
    ['Station', dsp.profile.stationCode || '—'],
    ['Timezone', dsp.timezone],
    ['Setup', dsp.profile.setupRequired ? 'Incomplete' : 'Complete'],
    ...connections.map((feature): [string, React.ReactNode] => [
      feature.label,
      <Badge key={feature.id} value={dsp.connections[feature.id] ?? 'not_connected'} />,
    ]),
    ['Last collection', time(dsp.lastCollection, zone)],
    ['Next collection', time(dsp.nextCollection, zone, 'Nothing scheduled')],
  ];
  return (
    <section className="dsps-detail" aria-label={dsp.name}>
      <button className="text-button dsp-back" onClick={back}>
        <ChevronLeft size={16} />
        All DSPs
      </button>
      <div className="dsp-detail-head">
        <DspAvatar name={dsp.name} />
        <div className="dsp-detail-copy">
          <h2>
            {dsp.name}
            <Badge value={state}>{stateLabels[state]}</Badge>
          </h2>
          <small>{[dsp.profile.abbreviation, dsp.ownerEmail].filter(Boolean).join(' · ')}</small>
        </div>
        <div className="dsp-detail-actions">
          <button className="primary" disabled={!viewable} onClick={() => act('view')}>
            <Eye size={16} />
            View
          </button>
          {available.length > 0 && (
            <Popover
              className="row-menu"
              label={`Actions for ${dsp.name}`}
              trigger={<Ellipsis size={18} />}
              anchored
            >
              {available.map(([action, label]) => (
                <button
                  key={action}
                  className={action === 'disable' ? 'danger' : undefined}
                  onClick={() => act(action)}
                >
                  {label}
                </button>
              ))}
            </Popover>
          )}
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['details', 'Details'],
          ['features', 'Features'],
        ]}
        label="DSP"
      />
      {tab === 'features' ? (
        <DspFeaturesTab dsp={dsp} changed={changed} />
      ) : (
        <dl className="dsp-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {footer.length > 0 && (
        <div className="dsp-detail-foot">
          {footer.map(([action, label]) => (
            <button
              key={action}
              className={action === 'disable' ? 'danger' : undefined}
              onClick={() => act(action)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
