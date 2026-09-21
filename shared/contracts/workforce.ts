import type { Narrow } from './narrow.js';
import type { EmployeeTimecardResponse as GeneratedEmployeeTimecardResponse } from './generated/EmployeeTimecardResponse';
export type { EmployeeTimecardPeriod } from './generated/EmployeeTimecardPeriod';
export type EmployeeTimecardResponse = Narrow<
  GeneratedEmployeeTimecardResponse,
  { employee: Employee; timecards: Timecard[] }
>;
export interface Employee {
  code: string;
  name: string;
  department: string;
  position: string;
  station: string;
  active: boolean;
}
export interface Punch {
  inKind?: 'IN DAY' | 'IN LUNCH' | null;
  outKind?: 'OUT LUNCH' | 'OUT DAY' | null;
  in: string | null;
  out: string | null;
  hours: number | null;
}
export interface Timecard {
  employeeCode: string;
  date: string;
  hours: number;
  status: string;
  punches: Punch[];
  // The employee's Paycom timecard page for the pay period containing `date`.
  // Absent on rows still being collected; null before links were retained.
  sourceUrl?: string | null;
}
