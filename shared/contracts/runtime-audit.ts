import { z } from 'zod';
import type { AuditPage } from './audit.js';

const text = z.string();
const count = z.number().int().nonnegative();
const area = z.enum([
  'team',
  'roles',
  'collections',
  'schedules',
  'connections',
  'access',
  'dsps',
  'settings',
]);
const named = z.object({ id: text, name: text });
export const auditPageSchema = z.object({
  events: z.array(
    z.object({
      id: count,
      at: text,
      actorId: text.nullable(),
      actorName: text,
      dspId: text.nullable(),
      dspName: text.nullable(),
      action: text,
      detail: text,
      area,
      target: text.nullable(),
      ref: z.object({ kind: z.enum(['member', 'role', 'schedule', 'job']), id: text }).nullable(),
      changes: z.array(z.object({ field: text, from: text.nullable(), to: text.nullable() })),
    }),
  ),
  total: count,
  counts: z.partialRecord(z.union([area, z.literal('failures')]), count),
  actors: z.array(named),
  dsps: z.array(named),
}) satisfies z.ZodType<AuditPage>;
