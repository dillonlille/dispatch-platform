import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../shared/crypto.js';
import { assert } from '../../shared/errors.js';
export const managed = [
  'dashboard',
  'api',
  'services',
  'integrations',
  'shared',
  'tooling',
  'node_modules',
  'package.json',
  'package-lock.json',
  'release.json',
] as const;
const fileSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal(1),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
    nodeMajor: z.literal(22),
    schema: z.union([z.literal(1), z.literal(2)]),
    files: z.array(fileSchema).min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Artifact = z.infer<typeof manifestSchema>;
export function inventory(root: string): Artifact['files'] {
  const files: Artifact['files'] = [];
  function visit(directory: string) {
    for (const item of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, item.name),
        relative = path.relative(root, filename).split(path.sep).join('/');
      if (relative === 'release.json') continue;
      const info = fs.lstatSync(filename);
      assert(
        !info.isSymbolicLink() && (info.isDirectory() || info.isFile()),
        'artifact_special_file',
      );
      if (info.isDirectory()) visit(filename);
      else {
        assert(info.nlink === 1, 'artifact_hardlink');
        const bytes = fs.readFileSync(filename);
        files.push({ path: relative, sha256: sha256(bytes), size: bytes.length });
      }
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function writeManifest(root: string, version: string): Artifact {
  const value = {
    format: 1 as const,
    version,
    nodeMajor: 22 as const,
    schema: 2 as const,
    files: inventory(root),
  };
  const manifest = { ...value, digest: sha256(JSON.stringify(value)) };
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function verifyArtifact(root: string): Artifact {
  assert(fs.realpathSync(root) === path.resolve(root), 'artifact_symlink');
  const manifest = manifestSchema.parse(
    JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8')),
  );
  const { digest, ...payload } = manifest;
  assert(sha256(JSON.stringify(payload)) === digest, 'artifact_manifest_changed');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    assert(
      !path.isAbsolute(file.path) &&
        file.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
        managed.includes(file.path.split('/')[0] as (typeof managed)[number]),
      'artifact_path_denied',
    );
    assert(!seen.has(file.path), 'artifact_duplicate_file');
    seen.add(file.path);
  }
  assert(
    JSON.stringify(inventory(root)) === JSON.stringify(manifest.files),
    'artifact_inventory_changed',
  );
  assert(
    seen.has('api/main.js') && seen.has('dashboard/index.html') && seen.has('package.json'),
    'artifact_incomplete',
  );
  return manifest;
}
