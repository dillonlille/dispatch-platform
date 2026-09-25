import { useState } from 'react';
import type { DspSummary } from '../../../../shared/contracts/index.js';
import { useDspFeatures } from '../../app/endpoints.js';
import { featureCatalog, requirementText, type FeatureEntry } from '../../app/features.js';
import { Badge, ErrorBox } from '../../ui/index.js';
import { deviceTimezone, time } from '../../lib/format.js';
import { FeatureSwitchDialog } from './FeatureSwitchDialog.js';

const groups: [string, FeatureEntry['kind']][] = [
  ['Pages', 'page'],
  ['Connections', 'connection'],
];

// Every feature the DSP could have, with a switch; a switch asks before it acts.
export function DspFeaturesTab({ dsp, changed }: { dsp: DspSummary; changed: () => void }) {
  const { data, error, refresh } = useDspFeatures(dsp.id);
  const [pending, setPending] = useState<{ feature: FeatureEntry; on: boolean }>();
  const enabled = data
    ? data.features.filter((state) => state.enabled).map((state) => state.feature)
    : dsp.features;
  const zone = deviceTimezone();
  const since = (id: string) => {
    const state = data?.features.find((state) => state.feature === id);
    if (!state?.enabled || !state.changedAt) return null;
    return (
      <small>
        Enabled {time(state.changedAt, zone)}
        {state.changedBy ? ` by ${state.changedBy}` : ''}
      </small>
    );
  };
  return (
    <div className="dsp-features">
      <ErrorBox message={error} />
      {groups.map(([label, kind]) => {
        const items = featureCatalog.filter((feature) => feature.kind === kind);
        return (
          <div key={kind}>
            <h3 className="dsp-feature-group">
              <span>{label}</span>
              <span>
                {items.filter((feature) => enabled.includes(feature.id)).length} of {items.length}
              </span>
            </h3>
            {items.map((feature) => {
              const on = enabled.includes(feature.id);
              return (
                <div className={`dsp-feature-row ${on ? '' : 'off'}`} key={feature.id}>
                  <div className="dsp-feature-name">
                    <strong>{feature.label}</strong>
                    {feature.requires.length > 0 && (
                      <small>{requirementText(feature, enabled)}</small>
                    )}
                    {kind === 'connection' && since(feature.id)}
                  </div>
                  <div className="dsp-feature-end">
                    {kind === 'page' && since(feature.id)}
                    {kind === 'connection' && on && (
                      <Badge value={dsp.connections[feature.id] ?? 'not_connected'} />
                    )}
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={feature.label}
                      checked={on}
                      disabled={!data}
                      onChange={(event) => setPending({ feature, on: event.target.checked })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
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
