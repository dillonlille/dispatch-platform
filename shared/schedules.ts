export interface ScheduleInput {
  name: string;
  collection: 'paycom' | 'meal_break' | 'both';
  cadence: 'interval' | 'daily';
  intervalMinutes: number | null;
  localTime: string;
  enabled: boolean;
}
export interface CollectionSchedule extends ScheduleInput {
  id: string;
  revision: number;
  nextRun: string | null;
  lastError: string | null;
}
export interface CollectionSchedules {
  timezone: string;
  dspName: string;
  schedules: CollectionSchedule[];
}
export const scheduleIssues: Record<string, string> = {
  schedule_paycom_required: 'Connect Paycom before enabling this schedule.',
  schedule_meals_required: 'Connect Cortex before enabling Meal Break collections.',
  schedule_scope_required: 'Run an initial Meal Break collection to set up the DSP’s station.',
  sync_in_progress: 'Waiting for the current collection',
  queue_full: 'Waiting for the collection queue',
};
