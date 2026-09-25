import type { RuntimeSource } from '../../../shared/contracts/index.js';

const repository = 'https://github.com/dispatch-systems/dispatch-platform';

/** Where the running build's source lives: its release on Production, its commit elsewhere. */
export function sourceLink({ version, commit }: RuntimeSource): { href: string; label?: string } {
  if (version) return { href: `${repository}/tree/v${version}`, label: `v${version}` };
  if (commit) return { href: `${repository}/tree/${commit}`, label: commit.slice(0, 7) };
  return { href: repository };
}
