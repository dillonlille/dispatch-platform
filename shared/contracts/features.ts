/** The features a DSP may have, mirroring the catalog in `backend/src/features.rs`. */
export const pages = ['timecard', 'uniforms'] as const;
export const connections = ['paycom', 'cortex'] as const;
export const features = [...pages, ...connections] as const;
export type Feature = (typeof features)[number];
export type PageFeature = (typeof pages)[number];
export type ConnectionFeature = (typeof connections)[number];
export type { DspFeatures } from './generated/DspFeatures';
export type { FeatureChange } from './generated/FeatureChange';
export type { FeatureState } from './generated/FeatureState';
export type { DspFeatureReport } from './generated/DspFeatureReport';
