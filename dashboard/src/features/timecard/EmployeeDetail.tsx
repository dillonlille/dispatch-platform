import { useState } from 'react';
import type { Employee, EmployeeTimecardPeriod } from '../../../../shared/contracts/index.js';
import { useEmployeeTimecard } from '../../app/endpoints.js';
import { Badge, DataState } from '../../ui/index.js';
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
  const { data, error } = useEmployeeTimecard(employee.code, period, refreshKey);
  const person = data?.employee ?? employee;
  return (
    <section className="employee-detail" aria-label="Employee details">
      <div className="employee-detail-heading">
        <EmployeeAvatar name={person.name} />
        <Badge value={person.active ? 'active' : 'inactive'} />
      </div>
      <h3>{person.name}</h3>
      {person.position && <div className="employee-position">{person.position}</div>}
      <div className="employee-timecard-section" aria-busy={!data && !error}>
        <DataState data={data} error={error} failed={!!error}>
          {(data) => <EmployeeTimecard data={data} onPeriodChange={setPeriod} />}
        </DataState>
      </div>
    </section>
  );
}
