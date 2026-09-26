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
const capabilities: Record<string, string> = {
  timecards: 'a timecard source',
  meal_breaks: 'a meal-break source',
};
export const capabilityLabel = (capability: string) => capabilities[capability] ?? capability;
export const providerOf = (capability: string) =>
  featureCatalog.find((feature) => feature.provides === capability);
/** "Requires a timecard source (Paycom) and a meal-break source (Cortex, off)". */
export const requirementText = (feature: FeatureEntry, enabled: readonly string[]) =>
  `Requires ${feature.requires
    .map((capability) => {
      const provider = providerOf(capability);
      const state = provider && !enabled.includes(provider.id) ? ', off' : '';
      return `${capabilityLabel(capability)}${provider ? ` (${provider.label}${state})` : ''}`;
    })
    .join(' and ')}`;
/**
 * What switching `id` would change, mirroring `set_feature` in the backend: enabling a
 * page enables the one provider of each capability it lacks, enabling a provider switches
 * off another of the same capability, and disabling a provider disables the pages left
 * without one.
 */
export function previewSwitch(enabled: readonly string[], id: Feature, on: boolean) {
  const current = new Set(enabled);
  const changed: { feature: Feature; enabled: boolean }[] = [];
  const flip = (feature: FeatureEntry, to: boolean) => {
    if (current.has(feature.id) === to) return;
    if (to) current.add(feature.id);
    else current.delete(feature.id);
    changed.push({ feature: feature.id, enabled: to });
  };
  const provided = (capability: string) =>
    featureCatalog.some((f) => f.provides === capability && current.has(f.id));
  const feature = featureCatalog.find((f) => f.id === id)!;
  if (on) {
    if (feature.provides)
      for (const other of featureCatalog)
        if (other.provides === feature.provides && other.id !== feature.id) flip(other, false);
    for (const capability of feature.requires) {
      if (provided(capability)) continue;
      const providers = featureCatalog.filter((f) => f.provides === capability);
      if (providers.length === 1) flip(providers[0]!, true);
    }
    flip(feature, true);
  } else {
    flip(feature, false);
    for (const page of featureCatalog)
      if (page.kind === 'page' && !page.requires.every(provided)) flip(page, false);
  }
  return changed;
}
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
