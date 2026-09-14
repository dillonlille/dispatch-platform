import type { AuditEvent } from '../../shared/contracts/index.js';
import type { Storage } from '../storage/index.js';
export class Audit {
  constructor(private storage: Storage) {}
  record(actorId: string | null, dspId: string | null, action: string, detail = '') {
    this.storage.platform.run(
      'INSERT INTO audit(at,actor_id,dsp_id,action,detail) VALUES (?,?,?,?,?)',
      new Date().toISOString(),
      actorId,
      dspId,
      action,
      detail.slice(0, 240),
    );
  }
  list(dspId?: string, limit = 100): AuditEvent[] {
    return this.storage.platform.all<AuditEvent>(
      `SELECT a.id,a.at,a.actor_id actorId,COALESCE(u.name,'Scheduler') actorName,a.dsp_id dspId,d.name dspName,a.action,a.detail FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN dsps d ON d.id=a.dsp_id ${dspId ? 'WHERE a.dsp_id=?' : ''} ORDER BY a.id DESC LIMIT ?`,
      ...(dspId ? [dspId, limit] : [limit]),
    );
  }
}
