import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Offline fixtures and benchmark tools support the same staged rollout as Rust.
// Never infer completion from the existence of a provider file.
export function collectorDatabase(root: string, dspId: string, provider: 'paycom'): string {
  assert(/^dsp_[a-f0-9]{32}$/.test(dspId), 'Invalid DSP ID');
  assert(provider === 'paycom', 'Unsupported collector');
  const core = path.join(root, 'dsps', dspId, 'data/dispatch.sqlite');
  const db = new DatabaseSync(core, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='storage.collectors'").get() as
      { value: string } | undefined;
    assert(!row || row.value === '1', 'Unsupported storage layout');
    return row ? path.join(root, 'dsps', dspId, 'data', provider, `${provider}.sqlite`) : core;
  } finally {
    db.close();
  }
}
