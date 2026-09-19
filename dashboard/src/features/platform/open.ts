import { dspHash, navigate } from '../../app/navigation.js';

export const open = (dsp: { id: string }) => navigate(dspHash(dsp.id));
