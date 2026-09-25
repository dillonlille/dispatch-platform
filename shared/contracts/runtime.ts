import { paycomSettingsSchema } from './runtime-settings.js';
import { auditPageSchema } from './runtime-audit.js';
import {
  uniformInventorySchema,
  uniformAdjustmentSchema,
  uniformUpdatesSchema,
  uniformHistorySchema,
} from './runtime-uniforms.js';
import { platformHealthSchema } from './runtime-platform.js';
import {
  dailyTimecardsSchema,
  employeesSchema,
  employeeTimecardSchema,
  mealComparisonSchema,
} from './runtime-workforce.js';
import { z } from 'zod';
import type { Dsp } from './generated/Dsp';
import {
  features,
  permissions,
  type DspView,
  type CollectionUpdates,
  type DspProfile,
  type DspSummary,
  type Job,
  type JobMetrics,
  type SessionView,
  type User,
} from './index.js';

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
const userSchema = z.object({
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
}) satisfies z.ZodType<Dsp>;
const profile = z.object({
  abbreviation: text,
  stationCode: text,
  setupRequired: z.boolean(),
  removed: z.boolean(),
  supportVisible: z.boolean(),
}) satisfies z.ZodType<DspProfile>;
const permission = z.enum(permissions);
const feature = z.enum(features);
const dspSummary = dsp
  .extend({
    profile,
    ownerEmail: text.nullable(),
    ownerStatus: z.enum(['active', 'invited', 'missing']),
    paycom: connectionStatus,
    lastCollection: text.nullable(),
    role: text.nullable(),
    features: z.array(feature),
  })
  .passthrough() satisfies z.ZodType<DspSummary>;
export const sessionSchema = z.object({
  user: userSchema,
  csrf: text.min(1),
  dsps: z.array(dspSummary),
  development: z.boolean(),
  environment,
  release: text,
  providerMode: z.enum(['fixture', 'native']),
  source: z.object({ version: text.nullable(), commit: text.nullable() }),
}) satisfies z.ZodType<SessionView>;
const viewRole = z.object({ id: text, name: text, owner: z.boolean() });
const viewSchema = z.object({
  dsp,
  token: text.min(1),
  role: viewRole,
  roles: z.array(viewRole).optional(),
  permissions: z.array(permission),
  features: z.array(feature),
  profile,
}) satisfies z.ZodType<DspView>;
const pageRead = z.object({
  ordinal: count,
  attempt: count,
  stage: z.enum(['navigation', 'content', 'extraction']),
  elapsedMs: milliseconds,
  navigationMs: milliseconds,
  contentMs: milliseconds,
  extractionMs: milliseconds,
  error: text.nullable(),
  pendingRequests: count.nullable().default(null),
  documentState: z.enum(['loading', 'interactive', 'complete']).nullable().default(null),
});
const metricsSchema = z.object({
  attempt: count,
  startedAt: text,
  finishedAt: text.nullable(),
  outcome: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  error: text.nullable(),
  phase: z
    .enum(['starting', 'authentication', 'verification', 'collection', 'publication'])
    .nullable(),
  detail: text.nullable().default(null),
  queueMs: milliseconds,
  elapsedMs: milliseconds,
  authenticationMs: milliseconds.nullable(),
  verificationMs: milliseconds.nullable(),
  collectionMs: milliseconds.nullable(),
  publicationMs: milliseconds.nullable(),
  employees: count.nullable(),
  timecards: count.nullable(),
  itineraries: count.nullable().default(null),
  meals: count.nullable().default(null),
  rows: count.nullable().default(null),
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
      resumed: count.default(0),
      earlyReady: count.default(0),
      direct: count.default(0),
      spotChecked: count.default(0),
      totalMs: milliseconds,
      active: z.array(pageRead),
      slowest: z.array(pageRead),
      failures: z.array(pageRead),
    })
    .optional(),
}) satisfies z.ZodType<JobMetrics>;
const jobStatusSchema = z.enum([
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
  kind: z.enum(['paycom.collect', 'cortex.meal_breaks.collect', 'cortex.scorecard.collect']),
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

const collectionUpdatesSchema = z.object({
  revision: text,
  changes: z.array(
    z.object({
      provider: text,
      dates: z.array(text),
      employeeCode: text.nullable(),
      roster: z.boolean(),
    }),
  ),
}) satisfies z.ZodType<CollectionUpdates>;
const okSchema = z.object({ ok: z.literal(true) });
const jobsSchema = z.array(jobSchema);
export function parseApiResponse(path: string, method: 'GET' | 'POST', value: unknown): unknown {
  const route = path.split('?')[0];
  let schema: z.ZodType | undefined;
  if (method === 'GET') {
    if (route === '/api/session') schema = sessionSchema;
    else if (route === '/api/dsp/collection-updates') schema = collectionUpdatesSchema;
    else if (route === '/api/dsp/uniforms') schema = uniformInventorySchema;
    else if (route === '/api/dsp/uniforms/updates') schema = uniformUpdatesSchema;
    else if (route === '/api/dsp/uniforms/history') schema = uniformHistorySchema;
    else if (route === '/api/platform/dsps') schema = z.array(dspSummary);
    else if (route === '/api/dsp/paycom/settings') schema = paycomSettingsSchema;
    else if (route === '/api/platform/audit') schema = auditPageSchema;
    else if (route === '/api/platform/health') schema = platformHealthSchema;
    else if (route === '/api/dsp/employees') schema = employeesSchema;
    else if (route && /^\/api\/dsp\/employees\/[^/]+$/.test(route)) schema = employeeTimecardSchema;
    else if (route === '/api/dsp/timecards') schema = dailyTimecardsSchema;
    else if (route === '/api/dsp/paycom/meal-breaks') schema = mealComparisonSchema;
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
    else if (route?.startsWith('/api/dsp/uniforms/stock/')) schema = uniformAdjustmentSchema;
    else if (route === '/api/dsp/uniforms' || route?.startsWith('/api/dsp/uniforms/'))
      schema = uniformInventorySchema;
    else if (route === '/api/dsp/paycom/settings') schema = paycomSettingsSchema;
    else if (route === '/api/platform/audit/export') schema = auditPageSchema;
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
