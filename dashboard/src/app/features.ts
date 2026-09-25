import type { DspView, Feature, Permission } from '../../../shared/contracts/index.js';

export type FeatureEntry = {
  id: Feature;
  label: string;
  kind: 'page' | 'connection';
  /** The permissions the feature owns; without it, nobody in the DSP holds them. */
  permissions: Permission[];
  /** What a connection supplies. */
  provides?: string;
  /** What a page needs one enabled connection of. */
  requires: string[];
};
/** Mirrors `PAGES` and the collector registry in `backend/src/features.rs`. */
export const featureCatalog: FeatureEntry[] = [
  {
    id: 'timecard',
    label: 'Timecard',
    kind: 'page',
    permissions: ['timecard.view', 'timecard.manage', 'collections.run'],
    requires: ['timecards', 'meal_breaks'],
  },
  {
    id: 'uniforms',
    label: 'Uniform Inventory',
    kind: 'page',
    permissions: ['uniforms.view', 'uniforms.adjust', 'uniforms.manage'],
    requires: [],
  },
  {
    id: 'paycom',
    label: 'Paycom',
    kind: 'connection',
    permissions: [],
    provides: 'timecards',
    requires: [],
  },
  {
    id: 'cortex',
    label: 'Cortex',
    kind: 'connection',
    permissions: [],
    provides: 'meal_breaks',
    requires: [],
  },
];
export const featureLabel = (id: string) =>
  featureCatalog.find((feature) => feature.id === id)?.label ?? id;
export const hasFeature = (view: DspView | undefined, id: Feature) =>
  Boolean(view?.features.includes(id));
/** Whether a permission exists with these features, mirroring `grants` in the backend. */
export function grants(features: readonly string[], permission: Permission) {
  if (permission === 'connections.manage')
    return featureCatalog.some((f) => f.kind === 'connection' && features.includes(f.id));
  const owner = featureCatalog.find((f) => f.permissions.includes(permission));
  return !owner || features.includes(owner.id);
}
