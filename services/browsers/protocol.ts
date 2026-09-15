import type { BrowserInput } from '../../shared/browser.js';
export interface Credentials {
  clientCode: string;
  username: string;
  password: string;
  securityAnswers?: string[];
}
import type { Workforce } from '../../shared/contracts/index.js';
export type BrowserCommand =
  | {
      action: 'start';
      credentials: Credentials;
      timezone: string;
      fixtureUrl?: string;
      ownerRetry?: boolean;
    }
  | { action: 'complete_assistance' }
  | { action: 'check'; credentials: Credentials }
  | { action: 'verify'; code: string }
  | { action: 'assist'; input: BrowserInput }
  | { action: 'screenshot' }
  | { action: 'collect' }
  | { action: 'close' };
export type BrowserEvent =
  | { type: 'ready' }
  | { type: 'challenge'; message: string }
  | { type: 'assisted' }
  | { type: 'error'; code: string }
  | { type: 'screenshot'; image: string }
  | { type: 'collection_access'; path: string }
  | { type: 'collected'; workforce: Workforce }
  | { type: 'progress'; progress: number; message: string };
