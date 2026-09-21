import type { Employee, EmployeeTimecardPeriod } from '../../../../shared/contracts/index.js';
import type { useEmployeeTimecard } from '../../app/endpoints.js';
import { Badge } from '../../ui/index.js';
import { EmployeeAvatar } from './EmployeeAvatar.js';
import { EmployeeTimecard } from './EmployeeTimecard.js';

export function EmployeeDetail({
  employee,
  period,
  onPeriodChange,
  timecard,
}: {
  employee: Employee;
  period: EmployeeTimecardPeriod | null;
  onPeriodChange: (period: EmployeeTimecardPeriod) => void;
  timecard: ReturnType<typeof useEmployeeTimecard>;
}) {
  const { data, stale, error, refresh } = timecard;
  const shown = data ?? (stale?.employee.code === employee.code ? stale : undefined);
  const person = shown?.employee ?? employee;
  return (
    <section className="employee-detail" aria-label="Employee details">
      <div className="employee-detail-heading">
        <EmployeeAvatar name={person.name} />
        <Badge value={person.active ? 'active' : 'inactive'} />
      </div>
      <div className="employee-identity">
        <h3 title={person.name}>{person.name}</h3>
        <div className="employee-position" title={person.position}>
          {person.position || '\u00a0'}
        </div>
      </div>
      <div className="employee-timecard-section" aria-busy={!data && !error}>
        <EmployeeTimecard
          data={shown}
          busy={!data && !error}
          error={error}
          requestedPeriod={period}
          onPeriodChange={onPeriodChange}
          onRetry={refresh}
        />
      </div>
    </section>
  );
}
