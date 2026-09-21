import { z } from 'zod';
import type {
  Employee,
  EmployeeTimecardResponse,
  EmployeesResponse,
  DailyTimecards,
  Punch,
  PaycomDay,
} from './workforce.js';
import type { MealComparison, MealEmployee, MealAssessment } from './meals.js';

const text = z.string();
const count = z.number().int().nonnegative();
const optionalText = text.nullable().optional();
export const employeeSchema = z.object({
  code: text,
  name: text,
  department: text,
  position: text,
  station: text,
  active: z.boolean(),
}) satisfies z.ZodType<Employee>;
const punchSchema = z.object({
  inKind: z.enum(['IN DAY', 'IN LUNCH']).nullable().optional(),
  outKind: z.enum(['OUT LUNCH', 'OUT DAY']).nullable().optional(),
  in: text.nullable(),
  out: text.nullable(),
  hours: z.number().nullable(),
}) satisfies z.ZodType<Punch>;
const clock = z.object({ minute: z.number().int(), day: z.number().int() });
const lunch = z.object({ out: clock.nullable(), in: clock.nullable() });
const day = z.object({
  inDay: clock.nullable(),
  outDay: clock.nullable(),
  lunches: z.array(lunch),
  events: z.array(z.object({ kind: text, time: clock.nullable(), raw: text })),
  review: z.boolean(),
  legacy: z.boolean(),
}) satisfies z.ZodType<PaycomDay>;
const card = z.object({
  employeeCode: text,
  date: text,
  hours: z.number(),
  status: text,
  punches: z.array(punchSchema),
  sourceUrl: optionalText,
});
const period = z.object({ from: text, to: text });
export const employeeTimecardSchema = z.object({
  employee: employeeSchema,
  timecards: z.array(card.extend({ assessment: day })),
  period,
  previousPeriod: period.nullable(),
  nextPeriod: period.nullable(),
  collectedAt: text.nullable(),
  syncStatus: z
    .enum(['queued', 'running', 'waiting_verification', 'succeeded', 'failed', 'cancelled'])
    .nullable(),
}) satisfies z.ZodType<EmployeeTimecardResponse>;
export const employeesSchema = z.object({
  employees: z.array(employeeSchema),
  total: count,
  collectedAt: text.nullable(),
}) satisfies z.ZodType<EmployeesResponse>;
export const dailyTimecardsSchema = z.object({
  rows: z.array(card.extend({ name: text })),
  collectedAt: text.nullable(),
  available: z.boolean(),
}) satisfies z.ZodType<DailyTimecards>;
const cortexMeal = z.object({
  mealId: text,
  itineraryId: text,
  cortexId: text,
  driverName: text,
  station: text,
  timezone: text,
  collectedAt: text,
  lastDelivery: text.nullable(),
  start: text,
  end: text.nullable(),
  firstDelivery: text.nullable(),
  beforeStatus: text,
  afterStatus: text,
  sourceUrl: optionalText,
});
const gap = z.object({ milliseconds: count, overLimit: z.boolean() });
const assessment = z.object({
  paycom: day,
  pairs: z
    .array(
      z.object({
        cortexIndex: count.nullable(),
        lunchIndex: count.nullable(),
        out: clock.nullable(),
        into: clock.nullable(),
        outDifference: z.number().int().nullable(),
        inDifference: z.number().int().nullable(),
        gaps: z.object({ before: gap.nullable(), after: gap.nullable() }),
      }),
    )
    .min(1),
  different: z.boolean(),
  missing: z.boolean(),
  status: z.enum([
    'flex_only',
    'no_flex_meal',
    'review_punches',
    'missing_lunch',
    'review_pairing',
    'missing_data',
    'different',
    'same',
  ]),
  longGap: z.boolean(),
  lateIn: z.boolean(),
}) satisfies z.ZodType<MealAssessment>;
const mealEmployee = z
  .object({
    id: text,
    name: text,
    paycom: z
      .object({
        employeeCode: text,
        name: text,
        department: optionalText,
        station: optionalText,
        date: optionalText,
        hours: z.number().nullable().optional(),
        status: text,
        punches: z.array(punchSchema),
        sourceUrl: optionalText,
      })
      .nullable(),
    cortex: z.array(cortexMeal),
    assessment,
  })
  .superRefine((row, context) => {
    for (const pair of row.assessment.pairs) {
      if (
        (pair.cortexIndex !== null && pair.cortexIndex >= row.cortex.length) ||
        (pair.lunchIndex !== null && pair.lunchIndex >= row.assessment.paycom.lunches.length)
      )
        context.addIssue({ code: 'custom', message: 'Invalid assessment reference' });
    }
  }) satisfies z.ZodType<MealEmployee>;
export const mealComparisonSchema = z.object({
  date: text,
  timezone: text,
  rows: z.array(mealEmployee),
  paycomCollectedAt: text.nullable(),
  cortexPublications: z.array(
    z.object({
      station: text,
      timezone: text,
      collectedAt: text,
      id: optionalText,
      serviceAreaId: optionalText,
      provider: optionalText,
    }),
  ),
  employees: z.array(z.object({ code: text, name: text })),
  drivers: z.array(
    z.object({
      id: text,
      name: text,
      paycomCode: text.nullable(),
      matchType: z.enum(['name', 'saved', 'separate', 'unmatched']),
    }),
  ),
  links: z.object({
    revision: count,
    links: z.array(z.object({ id: text, cortexId: text, paycomCode: text })),
    separate: z.array(text).optional(),
  }),
}) satisfies z.ZodType<MealComparison>;
