import type { PlatformHealth } from '../../../../../shared/contracts/index.js';
import { bytes } from '../../../lib/format.js';
import type { CollectionSource } from './collection-history.js';
import type { Diagnostics } from './types.js';

/** One line of Overview's "Needs attention". Add a check by adding an entry to `issues`. */
export interface Issue {
  id: string;
  title: string;
  details: string[];
  tone: 'warning' | 'failed';
  /** Where the issue is looked into, when another tab shows more. */
  open?: { tab: 'collections'; source: string; run?: string } | { tab: 'email' };
}

// Below this much free disk a collection's publication can fail.
const lowStorageBytes = 1024 ** 3;

export function issues(
  health: PlatformHealth,
  diagnostics: Diagnostics,
  sources: CollectionSource[],
): Issue[] {
  const { memory } = health.browsers;
  const found: Issue[] = [];
  if (!memory.canStart)
    found.push({
      id: 'browser-memory',
      title: 'Browsers',
      tone: 'warning',
      details: [
        `New browsers are waiting for memory: ${
          memory.availableBytes === null
            ? 'available memory unknown'
            : `${bytes(memory.availableBytes, 'MiB')} free`
        }, ${bytes(memory.requiredBytes, 'MiB')} needed`,
      ],
    });
  if (diagnostics.storageAvailableBytes < lowStorageBytes)
    found.push({
      id: 'storage',
      title: 'Storage',
      tone: 'warning',
      details: [`Only ${bytes(diagnostics.storageAvailableBytes, 'MiB')} of storage is available`],
    });
  for (const source of sources)
    if (source.warnings.length)
      found.push({
        id: source.key,
        title: source.label,
        tone: source.newest.status === 'failed' ? 'failed' : 'warning',
        details: source.warnings,
        open: { tab: 'collections', source: source.key, run: source.runs[0]?.job.id },
      });
  if (health.mail.failed > 0)
    found.push({
      id: 'email',
      title: 'Email',
      tone: 'failed',
      details: [
        `${health.mail.failed} failed ${health.mail.failed === 1 ? 'delivery' : 'deliveries'}`,
      ],
      open: { tab: 'email' },
    });
  return found;
}
