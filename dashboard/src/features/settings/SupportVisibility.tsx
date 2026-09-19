import { useState } from 'react';
import type { DspSummary } from '../../../../shared/contracts/index.js';
import { api, useData } from '../../app/api.js';
import { DataState, Empty } from '../../ui/index.js';
import { useAction } from '../../app/useAction.js';

// Where it is on, a platform owner's activity is listed in that DSP's audit log,
// always as "Platform support". It applies from the moment it is switched.
export function SupportVisibility() {
  const { data, error, refresh } = useData<DspSummary[]>('/api/platform/dsps');
  const dsps = data?.filter((dsp) => !dsp.profile.removed);
  // The switch moves at once; a refused change puts it back.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const show = useAction(
    (dsp: DspSummary, visible: boolean) =>
      api(`/api/platform/dsps/${dsp.id}/support-visibility`, { visible }),
    {
      success: (dsp, visible) =>
        visible
          ? `Platform support shown to ${dsp.name}`
          : `Platform support hidden from ${dsp.name}`,
    },
  );
  return (
    <section className="settings-section">
      <div>
        <h2>Show Platform support in audit logs</h2>
      </div>
      <DataState data={dsps} error={error} failed={Boolean(error)}>
        {(dsps) =>
          !dsps.length ? (
            <Empty title="No DSPs" />
          ) : (
            <div className="permission-rows support-visibility">
              {dsps.map((dsp) => (
                <label className="permission-row" key={dsp.id}>
                  <span>{dsp.name}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={chosen[dsp.id] ?? dsp.profile.supportVisible}
                    onChange={(event) => {
                      const visible = event.target.checked;
                      setChosen((current) => ({ ...current, [dsp.id]: visible }));
                      void show.run(dsp, visible).then((saved) => {
                        if (!saved) setChosen((current) => ({ ...current, [dsp.id]: !visible }));
                        refresh();
                      });
                    }}
                  />
                </label>
              ))}
            </div>
          )
        }
      </DataState>
    </section>
  );
}
