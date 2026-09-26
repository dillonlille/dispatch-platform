import { useState } from 'react';
import { AppWindow, Plug, type LucideIcon } from 'lucide-react';
import type { DspSummary } from '../../../../shared/contracts/index.js';
import { useDspFeatures } from '../../app/endpoints.js';
import { featureCatalog, type FeatureEntry } from '../../app/features.js';
import { Badge, ErrorBox } from '../../ui/index.js';
import { FeatureSwitchDialog } from './FeatureSwitchDialog.js';

type Area = { kind: FeatureEntry['kind']; label: string; icon: LucideIcon };
const areas: Area[] = [
  { kind: 'page', label: 'Pages', icon: AppWindow },
  { kind: 'connection', label: 'Connections', icon: Plug },
];

// The catalog by area: choose an area on the left, switch its features on the right.
// A switch asks before it acts.
export function DspFeaturesTab({ dsp, changed }: { dsp: DspSummary; changed: () => void }) {
  const { data, error, refresh } = useDspFeatures(dsp.id);
  const [kind, setKind] = useState<Area['kind']>('page');
  const [pending, setPending] = useState<{ feature: FeatureEntry; on: boolean }>();
  const enabled = data
    ? data.features.filter((state) => state.enabled).map((state) => state.feature)
    : dsp.features;
  const of = (area: Area) => featureCatalog.filter((feature) => feature.kind === area.kind);
  const on = (features: FeatureEntry[]) => features.filter((f) => enabled.includes(f.id)).length;
  const area = areas.find((candidate) => candidate.kind === kind)!;
  const items = of(area);
  return (
    <div className="dsp-features">
      <ErrorBox message={error} />
      <div className="dsp-areas" role="tablist" aria-label="Feature areas">
        {areas.map((candidate) => (
          <button
            key={candidate.kind}
            role="tab"
            aria-selected={candidate.kind === kind}
            onClick={() => setKind(candidate.kind)}
          >
            <candidate.icon size={16} aria-hidden="true" />
            <span>{candidate.label}</span>
            <small>
              {on(of(candidate))}/{of(candidate).length}
            </small>
          </button>
        ))}
      </div>
      <div className="dsp-area" role="tabpanel" aria-label={area.label}>
        <h3>
          {area.label}
          <span>
            {on(items)} of {items.length}
          </span>
        </h3>
        {items.map((feature) => {
          const has = enabled.includes(feature.id);
          return (
            <div className={`dsp-feature-row ${has ? '' : 'off'}`} key={feature.id}>
              <strong>{feature.label}</strong>
              <div className="dsp-feature-end">
                {feature.kind === 'connection' && has && (
                  <Badge value={dsp.connections[feature.id] ?? 'not_connected'} />
                )}
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={feature.label}
                  checked={has}
                  disabled={!data}
                  onChange={(event) => setPending({ feature, on: event.target.checked })}
                />
              </div>
            </div>
          );
        })}
      </div>
      {pending && data && (
        <FeatureSwitchDialog
          dsp={dsp}
          feature={pending.feature}
          on={pending.on}
          enabled={enabled}
          report={data}
          onClose={() => setPending(undefined)}
          onDone={() => {
            setPending(undefined);
            refresh();
            changed();
          }}
        />
      )}
    </div>
  );
}
