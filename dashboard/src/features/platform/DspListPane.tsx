import { RefreshCw } from 'lucide-react';
import type { DspSummary } from '../../../../shared/contracts/index.js';
import { featureCatalog } from '../../app/features.js';
import { DspAvatar, Empty, SearchInput } from '../../ui/index.js';
import { dspState, dspStates, stateLabels } from './status.js';

// Every DSP, grouped by state, with the one open in the pane marked.
export function DspListPane({
  dsps,
  query,
  setQuery,
  selected,
  onSelect,
  refresh,
}: {
  dsps: DspSummary[];
  query: string;
  setQuery: (value: string) => void;
  selected?: string;
  onSelect: (dsp: DspSummary) => void;
  refresh: () => void;
}) {
  const groups = dspStates
    .map((state) => [state, dsps.filter((dsp) => dspState(dsp) === state)] as const)
    .filter(([, rows]) => rows.length);
  return (
    <section className="dsps-list" aria-label="DSPs">
      <div className="dsps-list-tools">
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
      {groups.map(([state, rows]) => (
        <div key={state}>
          <h2 className="dsp-group">
            <span>{stateLabels[state]}</span>
            <span>{rows.length}</span>
          </h2>
          {rows.map((dsp) => (
            <button
              className="dsp-row"
              key={dsp.id}
              aria-current={dsp.id === selected ? 'true' : undefined}
              onClick={() => onSelect(dsp)}
            >
              <DspAvatar name={dsp.name} />
              <span className="dsp-identity-copy">
                <strong>{dsp.name}</strong>
                <span>{dsp.ownerEmail ?? 'No owner assigned'}</span>
              </span>
              <small className="dsp-row-count">
                {dsp.features.length} of {featureCatalog.length}
              </small>
            </button>
          ))}
        </div>
      ))}
      {!dsps.length && (
        <Empty title="No DSPs found">Try another search or create your first DSP.</Empty>
      )}
    </section>
  );
}
