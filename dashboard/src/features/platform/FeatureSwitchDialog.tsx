import type { DspFeatureReport, DspSummary } from '../../../../shared/contracts/index.js';
import { setDspFeature } from '../../app/endpoints.js';
import {
  capabilityLabel,
  featureCatalog,
  featureLabel,
  previewSwitch,
  type FeatureEntry,
} from '../../app/features.js';
import { useAction } from '../../app/useAction.js';
import { Modal } from '../../ui/index.js';

const SCHEDULES = 'timecard';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (labels: string[]) =>
  labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : (labels[0] ?? '');

// Says what a switch changes, the switches it brings along and what stops, before it acts.
export function FeatureSwitchDialog({
  dsp,
  feature,
  on,
  enabled,
  report,
  onClose,
  onDone,
}: {
  dsp: DspSummary;
  feature: FeatureEntry;
  on: boolean;
  enabled: readonly string[];
  report: DspFeatureReport;
  onClose: () => void;
  onDone: () => void;
}) {
  const changes = previewSwitch(enabled, feature.id, on);
  const entry = (id: string) => featureCatalog.find((f) => f.id === id)!;
  const others = changes.filter((change) => change.feature !== feature.id);
  const reasons = others.map((change) => {
    const other = entry(change.feature);
    if (on && change.enabled)
      return `${feature.label} needs ${capabilityLabel(other.provides ?? '')}, so ${other.label} switches on too.`;
    if (on)
      return `A DSP runs one ${capabilityLabel(feature.provides ?? '').replace(/^an? /, '')} at a time, so ${other.label} switches off.`;
    return `${other.label} needs ${capabilityLabel(feature.provides ?? '')}, so it switches off too.`;
  });
  const pagesOff = changes.filter((c) => !c.enabled && entry(c.feature).kind === 'page');
  const pagesOn = changes.filter((c) => c.enabled && entry(c.feature).kind === 'page');
  const connectionsOn = changes.filter((c) => c.enabled && entry(c.feature).kind === 'connection');
  const effects: string[] = [];
  if (pagesOff.length)
    effects.push(
      `The ${names(pagesOff.map((c) => featureLabel(c.feature)))} ${pagesOff.length > 1 ? 'pages and their' : 'page and its'} permissions disappear for the team.`,
    );
  if (pagesOff.some((c) => c.feature === SCHEDULES))
    effects.push(
      report.schedules || report.activeJobs
        ? `${plural(report.schedules, 'schedule')} pause${report.schedules === 1 ? 's' : ''}${
            report.activeJobs
              ? ` and ${plural(report.activeJobs, 'running collection')} ${report.activeJobs === 1 ? 'is' : 'are'} cancelled`
              : ''
          }.`
        : 'Nothing is scheduled or running.',
    );
  if (!on) effects.push('Credentials, schedules and collected data are kept.');
  if (pagesOn.length)
    effects.push(
      `The ${names(pagesOn.map((c) => featureLabel(c.feature)))} ${pagesOn.length > 1 ? 'pages appear' : 'page appears'} for the team with the permissions their roles already hold.`,
    );
  for (const change of connectionsOn)
    effects.push(
      `${featureLabel(change.feature)} appears under Connections${
        dsp.connections[change.feature] === 'ready' ? '' : ' and is not connected yet'
      }.`,
    );
  if (pagesOn.some((c) => c.feature === SCHEDULES))
    effects.push('Schedules resume from their next run.');
  // The feature asked for first, then what it brings along.
  const labels = names([feature.label, ...others.map((c) => featureLabel(c.feature))]);
  const save = useAction(
    async () => {
      await setDspFeature(dsp.id, feature.id, on);
      onDone();
    },
    { success: `${labels} switched ${on ? 'on' : 'off'}` },
  );
  return (
    <Modal
      title={`Switch ${on ? 'on' : 'off'} ${feature.label} for ${dsp.name}?`}
      onClose={onClose}
    >
      {reasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      <ul className="dsp-switch-effects">
        {effects.map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className={on ? 'primary' : 'danger'}
          disabled={save.busy}
          onClick={() => void save.run()}
        >
          Switch {on ? 'on' : 'off'} {labels}
        </button>
      </div>
    </Modal>
  );
}
