/** The features a DSP may have, mirroring the catalog in `backend/src/features.rs`. */
export const features = ['timecard', 'uniforms', 'paycom', 'cortex'] as const;
export type Feature = (typeof features)[number];
export type { DspFeatures } from './generated/DspFeatures';
export type { FeatureChange } from './generated/FeatureChange';
export type { FeatureState } from './generated/FeatureState';
export type { DspFeatureReport } from './generated/DspFeatureReport';
