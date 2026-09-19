import { AuditLog } from './AuditLog.js';
import { Header } from '../../ui/index.js';

export function AuditPage() {
  return (
    <>
      <Header title="Audit log" />
      <AuditLog />
    </>
  );
}
