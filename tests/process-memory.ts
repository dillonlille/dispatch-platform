import fs from 'node:fs/promises';

// Host-only test diagnostics. Read numeric totals, never process arguments.
export async function processMemory(root: number) {
  const processes = await Promise.all(
    (await fs.readdir('/proc'))
      .filter((s) => /^\d+$/.test(s))
      .map(async (id) => {
        try {
          const status = await fs.readFile(`/proc/${id}/status`, 'utf8');
          return {
            id: Number(id),
            parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
            rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
          };
        } catch {
          return null;
        }
      }),
  );
  const ids = new Set([root]);
  for (;;) {
    const before = ids.size;
    for (const p of processes) if (p && ids.has(p.parent)) ids.add(p.id);
    if (ids.size === before) break;
  }
  let rss = 0,
    pss = 0,
    privateBytes = 0,
    incomplete = 0;
  await Promise.all(
    processes
      .filter((p) => p && ids.has(p.id))
      .map(async (p) => {
        if (!p) return;
        rss += p.rss;
        try {
          const text = await fs.readFile(`/proc/${p.id}/smaps_rollup`, 'utf8');
          const field = (name: string) =>
            Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
          pss += field('Pss');
          privateBytes +=
            field('Private_Clean') + field('Private_Dirty') + field('Private_Hugetlb');
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
            incomplete++;
        }
      }),
  );
  return { rss, pss, privateBytes, incomplete };
}
