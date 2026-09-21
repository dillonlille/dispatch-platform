import { z } from 'zod';
import type { PaycomPreferences, PaycomSettings } from './paycom.js';

const text = z.string();
const count = z.number().int().nonnegative();
const preferences = z.object({
  opening_page: z.enum(['timecards', 'meal-breaks', 'employees']),
  rows_per_page: z.union([z.literal(25), z.literal(50), z.literal(100)]),
  name_order: z.enum(['first_last', 'last_first']),
  default_sort: z.enum(['employeeName', 'condition', 'inDay']),
  department: text.nullable(),
  station: text.nullable(),
  columns: z.array(z.enum(['inDay', 'outLunch', 'inLunch', 'outDay', 'totalHours', 'condition'])),
  driver_departments: z.array(text).nullable(),
  late_da_time: text.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  late_da_departments: z.array(text),
}) satisfies z.ZodType<PaycomPreferences>;

export const paycomSettingsSchema = z.object({
  revision: count,
  values: preferences,
  history: z.array(z.object({ revision: count, at: text, values: preferences })),
  options: z.object({
    departments: z.array(z.object({ value: text, count })),
    stations: z.array(text),
  }),
}) satisfies z.ZodType<PaycomSettings>;
