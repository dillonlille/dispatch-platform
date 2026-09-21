// The backend stores and validates more keys than the dashboard reads; the
// settings editor sends back every value it received, so they stay intact.
export interface PaycomPreferences {
  name_order: 'first_last' | 'last_first';
  driver_departments: string[] | null;
  late_da_time: string;
  late_da_departments: string[];
}
export interface PaycomSettings {
  revision: number;
  values: PaycomPreferences;
  options: { departments: { value: string; count: number }[] };
}
