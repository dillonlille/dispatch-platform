import type { Credentials } from '../auth-broker/vault.js';
import type { Workforce } from '../../shared/contracts/index.js';
export type BrowserCommand =
  | { action: 'start'; credentials: Credentials; timezone: string; fixtureUrl?: string }
  | { action: 'verify'; code: string }
  | {
      action: 'assist';
      input:
        | { kind: 'click'; x: number; y: number }
        | { kind: 'type'; text: string }
        | { kind: 'key'; key: string };
    }
  | { action: 'screenshot' }
  | { action: 'collect' }
  | { action: 'close' };
export type BrowserEvent =
  | { type: 'ready' }
  | { type: 'challenge'; message: string }
  | { type: 'error'; code: string }
  | { type: 'screenshot'; image: string }
  | { type: 'collection_access'; path: string }
  | { type: 'collected'; workforce: Workforce }
  | { type: 'progress'; progress: number; message: string };
