import type { DspView, SessionView } from '../../../shared/contracts/index.js';
import { api, ApiError } from './api.js';

// The role a platform owner looks through survives a reload of this tab and is
// forgotten once they leave the DSP.
const VIEW_ROLE = 'dispatch-view-role';
let viewRole: string | null | undefined;
function savedRole(dspId: string) {
  if (viewRole === undefined)
    try {
      viewRole = sessionStorage.getItem(VIEW_ROLE);
    } catch {
      viewRole = null;
    }
  const [dsp, role] = viewRole?.split(' ') ?? [];
  return dsp === dspId ? role : undefined;
}
export function saveRole(dspId?: string, roleId?: string) {
  viewRole = dspId && roleId ? `${dspId} ${roleId}` : null;
  try {
    if (viewRole) sessionStorage.setItem(VIEW_ROLE, viewRole);
    else sessionStorage.removeItem(VIEW_ROLE);
  } catch {
    /* The role still applies until the page reloads. */
  }
}
export async function openView(session: SessionView, dspId: string) {
  const roleId = session.user.platformOwner ? savedRole(dspId) : undefined;
  if (!roleId) return api<DspView>('/api/session/dsp', { dspId });
  try {
    return await api<DspView>('/api/session/dsp', { dspId, roleId });
  } catch (error) {
    // The DSP deleted the role being looked through; owner access remains.
    if (!(error instanceof ApiError) || error.code !== 'dsp_view_expired') throw error;
    saveRole();
    return api<DspView>('/api/session/dsp', { dspId });
  }
}
