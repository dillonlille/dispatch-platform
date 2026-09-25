import type { DspSummary } from '../../../../shared/contracts/index.js';

/** A DSP as the platform's page lists it: reachable, waiting for its owner, or stopped. */
export type DspState = 'online' | 'invited' | 'disabled';
export const dspStates: DspState[] = ['online', 'invited', 'disabled'];
export const stateLabels: Record<DspState, string> = {
  online: 'Online',
  invited: 'Invitation Sent',
  disabled: 'Disabled',
};
export const dspState = (dsp: DspSummary): DspState =>
  dsp.profile.removed || dsp.status === 'suspended' || dsp.status === 'failed'
    ? 'disabled'
    : dsp.ownerStatus === 'active'
      ? 'online'
      : 'invited';
