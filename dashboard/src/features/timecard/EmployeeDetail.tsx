import { useState } from 'react';
import type { Employee, EmployeeTimecardPeriod } from '../../../../shared/contracts/index.js';
import { useEmployeeTimecard } from '../../app/endpoints.js';
import { Badge } from '../../ui/index.js';
import { EmployeeAvatar } from './EmployeeAvatar.js';
import { EmployeeTimecard } from './EmployeeTimecard.js';

export function EmployeeDetail({
  employee,
  refreshKey,
}: {
  employee: Employee;
  refreshKey: string;
}) {
  // The parent keys this component by employee, so opening anyone starts at their latest period.
  const [period, setPeriod] = useState<EmployeeTimecardPeriod | null>(null);
  const { data, stale, error, refresh } = useEmployeeTimecard(employee.code, period, refreshKey);
  const shown = data ?? stale;
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
          onPeriodChange={setPeriod}
          onRetry={refresh}
        />
      </div>
    </section>
  );
}
