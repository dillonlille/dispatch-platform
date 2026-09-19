import { z } from 'zod';
import { permissions, type Job, type JobMetrics, type SessionView, type User } from './index.js';

const text = z.string();
const count = z.number().int().nonnegative();
const milliseconds = z.number().nonnegative();
const environment = z.enum(['preview', 'production']);
const connectionStatus = z.enum([
  'not_connected',
  'ready',
  'signing_in',
  'needs_verification',
  'error',
]);
export const userSchema = z.object({
  id: text.min(1),
  email: text.min(1),
  firstName: text,
  lastName: text,
  platformOwner: z.boolean(),
}) satisfies z.ZodType<User>;
const dsp = z.object({
  id: text.min(1),
  name: text,
  environment,
  status: z.enum(['provisioning', 'active', 'suspended', 'failed']),
  timezone: text,
  permanent: z.boolean(),
  revision: count,
  createdAt: text,
});
const profile = z.object({
  abbreviation: text,
  stationCode: text,
  setupRequired: z.boolean(),
  removed: z.boolean(),
});
const permission = z.enum(permissions);
export const sessionSchema = z.object({
  user: userSchema,
  csrf: text.min(1),
  dsps: z.array(
    dsp.extend({
      profile,
      ownerEmail: text.nullable(),
      ownerStatus: z.enum(['active', 'invited', 'missing']),
      paycom: connectionStatus,
      lastCollection: text.nullable(),
      role: text.nullable(),
    }),
  ),
  development: z.boolean(),
  environment,
  release: text,
  providerMode: z.enum(['fixture', 'native']),
}) satisfies z.ZodType<SessionView>;
const viewSchema = z.object({
  dsp,
  token: text.min(1),
  role: z.object({ id: text, name: text, owner: z.boolean() }),
  permissions: z.array(permission),
  profile,
});
const pageRead = z.object({
  ordinal: count,
  attempt: count,
  stage: z.enum(['navigation', 'content', 'extraction']),
  elapsedMs: milliseconds,
  navigationMs: milliseconds,
  contentMs: milliseconds,
  extractionMs: milliseconds,
  error: text.nullable(),
  pendingRequests: count.nullable().optional(),
  documentState: z.enum(['loading', 'interactive', 'complete']).nullable().optional(),
});
export const metricsSchema = z.object({
  attempt: count,
  startedAt: text,
  finishedAt: text.nullable(),
  outcome: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  error: text.nullable(),
  phase: z
    .enum(['starting', 'authentication', 'verification', 'collection', 'publication'])
    .nullable(),
  detail: text.nullable().optional(),
  queueMs: milliseconds,
  elapsedMs: milliseconds,
  authenticationMs: milliseconds.nullable(),
  verificationMs: milliseconds.nullable(),
  collectionMs: milliseconds.nullable(),
  publicationMs: milliseconds.nullable(),
  employees: count.nullable(),
  timecards: count.nullable(),
  itineraries: count.nullable().optional(),
  meals: count.nullable().optional(),
  peakRssBytes: count.nullable(),
  peakPssBytes: count.nullable(),
  peakPrivateBytes: count.nullable(),
  memorySamples: count,
  incompleteMemorySamples: count,
  pageReads: z
    .object({
      completed: count,
      retries: count,
      recovered: count,
      resumed: count.optional(),
      earlyReady: count.optional(),
      direct: count.optional(),
      totalMs: milliseconds,
      active: z.array(pageRead),
      slowest: z.array(pageRead),
      failures: z.array(pageRead),
    })
    .optional(),
}) satisfies z.ZodType<JobMetrics>;
export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_verification',
  'succeeded',
  'failed',
  'cancelled',
]);
export const jobSchema = z.object({
  id: text.min(1),
  dspId: text.min(1),
  dspName: text,
  environment,
  kind: z.enum(['paycom.collect', 'cortex.meal_breaks.collect']),
  status: jobStatusSchema,
  progress: count.max(100),
  message: text,
  attempt: count,
  maxAttempts: count,
  availableAt: text,
  createdAt: text,
  startedAt: text.nullable(),
  completedAt: text.nullable(),
  error: text.nullable(),
  release: text,
  actorId: text.nullable(),
  metrics: z.array(metricsSchema),
}) satisfies z.ZodType<Job>;

const okSchema = z.object({ ok: z.literal(true) });
const jobsSchema = z.array(jobSchema);
export function parseApiResponse(path: string, method: 'GET' | 'POST', value: unknown): unknown {
  const route = path.split('?')[0];
  let schema: z.ZodType | undefined;
  if (method === 'GET') {
    if (route === '/api/session') schema = sessionSchema;
    else if (route === '/api/platform/jobs' || route === '/api/dsp/jobs') schema = jobsSchema;
  } else {
    if (
      route &&
      [
        '/api/auth/login',
        '/api/auth/logout',
        '/api/auth/password',
        '/api/auth/reset-password',
        '/api/auth/forgot-password',
      ].includes(route)
    )
      schema = okSchema;
    else if (route === '/api/session/dsp') schema = viewSchema;
    else if (route === '/api/dsp/jobs' || route === '/api/dsp/cortex/meal-breaks/collect')
      schema = jobSchema;
    else if (route === '/api/dsp/jobs/meal-breaks')
      schema = z.object({ date: text, jobs: jobsSchema });
  }
  if (!schema) return value;
  const result = schema.safeParse(value);
  // Never expose a server payload, session token or employee data in an error.
  if (!result.success) throw new Error('invalid_api_response');
  return result.data;
}
