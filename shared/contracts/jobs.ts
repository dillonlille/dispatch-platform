import type { Narrow } from './narrow.js';
import type { PublicJob } from './generated/PublicJob';
interface PageRead {
  ordinal: number;
  attempt: number;
  stage: 'navigation' | 'content' | 'extraction';
  elapsedMs: number;
  navigationMs: number;
  contentMs: number;
  extractionMs: number;
  error: string | null;
  pendingRequests?: number | null;
  documentState?: 'loading' | 'interactive' | 'complete' | null;
}
export interface JobMetrics {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error: string | null;
  phase: 'starting' | 'authentication' | 'verification' | 'collection' | 'publication' | null;
  detail?: string | null;
  queueMs: number;
  elapsedMs: number;
  authenticationMs: number | null;
  verificationMs: number | null;
  collectionMs: number | null;
  publicationMs: number | null;
  employees: number | null;
  timecards: number | null;
  itineraries?: number | null;
  meals?: number | null;
  peakRssBytes: number | null;
  peakPssBytes: number | null;
  peakPrivateBytes: number | null;
  memorySamples: number;
  incompleteMemorySamples: number;
  pageReads?: {
    completed: number;
    retries: number;
    recovered: number;
    resumed?: number;
    earlyReady?: number;
    direct?: number;
    spotChecked?: number;
    totalMs: number;
    active: PageRead[];
    slowest: PageRead[];
    failures: PageRead[];
  };
}
export type Job = Narrow<PublicJob, { metrics: JobMetrics[] }>;
