import { z } from 'zod';
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
  });
const text = z.string().max(200);
export const workforceSchema = z
  .object({
    employees: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
            name: text.min(1),
            department: text,
            position: text,
            station: text,
            active: z.boolean(),
          })
          .strict(),
      )
      .max(5000),
    timecards: z
      .array(
        z
          .object({
            employeeCode: z.string(),
            date: dateSchema,
            hours: z.number().min(0).max(48),
            status: text,
            punches: z
              .array(
                z
                  .object({
                    in: z.string().max(64).nullable(),
                    out: z.string().max(64).nullable(),
                    hours: z.number().min(0).max(48).nullable(),
                  })
                  .strict(),
              )
              .max(64),
          })
          .strict(),
      )
      .max(160000),
    collectedAt: z.iso.datetime(),
    from: dateSchema,
    to: dateSchema,
  })
  .strict();
export function dateInTimezone(timezone: string, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
