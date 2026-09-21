import type { Environment } from './generated/Environment';
export type { MailMessage } from './generated/MailMessage';
export interface PlatformHealth {
  environment: Environment;
  release: string;
  jobs: Record<string, number>;
  browsers: {
    active: number;
    capacity: number;
    memory: { availableBytes: number | null; requiredBytes: number; canStart: boolean };
  };
  dsps: number;
  email: boolean;
  mail: {
    enabled: boolean;
    pending: number;
    failed: number;
    oldestPendingAgeMs: number | null;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    transport: { error: string | null; checkedAt: string | null };
  };
  providerMode: 'fixture' | 'native';
}
