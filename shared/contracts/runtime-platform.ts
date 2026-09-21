import { z } from 'zod';
import type { PlatformHealth } from './platform.js';

const text = z.string();
const count = z.number().int().nonnegative();
export const platformHealthSchema = z.object({
  environment: z.enum(['preview', 'production']),
  release: text,
  jobs: z.partialRecord(
    z.enum(['queued', 'running', 'waiting_verification', 'succeeded', 'failed', 'cancelled']),
    count,
  ),
  browsers: z.object({
    active: count,
    capacity: count,
    memory: z.object({
      availableBytes: count.nullable(),
      requiredBytes: count,
      canStart: z.boolean(),
    }),
  }),
  dsps: count,
  email: z.boolean(),
  mail: z.object({
    enabled: z.boolean(),
    pending: count,
    failed: count,
    oldestPendingAgeMs: count.nullable(),
    lastSuccessAt: text.nullable(),
    lastAttemptAt: text.nullable(),
    lastError: text.nullable(),
    transport: z.object({ error: text.nullable(), checkedAt: text.nullable() }),
  }),
  providerMode: z.enum(['fixture', 'native']),
}) satisfies z.ZodType<PlatformHealth>;
