import type { Dsp, Workforce } from '../../shared/contracts/index.js';
import { dateInTimezone } from './workforce.js';
export function fixtureWorkforce(dsp: Dsp): Workforce {
  const names = [
    'Avery Morgan',
    'Jordan Ellis',
    'Morgan Reed',
    'Taylor Brooks',
    'Cameron Hayes',
    'Casey Rivera',
    'Riley Bennett',
    'Alex Parker',
    'Jamie Collins',
    'Drew Sullivan',
    'Sam Mitchell',
    'Quinn Foster',
  ];
  const today = dateInTimezone(dsp.timezone);
  const dates = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.parse(`${today}T12:00:00Z`) - (6 - i) * 86400_000).toISOString().slice(0, 10),
  );
  return {
    employees: names.map((name, i) => ({
      code: `E${String(i + 1).padStart(3, '0')}`,
      name,
      department: i === 0 ? 'Operations' : 'Delivery',
      position: i === 0 ? 'Dispatcher' : 'Delivery associate',
      station: 'DEMO1',
      active: true,
    })),
    timecards: names.flatMap((_, i) =>
      dates.map((date) => ({
        employeeCode: `E${String(i + 1).padStart(3, '0')}`,
        date,
        hours: i % 3 === 0 ? 8.5 : 8,
        status: 'Complete',
        punches: [
          { in: '08:00', out: '12:00', hours: 4 },
          { in: '12:30', out: i % 3 === 0 ? '17:00' : '16:30', hours: i % 3 === 0 ? 4.5 : 4 },
        ],
      })),
    ),
    collectedAt: new Date().toISOString(),
    from: dates[0]!,
    to: today,
  };
}
