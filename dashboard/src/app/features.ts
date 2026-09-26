import type {
  ConnectionFeature,
  DspView,
  Feature,
  PageFeature,
  Permission,
} from '../../../shared/contracts/index.js';

type Entry<Kind, Id> = {
  id: Id;
  label: string;
  kind: Kind;
  /** The permissions the feature owns; without it, nobody in the DSP holds them. */
  permissions: Permission[];
  /** What a page needs one enabled connection of. */
  requires: string[];
};
export type PageEntry = Entry<'page', PageFeature> & { provides?: undefined };
/** `provides` is what the connection supplies. */
export type ConnectionEntry = Entry<'connection', ConnectionFeature> & { provides: string };
export type FeatureEntry = PageEntry | ConnectionEntry;
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
/** The page whose schedules, collections and jobs run; mirrors `SCHEDULES` in the backend. */
export const schedulesFeature: PageFeature = 'timecard';
/** Every capability a page requires has a label; the mirror test checks. */
const capabilities: Record<string, string> = {
  timecards: 'a timecard source',
  meal_breaks: 'a meal-break source',
};
export const capabilityLabel = (capability: string) => capabilities[capability] ?? capability;
/** The connections among `features`, in catalog order. */
export const connectionFeatures = (features: readonly string[]) =>
  featureCatalog.filter(
    (f): f is ConnectionEntry => f.kind === 'connection' && features.includes(f.id),
  );
/**
 * What switching `id` would change, mirroring `set_feature` in the backend: enabling a
 * page enables the one provider of each capability it lacks, enabling a provider switches
 * off another of the same capability, and disabling a provider disables the pages left
 * without one. Undefined when a page needs a capability with several providers and none
 * is on: the backend refuses that switch until one is chosen.
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
      if (providers.length !== 1) return undefined;
      flip(providers[0]!, true);
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
